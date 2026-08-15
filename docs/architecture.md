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
the global timeline) → nodes (rect/circle/line/text/latex/group). Animation:

- **Tracks** — per-property keyframes (`position`, `opacity`, `fill`, …),
  eased per-segment (`smooth` = 3b1b smootherstep). The generic mechanism.
- **Transitions** — effects not expressible as property keyframes: `write`
  (draw-on reveal), `texMorph` (matched-glyph equation morph — see below) and
  `highlight` (emphasis, optionally on one term inside an equation).

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

Note the document model is **not** math-specific: nodes are a discriminated
union, so `video` and `audio` clip types extend it without a rewrite. That
matters because the product direction now targets general video and reels —
see [plans/003-general-video.md](plans/003-general-video.md), which also
covers the one piece that genuinely must be replaced (per-frame screenshot
capture, which cannot composite decoded video at usable speed).

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
