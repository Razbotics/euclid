# Architecture

Read the root [README](../README.md) first for the component map. This doc
records the load-bearing decisions and their reasoning.

## The purity invariant

Rendering is a pure function of `(document, time)`. The sampler
(`packages/engine/src/sampler.ts`) resolves any node at any `t` with no
accumulated state, no wall-clock, no randomness. Consequences:

- Browser preview and headless export run the same code → pixel-identical.
- Scrubbing is just evaluation at a different `t` — no simulation to replay.
- The export worker double-renders each frame around `stage.whenIdle()` so
  async LaTeX textures never produce half-loaded frames.

Anything that would break this (physics, particles) must be expressed as a
deterministic function of `t` when it's added.

## Document model

`packages/dsl` defines the scene document: project → scenes (sequential on
the global timeline) → nodes (rect/circle/line/path/text/latex/matrix/tokens/
group), plus an optional per-scene `camera`. Animation:

- **Tracks** — per-property keyframes (`position`, `opacity`, `fill`, …),
  eased per-segment (`smooth` = 3b1b smootherstep). The generic mechanism.
- **Transitions** — effects not expressible as property keyframes: `write`
  (draw-on reveal), `texMorph` (matched-glyph equation morph — see below),
  `cellMorph` (the same for a matrix, matched by cell contents) and
  `highlight` (emphasis, optionally on one term inside an equation or a range
  of matrix cells).

Agent-facing sugar (`animate`, `write_on`, …) lives in the MCP layer and
compiles to tracks/transitions; the document stays low-level and uniform so
the timeline editor and the reducer only deal with one representation.

## Sync: serialized ops + event log (deliberately not CRDT)

Every writer — editor UI, MCP agent, system jobs — submits an `OpEnvelope`
(`baseVersion`, actor, ≤50 ops) to the project's Durable Object. The DO is
the single writer: it applies the envelope through the shared reducer
(`applyOps`), bumps the version, appends the envelope to an event log, and
broadcasts it to all WebSocket subscribers. Stale `baseVersion` → 409, the
writer refetches and rebases (the MCP worker auto-retries ×3).

Why not CRDT: a keyframe timeline has semantic conflicts (two writers moving
the same clip) that CRDTs merge syntactically but wrongly. A single
serialization point with rebase gives simpler semantics, plus free
undo/history from the event log. The editor doesn't even apply its own edits
optimistically — it waits for the WS echo, which at local latencies is
imperceptible and guarantees convergence.

Validation is layered: Zod schema on the envelope (bad shape → 400), reducer
invariants (missing node, duplicate id → 422), and a full-document re-parse
after each envelope so no op sequence can persist an invalid document.

## Equation morphing

`texMorph` pairs glyphs between the two equations and moves the shared ones;
only genuinely new or removed glyphs fade. The earlier cross-fade of two
whole-equation textures put both forms on screen at partial opacity through
the middle, and because each form was centred independently, terms that never
changed still drifted — the `=` visibly slid sideways.

Three pieces:

- **Matching** (`packages/engine/src/texmorph.ts`) — longest common
  subsequence over glyph codes. LCS rather than nearest-match because it
  preserves reading order: matched glyphs can never cross, which is what
  keeps the motion legible. Pure, so it is tested without a browser.
