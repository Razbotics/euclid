# 013 — Programmatic tool calling (status: Phase 1 done; Phases 2-3 deferred to v2)

**Deferred 2026-08-26.** Phase 1 shipped and stays — it was built to be
additive and serves any caller that reads a reply as data, including the
editor. Phases 2 and 3 need an agent harness that owns the `/v1/messages`
loop, and that is a new application rather than an increment, so it is v2
work. What made the call easy is that the gap PTC closes turns out to be
narrower than this plan assumed when it was written: `execute_batch`
(plans/011 gap 8) shipped in between and already collapses round trips for
every call whose arguments are known up front. See "What deferring costs".

Proposed 2026-08-23, from reading the gateway against Anthropic's
programmatic tool calling (PTC) docs. Under PTC the model writes a Python
script in the code-execution container; a tool marked
`allowed_callers: ["code_execution_20260120"]` becomes an **async function
inside that script** which takes a dict of args and returns a string — the
text of the `tool_result` we send back. The script loops, filters and
aggregates; only its final printed output enters the model's context.
Intermediate results never cost context tokens.

## Why this surface is already most of the way there — and the one wall

**The wall first: MCP-connector tools cannot be called programmatically.**
The restriction is categorical — no change to `apps/mcp` opts it in. But the
MCP worker is a thin relay by design (plans/008), and the real surface is
HTTP: `POST /api/agent/tools/:name/execute`. The roadmap's own agent
(MCP-external, driving the Claude API directly) defines `execute` as an
ordinary custom tool proxying to that endpoint, and *that* is PTC-eligible.
So PTC rides the gateway through a second front door; the MCP worker stays
for third-party clients and is unaffected.

Three properties of the existing design carry over for free:

- **The generic executor dodges PTC's schema limitation.** A tool whose
  `input_schema` contains a recursive `$ref` is refused for programmatic
  calling (`Circular $ref detected`). NodeSchema is recursive — 67
  individually-exposed capability tools would have to tiptoe around that;
  `execute(name, args: object)` is trivially flat.
- **Server-side strict validation with remedy-bearing errors** survives:
  in PTC the error text arrives inside the running code as the returned
  string, the script surfaces it, and the model corrects on the next
  attempt. "Errors are the documentation" needs no rework.
- **Auto-rebase writes** mean a script firing thirty edits in a loop does
  not trip over version conflicts.

And one framing note: PTC's headline saving (20–40% of input tokens on
10–49-tool surfaces) is mostly *schema* weight, which the five-tool gateway
already eliminated. What PTC adds **here** is loops, filtering and fan-out —
capabilities like `sample_at` become affordable to call twenty times.

## Where it pays, honestly

The docs are blunt that sequential single-call workflows *lose* money on
PTC (~8% worse on τ²-bench — container startup and script generation are
overhead the saved round trips must beat). The creative loop — look at a
preview, decide, adjust — is exactly that shape and should stay direct.
The genuine fits:

- **Verification sweeps**: `sample_at` across many timestamps × all nodes,
  checking overlap/off-frame numerically in code, returning only the
  violations. Today this costs a round trip per sample, so it simply does
  not happen.
- **Timing choreography**: `get_narration_timing` → compute anchor times in
  code → a run of `animate`/`highlight` calls against them.
