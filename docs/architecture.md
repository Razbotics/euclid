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
  (draw-on reveal) and `texMorph` (equation morph; currently a crossfade,
  planned upgrade to matched-glyph inside the same seam).

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
and are lifted from scene-local to global time. Served as SRT or VTT from
`GET /api/projects/:id/captions`, or as JSON for tooling. Captions upgrade
themselves from estimated to exact the moment TTS lands — no migration.

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
frame, and pipes PNGs into ffmpeg. Target: Cloudflare Containers consuming a
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
