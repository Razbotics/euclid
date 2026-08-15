# 000 — Roadmap (status: in progress)

Top-level phases from scaffold to launch. Detail lives in per-phase plan
files; this file tracks the big picture.

## Phase 0: Scaffold (status: done)
- [x] Monorepo, DSL + shared reducer, deterministic engine
- [x] Pixi stage: shapes/text/latex, tracks, write-on, texMorph crossfade
- [x] API worker: ProjectDO event log + WS broadcast, Better Auth wiring, Stripe scaffold
- [x] MCP worker with 16 tools
- [x] Editor: live preview, timeline scrub, inspector edits
- [x] Renderer script + Dockerfile; pixel-level verification tooling

## Phase 1: Local E2E (status: done) → plans/001-local-e2e.md
- [x] Local D1 + auth schema, dev anon bypass
- [x] Ops path verified (409 conflicts, invalid-op rejection)
- [x] MCP loop verified (tools → service binding → DO)
- [x] Editor live-sync verified (external op → WS → canvas)
- [x] Root .env/.env.local system + Cloudflare tunnel script
- [x] Better Auth cloud dashboard connected via tunnel

## Phase 2: v1 milestone — 60s narrated equation-morph video E2E → plans/002-render-pipeline.md
- [x] Silent MP4 export verified end-to-end (animation confirmed in the file, not just a file produced)
- [x] Close the render job loop: R2 upload, job status, download URL, refund on failure
- [x] Asset registry (`assets` table + routes) — prerequisite for narration
      audio; also the Phase 4 "assets as first-class" down payment
- [x] TTS adapter interface + ElevenLabs provider (word timestamps)
- [x] Narration audio in R2, wordTimings into the doc
- [x] Captions: SRT/VTT export, document-derived (upgrades to word-accurate when TTS lands)
- [x] Renderer: mux narration audio into the MP4
- [ ] Run the milestone: agent builds the full video over MCP, human tweaks in editor, export downloads

Render queue (Cloudflare Queues → Containers) is deliberately deferred until
after the milestone — see plans/002 for the reasoning.

## Phase 3: Real users
- [ ] MCP OAuth (workers-oauth-provider + Better Auth) — claude.ai connects
- [ ] Auth UI (sign up / sign in), remove DEV_ALLOW_ANON path from prod builds
- [~] Dashboard: project **list** done (`/` in the editor — agent-created
      projects were otherwise invisible, since the id only appears in a tool
      response); create/delete and the credits page still to do
- [ ] Deploy: workers, D1, R2, Containers; production secrets

## Phase 4: Agent sight → plans/007-agent-sight.md
Direction decided 2026-08-15 after the third milestone run: **the agent
cannot see what it makes.** Every quality finding across all three runs came
from a shell — `shot.ts`, `ffmpeg`, an untracked one-off script — and Phase 3
connects claude.ai over MCP, which has no shell. Its only feedback is text,
so it can confirm a highlight *exists* but never that it landed on the right
glyph. The third run's `update_node` bug (seven position patches returned
success and changed nothing) was caught only by looking at a picture — it
turned out to be **two** traps, both now fixed and both loud:
a patch naming properties the node lacks (`{x, y}` rather than
`{position:{x,y}}`) was stripped by Zod and reported success, and is now
rejected; and a patch to a property an animation keyframes changes the
document but not the render, since the track wins — `update_node` now says
so. Neither fix makes sight less necessary: an agent without a shell still
could not have found the first one.
- [ ] `keyMoments(doc)` in packages/dsl — pure, the transition times worth seeing
- [ ] `preview_frames` MCP tool returning one labeled contact sheet — **free**
- [ ] Full-res drill-down for a single suspicious frame
- [ ] `check-preview.ts`; editor uses `keyMoments` to mark the scrubber
- [ ] Bind capture to the render backend — **no second renderer**

Preview frames are only trustworthy because of the purity invariant: a
preview frame is not an approximation of the export, it *is* the export.
Building an independent capture path would trade that away.

## Phase 5: General video → plans/003-general-video.md
Reinstated as the product direction 2026-08-15. It was briefly superseded by
the animation-depth plan; the third run showed the binding constraint is not
the visual vocabulary but verification, which is platform work rather than
vertical work. Phase 4 rides on this plan's capture rework: WebCodecs removes
the `page.screenshot()` round-trip, and asset proxies/thumbnails are the same
capability as a document contact sheet.
- [ ] Replace per-frame screenshot capture with WebCodecs (wins on the current path too)
- [x] Assets as first-class (registry) — done in Phase 2; proxies/thumbnails still to do
- [ ] `video` / `audio` node types; tracks and layering within a scene
- [ ] Multi-track timeline UI
- [ ] Ingest + analysis (fetch → transcode → STT → shot detection → segments)
- [ ] Decide the rights/ToS model **before** building the ingest fetcher
- [ ] Narration-anchored animation (sync to word timestamps)

## Parallel track: agent asks the human → plans/005-agent-questions.md
- [x] `ask_user` / `get_answer` / `record_answer`; questions ride the project
      DO and appear live in the editor, answerable there or relayed from chat

## Parallel track: desktop app → plans/004-desktop.md
Evaluated, deliberately not started. Everything that breaks on the server
(no H.264 encoder, no GPU, SwiftShader) is abundant on the desktop, and
local rendering inverts the cost model. Revisit when the general-video
direction is confirmed, container render cost becomes a constraint, or users
prove unwilling to upload source footage.

## Deferred: Complex animation and depth → plans/006-animation-depth.md
Superseded as the active direction by Phase 4, **not** abandoned — the
pseudo-3D-by-projection analysis stands unchanged and is still the right
answer whenever depth is picked up. Deferred because the plan's own
verification step ("verify by screenshot at several camera angles") assumes
the capability Phase 4 builds. Everything already shipped for the vertical
keeps its value; what stops is *new* vertical investment until the agent can
check its own output.
- [ ] Camera on the scene (position/zoom/rotation), animated by ordinary tracks
- [ ] Structured primitives: `matrix`, `tokens`, cell-level addressing
- [ ] Generalise stagger + element matching out of the glyph work in 002
- [ ] Pseudo-3D by projection: optional `z`, camera yaw/pitch, depth cues
- [ ] Flows: arrows anchored to nodes, path-following

## Deferred: Vertical depth (folded into the animation-depth plan)
- [x] Matched-glyph LaTeX morphing (upgrade inside texMorph seam)
- [ ] Graphs/axes/function-plot primitives
- [ ] Code-block primitive with line-highlight animations