- **Glyph extraction** (`apps/web/src/tex.ts`) — MathJax tags each `<use>`
  with `data-c`, the glyph's codepoint, which is its identity. Positions come
  from measuring the live SVG in a hidden element, because MathJax nests
  transforms and the browser already composes them. The SVG is rasterized
  **once** and each glyph is a sub-texture frame of that bitmap. `<rect>`
  rules (fraction bars, the radical's vinculum) are carried across as glyphs
  too, or they would disappear mid-morph.
- **Rendering** (`pixi/stage.ts`) — a pooled sprite per glyph; a matched
  glyph keeps the same sprite across frames, so an unchanged term is
  genuinely still rather than redrawn.

Glyph addressing also gives `highlight` two styles that act on the type
rather than around it: `color` cross-fades the targeted glyphs to a copy
rasterized in the highlight colour (a recoloured render rather than a tint,
which multiplies and so can only darken a non-white equation), and
`spotlight` fades everything *except* the term — usually the stronger effect
on a busy equation, because it removes competition instead of adding
decoration. `box` and `underline` remain for non-latex nodes and for
whole-node emphasis, and are the fallback whenever the glyph run can't be
located.

The same glyph data powers two more effects. `write` reveals an equation
symbol by symbol in reading order instead of sweeping a mask edge across it,
which used to slice glyphs in half mid-stroke; non-latex nodes still use the
mask. And `highlight`: `findGlyphRun` locates a
sub-expression by rendering the fragment and finding its code sequence inside
the equation, so an agent can say "mark `\frac{b}{a}`" without knowing where
that lands on screen. Its strength ramps in, holds and ramps out — an
emphasis is a pulse, not a wipe. A node can carry a sequence of highlights;
the sampler renders the one whose window contains `t` (the MCP layer keeps
windows non-overlapping), which is what lets narration walk through several
terms of one equation in turn.

Fades are staggered — what leaves goes before what arrives — since a
simultaneous cross-fade is the muddy look being replaced. The provider seam
keeps `getGlyphs` optional: a provider without it still renders correctly via
the original cross-fade.

## Grouping

`group` nodes compose transforms the way any scene graph does: a child's
coordinates are relative to its parent, so rotating a group carries everything
inside it. This was in the document model and the renderer from the start, and
for a long time nothing exposed it — milestone run 5 keyframed an orbiting dot
as sixteen chords per revolution with hand-computed cos/sin, and reported it as
"no transform hierarchy". The hierarchy was there; only the door was missing.
`add_group` plus a `parentId` on every creator is that door, and it turns an
orbit into a single `animate` on the group's rotation.

Worth noting the shape of that failure, because it will recur: an agent cannot
tell "the system cannot do this" from "the system does not offer this", and
will design around the limit it infers. Errors are cheap — a wrong guess costs
one retry — but an inference costs a whole approach.

## Structured primitives: matrix and tokens

A `matrix` is a grid of LaTeX cells; a `tokens` node is a labelled strip. Both
are **one node**, and the shape is the point: `highlight` can mark row 1 or
cell (0,2) without anyone working out where they landed, `morph_matrix` can
restate the grid and move the cells that survived, and `write_on` fills it in
cell by cell. Hand-built, a 3x3 matrix is nine nodes whose ids the caller has
to track and whose alignment breaks when the font size changes.

Cells sit on a **fixed pitch** with their contents centred — nothing is
measured. Sizing columns to their contents would mean asking MathJax how wide
`\alpha` renders, which is asynchronous and only knowable after rasterization:
layout would then differ between a cold frame and a warm one, and the purity
invariant says a frame is a function of (document, time) and nothing else. The
cost is that a wide entry can overflow its cell, which `add_matrix` says in its
response and `preview_frames` shows.

`packages/dsl/src/grid.ts` holds the geometry — `cellCenter`, `rangeBounds`,
`cellsInRange` — so the stage, the sampler and the tool layer all measure the
same grid. A `CellRange` is `{rows?: [a,b], cols?: [a,b]}` with inclusive
bounds and an omitted axis meaning "all of it", which is `row(i)` / `col(j)` /
`cell(i,j)` / `range(...)` as one shape rather than four. A range naming cells
the node does not have selects **nothing**, and the tool layer rejects it —
clamping would mark some other row, which looks like it worked.

Both were additive: new node types and a new transition, so existing documents
stay valid and `SCHEMA_VERSION` did not move.

### What the glyph work generalised into

Phase B of [plans/006](plans/006-animation-depth.md) was mostly *extracting key
functions* from the equation morphing built in 002, not writing new animation:

| Was | Is now | Serves |
|---|---|---|
| `writeGlyphAlphas(count, progress)` | `staggerAlphas(count, progress, {rank})` | glyphs, matrix cells, group children |
| `matchGlyphs(from, to)` — LCS over codes | `matchByKey(from, to, key)` | glyphs by codepoint, cells by contents |
| `morphGlyphs` | unchanged | cells are fed to it as pseudo-glyphs on grid positions |

So a matrix restating itself is the same code path as an equation morphing, and
a `write` on a **group** now reveals its children one at a time instead of
sweeping one mask edge across the whole thing. `rank` is where the order lives:
row-major by default, `columnMajorRank` for a matrix built from column vectors.

## Camera

A scene may carry a `camera` — `position`, `zoom`, `rotation`, plus tracks —
and the stage composes it into the node layer's transform:
`screen = canvasCentre + R(−roll)·zoom·(scenePoint − camera.position)`. Pixi
builds exactly that from `pivot`/`position`/`scale`/`rotation`, so there is no
projection step and nothing downstream knows a camera exists. Node
coordinates, glyph geometry and highlight bounds all stay scene-local, which
is what lets a diagram be laid out **larger than the canvas** and read a piece
at a time — the thing a matrix of legible cells needs.

Three decisions worth keeping:

- **Not a node.** A camera inside the tree would inherit its parent's
  transform, and the frame is not something a group can own.
- **Not a new animation mechanism.** Camera tracks are the same `Track`
  shape, sampled by the same `sampleKeyframes`, obeying the same rule that a
  track shadows the base value. `move_camera` is `animate` with three
  properties: it samples the current framing at `start` rather than assuming
  it, so moves chain.
- **The background stays outside it.** `bg` is drawn in the root, not the
  camera layer, so it fills the frame rather than sitting in the scene, and
  zooming out reveals more diagram instead of the edge of the backdrop.

The camera is optional (`camera?`), so documents written before it stay valid
and `SCHEMA_VERSION` did not move. Absent means no transform at all rather than
an identity camera, which is what lets the stage reset cleanly between scenes.

A camera move is also a **key moment**: it re-frames every node at once, so
what it gets wrong is not in any node — the subject ends up half out of frame,
or the zoom settles on nothing. It has no transitions to be found by, so
`keyMoments` reads the camera tracks directly and samples mid-move and where it
settles. The editor draws a mini-map of the frame within the scene while
scrubbing, for the same reason: the preview *is* the camera's view, so the one
thing it cannot show is where that view sits.

## Curves

A `path` node holds sampled points and draws them as one polyline. It exists
because a curve was otherwise one `line` node per segment: milestone run 4's
parabola was 9 of its scene's 22 nodes, moved as nine things, and had to be
re-laid nine times when the scale changed.

It is deliberately **dumb** — points, not a formula. Anything that *produces*
the points (plotting `y = f(x)`, mapping a domain onto the canvas) is
agent-facing sugar that compiles down to this, the same split as `animate`
baking keyframes from a sampled current value. The document therefore never
holds an expression, and the purity invariant needs no argument.

Plotting `y = f(x)` sits on top as a capability, not a node type. `samplePlot`
in `packages/dsl` samples an expression over a domain and maps it into a canvas
rectangle, emitting points — so the document holds a curve, never a formula, and
the renderer needs no evaluator. The expression parser (`expr.ts`) is its own
small grammar rather than anything reaching the JS evaluator: a whitelist of
functions, `x`, and five operators, so evaluation is deterministic by
construction and `Math.random()` is simply unreachable.

The mapping is the part that matters. Run 4's expensive mistake was choosing
uniform 150 px/unit for x², where over x∈[1,2] the curve rises three units for
one across — the secant visually hugged the curve and destroyed the contrast the
video existed to teach, and only a picture caught it. So the y range is fitted
to the function by default, `uniform` is opt-in, and the transform actually used
(`originScreen`, `scale`) is **reported back**. That is what lets a caller place
a point on the curve, or a tangent, in the same coordinate system instead of
re-deriving a transform that disagrees.

Write-on is where a path differs from every other node. The generic reveal
sweeps a rectangular mask across the node's bounds, which is right for a line
of text and wrong for a curve: a mask edge reveals by *x position*, so a steep
section appears all at once and a path that doubles back reveals its later half
first. A path instead draws the prefix of itself up to `progress` measured by
**arc length** (`packages/engine/src/path.ts`, pure and browser-free), with the
final segment cut proportionally so a 60-point curve does not reveal in 60
visible steps. Because the reveal is geometry rather than a mask, a partially
drawn path is an open curve — it is never closed or filled until it is whole,
or the fill would grow as a wedge.

## Captions

Subtitles are a **pure function of the document**, the same discipline as
rendering — so they're always current, cost no credits, and need no storage.
`documentCues(doc)` emits cues at whichever fidelity the document supports,
per scene:

- `narration.audio.words` present (from TTS) → word-accurate cues
- narration text only → sentences distributed across the scene in proportion
  to their length, marked `estimated: true` so callers can tell the
  difference instead of trusting inferred timing

Cues respect subtitle conventions (~84 chars, ≤6s, break on sentence ends)
and are lifted from scene-local to global time, then **clamped to the scene**:
generated narration may legitimately outlast its scene (see Narration below),
and an unclamped cue would both describe footage that is no longer on screen
and overlap the next scene's subtitles. Served as SRT or VTT from
`GET /api/projects/:id/captions`, or as JSON for tooling. Captions upgrade
themselves from estimated to exact the moment TTS lands — no migration.

## Assets

Binary files owned by a project — narration audio today, video and image
clips when the general-video phase lands. D1 holds the metadata row
(`kind`, `mime`, `bytes`, `duration_sec`, R2 key); R2 holds the bytes under
`assets/<projectId>/<assetId>`.

Assets are **immutable**: a new upload mints a new id rather than replacing
one. That is what makes an `assetId` embedded in a document safe — a
`narration.audio.assetId` can never silently start pointing at different
bytes — and it lets reads cache indefinitely.

Creation (`POST /api/projects/:id/assets`) is internal-key only, because
producers are server-side (TTS now, ingest later) and never the browser. The
bytes stream straight into R2 so a large clip never has to fit in worker
memory, and the D1 row is written only once they land — a document must never
hold an id that resolves to nothing. Reads (`GET /api/assets/:assetId`) are
allowed for the owning user or an internal caller; the render worker uses the
latter to fetch narration audio, and tenancy is enforced by joining through
`projects`, not by trusting the caller.

## Narration (TTS)

`apps/api/src/tts.ts` defines a `TtsProvider` seam — `synthesize({ text,
voiceId }) → { audio, mime, durationSec, words }` — with ElevenLabs behind it.
The provider was chosen for **word-level timestamps**, not voice quality:
timings are what make captions exact and what will let animation anchor to
narration beats. A better-sounding provider that can't say when each word
lands is not a candidate.

The seam is real rather than nominal: the adapter is written against
web-standard APIs only (`fetch`, `atob`) with no Cloudflare types, so it runs
and is tested outside the worker. ElevenLabs reports timing per character;
grouping on whitespace is the whole conversion to the `words` the document
already models.

Synthesis runs in the **API worker**, not the MCP worker, because the API
already owns credits, R2, and the path into the Durable Object — so debit →
synthesize → store asset → submit op is one boundary with one refund path.
Generation is explicit (an MCP tool), never implicit at render time, so the
agent can read the real duration before choreographing against it and the
editor sees narration appear live. See
[plans/002](plans/002-render-pipeline.md) for the wiring.

## The capability catalog (agent gateway)

`apps/mcp` is a **relay, not a tool surface** — five fixed tools
(`instructions`, `describe`, `execute`, `execute_paid`, `ask_user`) and no
capability logic at all. Agent-facing verbs live in **one place**:
`apps/api/src/agent/`, a catalog of
capabilities each carrying its name, summary, prose contract, Zod args, a
`costsCredits` flag, and a handler. Three endpoints stand over it —
`GET /api/agent/tools` (orientation + the whole list), `POST
/api/agent/tools/describe` (full contract for named entries), and `POST
/api/agent/tools/:name/execute`. See
[plans/008](plans/008-mcp-gateway.md) for the reasoning and the migration.

Three properties are load-bearing:

- **One implementation surface.** The intent compilation that used to live in
  the MCP worker (keyframes from a sampled current value, morph/highlight
  overlap-replace, the `update_node` track-shadowing warning) now runs beside
  the Durable Object, so a write is one local stub call instead of three
  cross-worker round trips — and the editor can reach the same verbs. The
  heavyweight paths (`services/{assets,narration,render}.ts`) are shared
  outright: the REST routes and the catalog call the same functions, so
  pricing, debit and refund exist once.
- **A fixed tool list.** MCP clients cache `tools/list` at connect, so a tool
  edit used to need a redeploy *and* a client restart — which cost two
  milestone runs their tool coverage. With permanent meta-tools the catalog is
  read at call time, and an edit is live on the next call in the same session
  (measured through a held MCP session: same session id, unchanged tool list,
  new capability text). `CATALOG_REVISION` is derived from the catalog and
  stamped on responses, so a validation error can say the schema moved rather
  than looking like the agent got the call wrong.
- **Paid work is a separate door.** Permissions in MCP clients are per-tool, so
  a single `execute` would let "always allow" quietly cover renders. Credit-
  spending capabilities are reachable only through the paid executor, and each
  door refuses the other's capabilities.

Two things deliberately do **not** move. `ask_user` stays a native MCP tool:
elicitation is a protocol act (the server asks the *client* to open a picker),
and the fallback controls the agent's next reply — neither is expressible as a
request/response capability. And asset **bytes** stay on plain REST, since tool
args are JSON and base64 through an LLM context is a non-starter.

Because validation moved server-side, error text is now the agent's only
teacher — which is why lookups name what *does* exist and rejections name the
capability to call next.

## Agent sight

The agent cannot scrub a timeline, and until now could not see anything it
made: `get_project` confirms a highlight *exists*, never that it landed on the
right glyph. `preview_frames` returns **one labeled contact sheet** — the
capability's caption plus an MCP `image` block — for free, in about a second.
See [plans/007](plans/007-agent-sight.md).

Three properties carry it:

- **Which times.** `keyMoments(doc)` in `packages/dsl` is pure, like
  `scenePacing` and `documentCues`: the document already knows every morph
  midpoint, highlight window and mid-reveal. Morphs are sampled at 25/50/75%,
  because the failure being hunted is usually a trajectory rather than one bad
  frame. The editor draws the same list on its scrubber, so the human and the
  agent are never looking at two different maps.
- **Not a second renderer.** Capture drives the same
  `window.__euclid.renderFrame` the exporter drives, so a preview frame is not
  an approximation of the export — it *is* one frame of it. Frames are composed
  into the grid inside the page, so a twelve-tile sheet costs one image
  transfer rather than twelve `page.screenshot()` round-trips. A Worker cannot
  run Chromium, so capture lives behind `PREVIEW_ORIGIN` — served by
  `render-worker.ts`, the same process that drains the render queue. One
  process, one warm page for previews, a child process per render job; only
  its deployment is still local.
- **Free, deliberately.** Twelve frames is 0.3% of a 3,654-frame render. If
  preview cost credits agents would render instead — 200× dearer and three
  minutes slower — so `preview_frames` refuses the paid executor. This is the
  same reasoning that keeps `get_project` free.

A capture failure and a correctly-rendered dark frame are the same bytes: a
valid PNG of the right size. So the backend measures the lit fraction of each
tile where the pixels actually are (the PNG cannot be asked — row filtering
makes flat regions look like zeros) and reports it; a sheet of **key moments**
that comes back entirely blank is refused as a capture fault rather than handed
to an agent that would read it as a broken video. Explicitly requested times
are exempt: there, "empty" can be the true answer — before a write-on starts,
or when a camera is framing part of the scene where nothing is — and erroring
would report a broken backend for a framing mistake.

Two defects in this path were found while building the camera (2026-08-16),
which is the first feature where "the document changed" and "the picture
changed" come apart cleanly. Both are now asserted in `check-preview.ts`:

- Ink was measured **after** the tile's hairline border was drawn, and the
  border is inside the measured rect. Every tile carried a ~1.2% floor, so a
  blank frame scored 1.15% against a 0.02% threshold and the capture-fault
  guard could never fire.
- The capture cache was keyed on the document's **JSON length**. Any
  length-preserving edit — (960,540) → (200,200), `#ffffff` → `#101418`, a
  duration of 6 → 8 — served the previous frame back as current. It is a
  content hash now.

## Shapes without fills

`fill` is optional on rects and circles: omitted, the shape is an outline. It
had been required, so a ring meant filling with the background colour — which
paints an opaque disc that occludes whatever is behind it and stops working the
moment a background is not flat. `add_shape` takes `fill: "none"` for this.

## Deleting a project

`DELETE /api/projects/:id` (and the `delete_project` capability) is the only
operation with **no way back**: the event log that makes every other mistake
recoverable lives in the Durable Object storage this destroys. Three things
follow from that.

The cascade is ordered **bytes → rows → document → project row**. R2 is the
only store with no foreign key pointing at it, so an object orphaned by a
mid-way failure is invisible and unreclaimable, while an orphaned *row* is
still reachable by `project_id` and cleans up on a retry. So the unrecoverable
work happens first, while the rows that let us find it again still exist. The
project row goes last because the deletion stays resumable — and ownership
stays checkable — for as long as it is there.

The Durable Object gets an explicit `/destroy`, because no SQL delete reaches
the document or the decisions. It clears its in-memory `doc` too: emptying
storage does not evict a live instance, so one that kept its copy would go on
serving and mutating a document that no longer exists anywhere else.

Both surfaces refuse to fire blind. The endpoint takes `?dryRun=1` and the
capability requires `confirm: true`; without them each reports what the
project holds — scenes, duration, assets, renders — and deletes nothing. That
report is what makes a bulk cleanup checkable before it runs.

## Editor entry points

`/` lists every project, newest first; `?project=<id>` opens the editor on
one; `?demo=1` opens a bundled offline document. The list matters more than
it looks: an agent creates projects over MCP and the id only ever appears in
a tool response, so without it the work is invisible unless someone copies a
UUID by hand. Bare `/` used to show the demo, which is indistinguishable
from "connected but not syncing" — the demo now says so on its badge.

## Agent questions

The agent can put a choice to the human rather than deciding alone —
`ask_user` / `get_answer` / `record_answer`, all free. See
[plans/005](plans/005-agent-questions.md) for the reasoning.

Questions are **asked in chat** and **stored** in the project's Durable
Object. Chat because the system may run headless, with no browser open — a
question that exists only in a web panel is a question nobody is asked; the
tool returns a ready-to-paste block and instructs the agent to stop and wait.
The DO copy gives persistence, an audit trail, and a second surface for
whoever does have the editor open, where a question about a moment can offer
to seek to it. Not in `EuclidDoc`, because a decision is workflow state that
never affects a frame; putting it there would bump SCHEMA_VERSION and reach
the renderer.

They broadcast over the same WebSocket as ops, so the editor shows them live
with no new transport, and they persist, so a question asked before the editor
was open is waiting when it opens. The human can answer in the editor or tell
the agent, which records it; `answer.via` keeps the two distinguishable, and
the first answer wins — a second is refused rather than silently overwriting.

## Product ceilings (v1)

1080p max, 30 or 60 fps, 10 minutes per video — enforced by the document
schema and the render endpoint (`packages/dsl/src/limits.ts`). v1 primitives
are LaTeX plus shapes/text/groups. These bound render cost, which is what
credits are priced against.

The active direction is **depth before breadth**: richer animation in the
math vertical — a scene camera, matrices and other structured primitives,
and pseudo-3D — before widening to general video. See
[plans/006](plans/006-animation-depth.md); general video is deferred but not
abandoned in [plans/003](plans/003-general-video.md).

Two properties of the model make both directions cheap. Nodes are a
discriminated union, so `video` and `audio` clip types extend it without a
rewrite. And depth is projection, not a second renderer: `(x, y, z)` → screen
is pure math in the sampler, so it keeps the purity invariant, needs no GPU
(the render container has none), and leaves preview and export identical.

## Render path

`apps/web/render.html` exposes `window.__euclid.{load, renderFrame}`.
`apps/renderer` drives it in headless Chromium, screenshots the canvas per
frame, and pipes PNGs into ffmpeg.

Narration is muxed in the same ffmpeg invocation: each scene's audio asset
becomes an extra input placed at that scene's global start with `adelay`, so
silence between clips falls out of placement rather than needing padding
files. Audio that outruns its scene is cut at the boundary — the same rule
captions follow — so one scene's voice never plays over another's frames.

Placement is `planNarration` in `packages/dsl`, deliberately **not** in the
renderer: the editor's audio preview derives its offsets and trims from the
same function, so what you hear while scrubbing is what lands in the file.
`apps/renderer/src/mux.ts` keeps only the ffmpeg-specific half. This is the
audio counterpart of the purity invariant — but note audio itself stays out of
`packages/engine`, which must remain a pure function of (document, time);
playback lives in the browser shell (`apps/web/src/Narration.tsx`). Target: Cloudflare Containers consuming a
Queue that `POST /render` feeds (queue deferred — see plans/002).

The queue is drained by `apps/renderer/src/render-worker.ts`, which **pulls**:
it claims the oldest queued job through `POST /api/jobs/claim` and spawns
`render.ts` for it. A pull rather than a push because a Worker cannot run
Chromium, so the renderer lives outside Cloudflare and has to come and ask.
Claiming is a conditional `UPDATE ... WHERE status = 'queued'` — the same
trick the terminal states use — so two workers racing for one job resolve by
`changes === 0` rather than by a lock.

One child process per job, deliberately: a render that wedges the browser or
exhausts memory takes its own process down, not the worker, which is also the
shape a container-per-job deployment has. The child drives its own status
transitions, and the worker marks anything that exits without reaching a
terminal state as `failed` — otherwise `rendering` becomes the new `queued`,
a job paid for and never resolved. When this moves to Queues + Containers the
producer changes and `/api/jobs/claim` goes away; the lifecycle either side of
it does not, which is why those transitions live in the API.

Job lifecycle: `POST /render` prices the video (per-second × resolution, see
`packages/dsl/src/limits.ts`), debits credits up front, and creates a
`queued` job. The render worker then drives it — `rendering`, upload the MP4
to R2 via `PUT /api/jobs/:id/output`, `done` — or marks it `failed`, which
**refunds the credits automatically**. Terminal states are final at the SQL
level (the UPDATE matches only non-terminal rows and the refund is gated on
whether it applied), so a retried or duplicated callback cannot double-refund.
Finished videos are streamed back through `GET /api/jobs/:id/download`.

URLs handed to clients are built from `PUBLIC_API_ORIGIN`, never from the
request origin: service-binding calls from the MCP worker arrive with an
internal hostname and would otherwise produce unusable links.

## Auth, credits, tenancy

Better Auth (D1) owns identity; the same instance will back the MCP worker's
OAuth so claude.ai can connect. Credits meter renders + TTS only — agent
iteration must stay free (users burn their own Claude tokens over MCP), so
MCP tools return compact text (outlines, ids) rather than anything expensive.
Projects are single-user in v1; the DO/event-log design already supports
multi-writer, so collaboration is an authorization feature, not a rewrite.

## Dev-only auth bypass

`DEV_ALLOW_ANON=1` (root `.env`) lets sessionless requests act as
`dev-user` so the editor works before auth UI exists. The flag must never be
set in production; the middleware checks the real session first either way.