- **Bulk mechanical construction**: loops of `add_*` once the design is
  decided (run 9's 48-call motion was this shape before keyframe lists).
- **Asset triage**: filter `list_assets` + `get_shots` across a library so
  the model reasons over five candidates instead of fifty.

## What deferring costs, and what brings it back

`execute_batch` landed after this plan was written and changes the arithmetic
it was argued on. The comparison for Phase 2 is no longer "PTC versus one call
at a time" — it is "PTC versus a batch", which is a much higher bar. A batch
already covers every call whose arguments are known when the list is written,
in one round trip.

So the **irreducible** gap is two things, and only two:

- **Loops with a data dependency** — call, read the result, decide the next
  call, with no model turn in between. A batch cannot express this because it
  is written before any of it runs; the same limit as its missing reference
  syntax, recorded in plans/011 gap 8.
- **Filtering a large result before it reaches the context** — the twenty-sample
  `sample_at` sweep that returns only the violations. A batch runs the twenty
  calls in one trip, but every reply still lands in the model's context, so the
  sweep stays unaffordable for exactly the reason PTC would fix.

Both are real and neither is *measured*. That is the honest state: this plan's
fits were reasoned from the docs, not from a run.

**What brings it back:**

- A milestone run where one of the two gaps above costs something countable,
  the way run 9 measured 48 of 95 calls on one missing capability. Deferring is
  not "PTC is not worth it" — it is "nobody has paid for it yet".
- Euclid needing to own the agent loop for product reasons anyway — headless
  runs, billing, a UX that cannot be someone else's chat client. The harness
  stops being a cost attributable to PTC at that point, and PTC comes free.
- **Managed Agents supporting `allowed_callers`** — unverified, and one
  documentation check. Anthropic hosts the loop and the container there, so if
  the answer is yes, Phase 2 costs a fraction of what this plan assumes and the
  deferral should be revisited immediately rather than in v2.
- A client-side MCP harness exposing `allowed_callers` on the tools it
  re-presents. The restriction is on the API's **MCP connector** specifically,
  not on MCP as such — a harness that speaks MCP itself and passes those tools
  through as ordinary custom tools is a different mechanism, and whether any
  does this is unverified.

**What deferring does not cost:** Phase 1 is merged and independent. JSON-shaped
errors and published result contracts serve the editor and any code caller
today, and they are what a harness would have needed first anyway — so nothing
here has to be rebuilt if this comes back.

## Phase 1: The structured half reaches the caller   (status: done 2026-08-23)

Every handler already returns `{data, text}` (`CapabilityResult`), and
`?format=json` already renders both — then the relay throws `data` away and
hands the agent prose. A script doing `json.loads` on `sample_at`'s reply
has to regex numbers out of a sentence, which is the same class of
silent-wrongness the catalog fights everywhere else. All of this phase is
additive and improves today's MCP clients too; none of it waits for the
external agent.

- [x] **Errors under `format=json` are JSON.** `failure()` used to answer
      `text/plain` whichever format was asked for, so a caller that parses
      every reply crashed on *every* capability error. Now
      `{"error": {message, status, kind?, revision}}`, prose verbatim in
      `message`, text door untouched. `kind` is one of `invalid_args`,
      `unknown_capability`, `wrong_executor`, `not_found`, `rejected`,
      `forbidden`, `gated` — **set at the throwing site, never inferred from
      the status**, because 403 covers both "not your project" and "the human
      has not approved that asset", and a taxonomy derived from transport is
      a guess dressed as data. Absent means read the message. The one
      deliberate exception is the tenancy gate, where the status really *is*
      the meaning (404 no such project / 403 not yours) and is read back
      through `accessKind` — the first cut blanket-mapped it and shipped
      `kind: "forbidden"` on a 404 whose own message said "not found", which
      is the exact lie the field exists to prevent.
- [~] **The MCP relay carries `structuredContent`** — **not done, and
      deliberately.** The relay still drops `data`. The premise this task was
      written on ("text-reading clients see nothing new") is unverifiable:
      hosts differ in whether they put `structuredContent` into the model's
      context, and one that does would double the cost of the cheapest
      surface here — against CLAUDE.md's "MCP tools return cheap text so
      agent iteration stays free", which is a non-negotiable rather than a
      preference. Weigh that against the consumer: PTC **cannot** call
      MCP-connector tools at all, and the editor already binds to
      `?format=json` over HTTP, so no reader exists today that this would
      serve. Revisit when a real MCP client needs `data` — and reach for the
      opt-in shape then (a `structured: true` argument on `execute`) rather
      than always-on, so the default stays free.
- [x] **Audit the read capabilities' `data` payloads.** The finding is that
      they were in better shape than this plan assumed: `sample_at`,
      `get_project`, `get_history`, `list_assets`, `get_narration_timing` and
      `get_plan` already carried honest payloads, so the gap was the
      *contract*, not the data. One real defect, and it is the one that
      justifies the phase: `get_shots` returned `{shots, segments, pending}`
      from both settled branches and `{shots: null, pending: true}` while
      detection was still running, so a caller looping over `data.segments`
      crashed on exactly the asset it was waiting for. Fixed — `pending` is
      the signal, and an absent key never is.
- [x] **Result contracts in `describe`.** Optional `result` Zod schema on
      `Capability`, printed under `RESULT` after the arguments and emitted as
      JSON Schema (`io: 'output'`, the mirror of `argsSchemaOf`) under
      `?format=json`. Declared on the eight reads and **deliberately absent on
      the writes**, which the check asserts: a write has nothing to compute
      over and an empty contract is noise. `get_project` / `get_scene` name
      the EuclidDoc rather than inlining its recursive schema — a pointer to
      the contract that actually governs stays true when the DSL moves, and
      inlining would cost more than it teaches.
- [x] `check-gateway.ts` grows the assertions, and both were **confirmed to
      fail** before being trusted: disabling the JSON error path fails with
      "non-JSON body under ?format=json", and a required field no handler
      returns fails with "the contract is a promise a script will hold you
      to". That second one is the mechanism the phase rests on —
      `contractHolds` calls six reads for real and requires every field the
      contract calls required to actually be present, because a declared
      result is a claim about a handler that assembles `data` by hand and
      nothing in the type system holds the two together.

## Phase 2: The PTC front door   (status: deferred to v2 — needs an agent harness)

The harness that drives the Claude API defines the gateway as custom tools.
This phase is that tool surface plus the rules three tools need.

- [ ] `execute` defined as a custom tool with
      `allowed_callers: ["direct", "code_execution_20260120"]`. The docs
      prefer choosing one caller per tool; `execute` genuinely lives in
      both worlds (sequential creative calls *and* programmatic sweeps), so
      the guidance gap is closed with prose instead — see the
      `instructions` item below. `instructions` and `describe` stay
      direct-oriented but are harmless from code.
- [ ] **Three tools are direct-only, enforced not intended.** The harness
      sees `caller.type` on every `tool_use` and refuses these when it
      names code execution (`allowed_callers` is guidance, not a security
      boundary — the docs say so; the harness check makes it one, the same
      philosophy as the server-side free/paid split):
      - `ask_user` — the STOP-and-wait contract assumes the *model* reads
        the result the instant it lands. In code the result lands in a
        variable, the model never sees the block, and the pending call
        raises `TimeoutError` after ~4 minutes — the "built the rest of the
        video against its own guess" failure, made structural.
      - `execute_paid` — every credit spend stays a deliberate,
        model-visible act, never an iteration of a loop. The server-side
        split remains the real boundary and is unchanged.
      - `preview_frames` (via `execute`) — PTC tool results must be strings
        or text blocks; image blocks are rejected. The existing
        `[image omitted]` fallback means a code call degrades loudly, but
        the capability's whole point is the model's eyes, so the harness
        routes it direct.
- [ ] **The gateway learns who is calling.** The harness forwards a header
      (e.g. `x-euclid-caller: code`) so the gateway can answer a code
      caller with the JSON envelope (`{"text", "data"}` — the string the
      script `json.loads`es) and a direct caller with prose, and can refuse
      `preview_frames`/`ask_user`-adjacent shapes server-side as a second
      net behind the harness check.
- [ ] **`instructions` teaches the split**, in the orientation block and
      generated where possible: *call from code for sweeps, bulk edits and
      anything you would loop; call directly when each result changes what
      you do next — and never `ask_user`, `execute_paid` or
      `preview_frames` from code.* Any capability named in that paragraph
      goes through `ref()` like everywhere else.

## Phase 3: Scripted-retry safety and the measurement   (status: deferred to v2, with Phase 2)

- [ ] **Idempotency for scripted retries.** The docs note the model's code
      "typically retries" after a `TimeoutError` — but a timed-out call may
      have committed, and a retried `add_text` double-adds a node. An
      optional client-supplied idempotency key on `execute`, deduped
      briefly beside the DO, closes the double-apply window.
- [ ] **Measure before believing.** The docs' own advice: compare billed
      input tokens with and without `allowed_callers` on representative
      traffic. Run a milestone build with PTC enabled and count what the
      sweeps actually cost and catch — a verification sweep that finds a
      layout collision `preview_frames` would have needed is the success
      criterion; a run that never writes a loop is a finding too.

## Notes / gotchas

- **Container mechanics**: a pending programmatic call times out after
  ~4 minutes (`TimeoutError` in the script, which the model sees in
  `stderr` and typically retries); idle containers are reclaimed after
  ~5 minutes; the container id must be passed back while a call is
  pending. Slow paid work could not live inside a script even if the
  policy allowed it — submit-then-collect (`get_generation_status`)
  already has the right shape for that, direct.
- **Tool-result-only turns**: while programmatic calls are pending, the
  user message may contain *only* `tool_result` blocks — no text. The
  harness cannot piggyback status or human input on those turns, which is
  one more reason `ask_user` cannot cross the code boundary.
- **`execute_batch` (plans/011) multiplies with PTC rather than competing** —
  and it **shipped 2026-08-23**, before Phase 2. Each programmatic call is
  still a pause → HTTP round trip → resume cycle and a separate DO submit; run
  9's 48 calls under PTC would be one model round trip but still 48 network
  cycles. The script computes the batch, one call applies it.
  Measuring it sharpened what PTC is for, too. A batch does the same server
  work in the same time (12 calls, 286ms vs 296ms) — what it removes is the
  agent stopping to wait. So the two save different things and stack: the
  batch collapses round trips for calls whose arguments are already known,
  and PTC collapses the *reasoning* turns for calls whose arguments have to
  be computed from what the last call returned. Neither makes the DO faster,
  and no phase here should claim it does.
- Batch/PTC interaction with review gates is a non-issue by construction:
  free work is never gated, and everything gated is paid and direct-only.
