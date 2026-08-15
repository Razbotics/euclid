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

## Phase 4: Complex animation and depth → plans/006-animation-depth.md
Direction decided 2026-08-15: go **deep on the math vertical before going
wide**. The Phase 2 milestone showed the pipeline reliably makes a *correct,
synced* video while the ceiling on whether it is a *good* one sits entirely
in the animation primitives. Going general first would ship an editor that
makes mediocre video in every vertical rather than excellent video in one.
Target: the visual vocabulary of 3Blue1Brown's transformer series.
- [ ] Camera on the scene (position/zoom/rotation), animated by ordinary tracks
- [ ] Structured primitives: `matrix`, `tokens`, cell-level addressing
- [ ] Generalise stagger + element matching out of the glyph work in 002
- [ ] Pseudo-3D by projection: optional `z`, camera yaw/pitch, depth cues
- [ ] Flows: arrows anchored to nodes, path-following

Pseudo-3D by projection rather than a 3D engine — it stays a pure function of
(document, time), needs no GPU (the container has none), and keeps preview
and export identical. See plans/006 for why that is load-bearing.

## Deferred: General video → plans/003-general-video.md
Superseded as the active direction by Phase 4 above, **not** abandoned — the
market analysis behind it stands and the plan is unchanged. Resume once the
vertical is genuinely good. Work already done for it keeps its value: the
WebCodecs benchmark, the container codec findings, and the asset registry
built in Phase 2.
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

## Phase 5: Vertical depth (folded into Phase 4 above)
- [x] Matched-glyph LaTeX morphing (upgrade inside texMorph seam)
- [ ] Graphs/axes/function-plot primitives
- [ ] Code-block primitive with line-highlight animations
