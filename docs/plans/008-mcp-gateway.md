# 008 — MCP as a generic gateway over an agent API (status: in progress)

## The problem being solved

Every new agent capability today is paid for twice, sometimes three times:
an API endpoint (when one is needed), a hand-written MCP tool in
`apps/mcp/src/index.ts` (Zod schema + description prose + handler), and a row
in `docs/mcp-tools.md`. The MCP worker is 807 lines for 26 tools, and roughly
10 of those tools are pure proxies over REST endpoints that already exist —
boilerplate whose only job is to re-state a schema and forward a call.

The proposal: the **API worker becomes the single implementation surface** —
every editing/creation/asset/render capability is an endpoint there, usable
by the web editor as much as by the agent — and the MCP worker shrinks to a
small, *stable* gateway of three meta-tools:

1. `instructions` — orientation + the capability list; read once per thread
2. `describe` — full schema/doc for named capabilities, on demand
3. `execute` — run one capability by name with a JSON args object

After this, adding a capability = one catalog entry in the API worker.
The MCP worker never changes again.

## Why this fits where the project already is

- **One boundary.** The architecture doc already argues for doing work where
  credits/R2/DO live (that's why TTS runs in the API worker). Moving intent
  compilation there completes that: today `animate`/`morph_latex`/`highlight`
  logic lives in the MCP worker and does 3 cross-worker calls per write
  (get doc → post ops → get doc). Server-side it's one call, and the
  rebase-on-409 loop moves next to the DO.
- **The editor gets the same verbs.** A "fit scene to narration" button or an
  "animate this property" panel wants exactly the intent endpoints the agent
  wants. Today that sugar is locked inside the MCP worker where the editor
  can't reach it.
- **Tool changes take effect live, mid-session.** MCP clients fetch
  `tools/list` at connect time and cache it; `listChanged` notifications are
  unevenly supported, so today a tool edit means redeploying the MCP worker
  *and* reconnecting/restarting the thread before the client sees it. Under
  the gateway the tool list never changes — the three meta-tools are the
  contract — and the catalog is read from the API worker at call time, so a
  changed schema, doc, or behavior is served by the very next
  `instructions`/`describe`/`execute` call in the *same* thread. Dev loop on
  a tool becomes: edit catalog entry, save, call again. One caveat: an agent
  mid-thread may hold a stale `describe` in context; stamp responses with a
  catalog revision and have validation errors say when the schema moved.
- **Phase 3 & 5 get cheaper.** `preview_frames` becomes a catalog entry, not
  a new tool. OAuth (the launch phase) wires through 3 stable tools instead of 26.
- **Purity is preserved.** The intent logic imports only `@euclid/dsl` and
  the pure `@euclid/engine` sampler (`resolveNode`) — no Pixi — so it moves
  into the API worker without touching the workers-must-not-import-Pixi rule.

## Feasibility findings (what survives the move, what doesn't)

**Moves cleanly** (all logic is pure or already API-shaped):
`get_project`/`outlineDoc`, `get_scene`, `add_scene`, `update_scene`,
`add_latex`/`add_text`/`add_shape` (defaults), `update_node` (incl. the
shadowed-property warning), `remove_node`, `animate` (keyframe compilation via
`resolveNode`), `morph_latex`/`highlight` (overlap-replace), `write_on`,
`fit_scene_to_narration`, `set_narration`, `record_answer`, and every
already-thin proxy (`list_projects`, `create_project`, `generate_narration`,
`render_video`, `get_render_status`, `get_captions`, `list_assets`,
`move_asset`, `remove_asset`).

**Cannot move: `ask_user`.** Elicitation is an MCP *protocol* capability —
the server asks the client to open a picker. A REST endpoint can store the
question, but only the MCP layer can elicit, and the STOP-block fallback is
about controlling the agent's next reply. `ask_user` stays a native tool in
the gateway. (`record_answer` can still ride `execute`.)

**Regression to design around: per-tool permission UX.** MCP clients grant
permissions per tool. With one `execute`, "always allow execute" would
silently cover `render_video` and `generate_narration` — the two calls that
spend money. Mitigation: split the executor into `execute` (free ops) and
`execute_paid` (credit-spending ops, catalog-flagged), so a human's standing
approval can never extend to a spend. That makes the surface four tools plus
`ask_user` — still stable, still generic.

**Risk to verify, not assume away: agent compliance.** Nothing forces a
client to call `instructions` at thread start. Mitigations: the three tool
descriptions carry the bootstrap instruction; `instructions` returns the
compact one-liner table (most ops are then executable without a `describe`
round trip); `execute` on an unknown/misused op returns an error that names
`instructions`/`describe` instead of a bare failure. Validation stays Zod,
just server-side — error text must stay as instructive as the current
schemas, because it is now the only teacher. The honest test is re-running
the 60s milestone through the gateway and comparing friction.

**Out of scope for `execute`: binary upload.** Tool args are JSON; base64
audio/video through an LLM context is a non-starter. Asset byte upload stays
a plain REST endpoint (its producers are server-side today anyway; general-video
ingest passes URLs, not bytes).

**Escape hatch that de-risks everything:** the catalog (name, summary, doc,
schema, handler, flags) is valuable independent of presentation. If generic
`execute` measures worse for agent reliability, a ~40-line loop can register
every catalog entry as a real per-tool MCP tool instead — same single source
of truth, zero per-tool code either way. Build the catalog first; the MCP
last mile is swappable.

## Phases

## Phase 1: Capability catalog in the API worker (status: done)
- [x] Catalog module: entries of `{ name, summary, doc, args (Zod),
      costsCredits, handler }` — `apps/api/src/agent/catalog.ts`, 25 entries
- [x] Move intent compilation out of `apps/mcp` (animate, morph, highlight,
      write_on, fit, add_* defaults, update_node warning, outline)
- [x] Server-side submit with rebase ×3 next to the DO path (`src/shared.ts`)
- [x] Handlers return structured data + agent-text formatter (editor gets
      JSON via `?format=json`, agent gets compact text — same handler)
- [x] Extract the heavyweight service logic so routes and catalog share one
      implementation: `services/{assets,narration,render}.ts`. The existing
      REST routes are now thin wrappers over the same functions.

## Phase 2: Gateway endpoints (status: done)
Built alongside Phase 1 rather than after it: a catalog with no HTTP surface
cannot be verified by running it, and the endpoints are thin derivations of
the catalog (~90 lines total).
- [x] `GET  /api/agent/tools` — instructions + one-liner capability table
- [x] `POST /api/agent/tools/describe` — full doc/schema for named ops (batch)
- [x] `POST /api/agent/tools/:name/execute` — validate (Zod) → handler →
      compact text; instructive errors that point back at describe
- [x] `?paid=1` is the separate credit-spending executor; a paid capability
      refuses the free path and vice versa
- [x] Internal-key auth as today; user identity via `x-user-id` unchanged

## Phase 3: Gateway MCP worker (status: done)
- [x] Rewrite `apps/mcp` to: `instructions`, `describe`, `execute`,
      `execute_paid`, native `ask_user` — 807 lines → 295
- [x] Unknown-op and validation errors surface verbatim (`relay` throws the
      gateway's body untouched; it is already written for the agent)
- [x] Delete the 26 hand-written tools; drop the `@euclid/engine` dependency
      the worker no longer needs
- [x] `ask_user` keeps elicitation and the STOP-block fallback; its closing
      instruction now names `execute(name="record_answer")`

## Phase 4: Verify and document (status: done)
- [x] `check-gateway.ts`: instructions → describe → execute round trip
      against a scratch project, plus the credit gate, both `update_node`
      traps, arg coercion, and first-answer-wins on `record_answer`
- [x] Re-run the 60s milestone over the gateway (this is the feasibility
      gate — compare tool-call count and failure loops against the old run).
      Run 4, 2026-08-16 — verdict below: the indirection is close to free,
      and one silent-drop bug was found.
- [x] `check-mcp-tools.ts` rewritten for the gateway: asserts the tool list is
      **exactly** the five (a capability leaking back in as its own tool would
      reinstate the restart problem), and keeps the JSON-RPC argument-coercion
      coverage, which only the real client path exercises
- [x] `check-decisions.ts` migrated — `ask_user` native, `record_answer`
      through `execute`
- [x] **Close the coverage gap before spending on the milestone run.** A count
      of executed-vs-catalogued found 15 of 25 capabilities never actually run,
      and they were the hand-ported ones — `add_shape`'s three branches,
      morph/highlight overlap-replace, the asset service extraction. All 25 now
      execute in `check-gateway.ts`, including the asset in-use refusal (set up
      by pointing the document at an asset over the raw ops route) and the paid
      executor's plumbing (a scene with no narration text fails validation
      *before* the debit, so the path is proved for free). The three asset REST
      routes the editor binds to — list, move, delete — are covered in
      `check-assets.ts`, where their own status-code mapping lives.
- [x] `check-app.ts` re-run: editor lists and opens projects, demo loads, zero
      console errors — the routes it depends on survived the service extraction
- [x] Rewrite `docs/mcp-tools.md` as the gateway contract; the per-op table is
      gone, since `instructions` is the copy that cannot go stale
- [x] Update `docs/architecture.md` (capability catalog section),
      `docs/dev-setup.md` and `000-roadmap.md`
- [x] Re-run the milestone over the gateway — **the feasibility gate**. Compare
      tool-call count and failure loops against the third run. Everything above
      proves the mechanism works; only this says whether a generic `execute`
      helps or hurts an agent's reliability. **Done, run 4 — see below.**

## The feasibility gate: milestone run 4 (2026-08-16)

"The Derivative as a Limit" (`2ba2fa0f`), 59.74s, 3 scenes, 71 credits.
~160 gateway calls total: 1 `instructions`, 1 `describe`, 4 `execute_paid`
(3 TTS + 1 render), and the rest `execute` — of which 12 were
`preview_frames` and ~9 were `get_render_status` polls. Counted from the
transcript by hand, so treat as ±5.

**Bootstrap compliance: clean.** `instructions` was the first Euclid call in
the thread, before any project existed. The risk the plan flagged — nothing
forces a client to call it — did not materialise here, though one compliant
agent is weak evidence and the tool descriptions carrying the bootstrap
instruction is still what's load-bearing.

**`describe` round trips: 1, batched over 6 capabilities.** The design goal
was zero for common work, and the one call was not a failure of the summaries.
It was a genuine capability question the one-liners could not answer: *is
there a curve primitive?* `add_shape`'s summary says "Add a rect, circle or
line", which is exactly enough to raise the question and not enough to settle
whether a polyline/path exists. Everything after that — 20-odd distinct
capabilities across ~137 calls — ran from the `instructions` one-liners plus
error text alone. **The summaries are not too thin.**

**Failure loops: none.** 10 calls failed, in 4 distinct argument-shape
mistakes, and *every one was corrected on the very next attempt*:

| Mistake | What taught the fix |
|---|---|
| `set_narration(text:)` | error named `narrationText` |
| `add_text(text:)` | error named `textContent` |
| `update_node` flat props | error named `patch` |
| `update_node(x2/y2)` | error said line nodes have no `x2`/`y2` **and** pre-empted the position trap in the same sentence |

That last one is the design working as intended: a single error message
carried both the immediate fix and the *adjacent* trap the agent had not hit
yet. Server-side Zod as "the only teacher" holds up — no error needed a
follow-up `describe`.

**Call count vs run 3: no baseline exists.** Run 3's record in
[002](002-render-pipeline.md) does not log a tool-call count, so the
comparison this checkbox asks for cannot be made numerically, and inventing
one would be worse than admitting it. What *can* be compared: run 3 spent 76
credits (15 TTS + 61 render) for 60.9s; run 4 spent 71 (11 + 60) for 59.74s.
**Log the call count in future runs** so this gate has a baseline next time.

Qualitatively the indirection cost nothing observable. There is no round trip
the old per-tool surface would have avoided: the failures were argument-shape
mistakes that a hand-written MCP tool schema would have caught *client-side*
rather than server-side — which is a real difference, but it cost one retry
each, not a loop. Set against that, the gateway's own benefit showed up
mid-run: `preview_frames` was reached as a plain catalog entry, exactly as
Phase 3 predicted, with no new tool and no reconnect.

### The one real defect found

**`fit_scene_to_narration` silently ignores an unknown `tail` argument.** The
agent passed `tail: 1.2 / 1.2 / 4` to three scenes; all three used the 0.8s
default and reported `(10.82s speech + 0.8s tail)`. No error, no warning.

This is the **same class of bug as run 3's `update_node` trap** — a call that
reports success while doing something other than what was asked — in a
capability that was never converted to reject unknown keys. It was caught only
because the response text prints the tail it actually used, so the agent
noticed the mismatch and set the duration explicitly instead. That is luck
dressed up as a safeguard: a terser response would have shipped three
wrong-length scenes.

The `update_node` fix (loud refusal naming the real property) is clearly the
right pattern and it worked perfectly in this same run. **It should be applied
across the catalog, not just to `update_node`** — unknown keys in any
capability's args should be an error, not a strip. Worth an audit: `tail` is
unlikely to be the only one.

**Fixed 2026-08-16, and it was worse than one capability.** An audit found
*zero* of the 27 capabilities rejected unknown keys — every one used a plain
`z.object()`, which strips by default. Four more were reproduced immediately:
`add_scene(bckground:)` created a scene with the default background,
`animate(ease:)` silently used `smooth`, `preview_frames(times:)` ignored the
times and captured key moments instead, and `highlight(colour:)` returned
"highlighting … (color)" — a reply containing the word *color*, which reads
like confirmation of the argument it just dropped.

The fix is one function in `executeCapability`, not 27 schema edits: the
executor `.strict()`s any object schema before parsing. That is the catalog
design paying off — a single chokepoint means no entry can opt out and no
future entry can forget. The refusal names the offending key, says why it is
not being dropped, and lists what the capability *does* accept, because these
are near-misses (`tail`→`tailSec`, `colour`→`color`) rather than inventions.
Pinned by `check-gateway.ts` using the exact typos from this run.

### Secondary finding: `add_shape` and `update_node` disagree about lines

`add_shape` *takes* `x2`/`y2`; the line node *stores* `from`/`to`. Patching a
line therefore needs property names that appear nowhere in the creation API,
and cost 6 failed calls plus a `get_scene` to discover. This is precisely the
run-3 `update_node` complaint ("the tool that creates a node and the tool that
moves it disagree about the shape") surviving in a second place, for lines
instead of positions. The refusal message is good enough that it cost one
retry — but the asymmetry is the underlying bug, and the catalog is now the
single place to fix it.

### Verdict

**The generic executor is not costing agent reliability.** One `describe`, no
failure loops, every error self-correcting in one attempt, and the bootstrap
honored. The escape hatch (register catalog entries as per-tool MCP tools) is
not needed. The two defects found are both *catalog validation* bugs that the
gateway makes cheaper to fix, not consequences of the indirection.

### Milestone run 5 (2026-08-16): the catalog held, the doors were shut

Second run over the gateway, this one given only a subject. No failure loops
and no argument-shape retries worth recording — the strict-args fix from run 4
did its job, and `describe` was not needed to recover from anything.

What the run *did* surface is a different class of problem: **capabilities that
existed and were unreachable**. It reported "no node parenting / no transform
hierarchy" and spent roughly 60% of its calls keyframing an orbit chord by
chord. `GroupNode` had been in the document model since the scaffold, `addNode`
had always taken `parentId`, and the stage already composed group transforms.
Nothing in the catalog exposed any of it.

That is the gateway's own failure mode, and worth stating plainly: it made
*adding* a capability cheap, and did nothing for discovery. An agent reads
`instructions`, sees no group, and concludes the system has no hierarchy —
then designs around the limit it inferred. **An error costs one retry; an
inference costs an approach.** Two of run 5's seven friction points were
inferences rather than errors (the other: animating `width` on a line, which
returns a clear refusal the agent never triggered because it did not try).

Fixed the same day: `add_group`, `parentId` on every creator, `fill: "none"`
for outlines, job age on `get_render_status`, and `write_on`'s documentation
corrected where it still described the pre-`path` behaviour. The lesson for
future catalog entries is that a capability the summary does not mention may as
well not exist — `instructions` is the whole map.

## Notes / gotchas

- Tool 1's response replaces the tool-list context the client used to load —
  the behavioral prose (ask_user STOP semantics, update_node's
  track-shadowing warning, morph chaining) must survive the move into
  `instructions`/`describe` text or the agent loses hard-won guardrails that
  each exist because a real run failed without them.
- `NUMBERISH` existed because union-typed *tool schemas* make some clients
  stringify numbers. With `execute(args: object)` the args are opaque to the
  client, but keep the coercion in the server-side Zod anyway — same clients,
  same habit. `check-gateway.ts` pins this.

- **`apps/api` is on zod v4; `packages/dsl` and `apps/mcp` are on v3.** Not a
  preference — a constraint. `better-call` (under Better Auth) declares zod as
  a **peer**, so it resolves to whatever the *importing* package declares.
  Adding a plain `zod: ^3` to `apps/api` silently flipped better-call onto v3
  and the worker died at boot with `zod_default.url is not a function` (`z.url()`
  is v4-only). `pnpm.overrides` does not fix this — overrides retarget
  dependency versions, not peer resolution. The fix is for `apps/api` to
  declare `zod: ^4`, which is what it resolved to implicitly before.
  Consequences for anyone editing the catalog:
  - `z.record(valueSchema)` is v3; v4 needs `z.record(z.string(), z.any())`.
  - `z.toJSONSchema()` exists, so `describe` returns real JSON Schema. Pass
    `io: 'input'` or defaults are described as always-present outputs.
  - Do **not** compose a `@euclid/dsl` schema (v3) into a catalog schema (v4).
    Nothing does today; the catalog imports types and functions from dsl, never
    its Zod objects.

- **Count coverage, don't assume it.** After the port every check passed and
  the surface looked verified — but only 10 of 25 capabilities were ever
  executed, and the untested 15 were precisely the hand-ported ones. A passing
  suite measured the code that had *always* worked. Worth re-running that count
  (executed names vs catalogued names) whenever capabilities are added, because
  the failure mode is silent: the milestone run would have failed and the
  gateway design would have taken the blame for a porting slip.

- The hot-reload claim is real and was measured: editing a capability's
  `summary` changed both the served text and `CATALOG_REVISION` about 12s
  later, with no worker restart and no client reconnect. That is the whole
  development argument for the gateway, so `CATALOG_REVISION` is worth keeping
  honest — it is derived from the catalog, not hand-bumped.
