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
- [ ] TTS adapter interface + first provider (word timestamps)
- [ ] Narration audio in R2, wordTimings into the doc
- [x] Captions: SRT/VTT export, document-derived (upgrades to word-accurate when TTS lands)
- [ ] Renderer: mux narration audio into the MP4
- [ ] Run the milestone: agent builds the full video over MCP, human tweaks in editor, export downloads

Render queue (Cloudflare Queues → Containers) is deliberately deferred until
after the milestone — see plans/002 for the reasoning.

## Phase 3: Real users
- [ ] MCP OAuth (workers-oauth-provider + Better Auth) — claude.ai connects
- [ ] Auth UI (sign up / sign in), remove DEV_ALLOW_ANON path from prod builds
- [ ] Dashboard: project list, create/delete, credits page + Stripe checkout flow
- [ ] Deploy: workers, D1, R2, Containers; production secrets

## Phase 4: General video → plans/003-general-video.md
Direction change: not limited to educational math animation. Math is the
first vertical; the target is a general agentic video editor including
reel/clip workflows.
- [ ] Replace per-frame screenshot capture with WebCodecs (wins on the current path too)
- [ ] Assets as first-class (registry, proxies, thumbnails)
- [ ] `video` / `audio` node types; tracks and layering within a scene
- [ ] Multi-track timeline UI
- [ ] Ingest + analysis (fetch → transcode → STT → shot detection → segments)
- [ ] Decide the rights/ToS model **before** building the ingest fetcher
- [ ] Narration-anchored animation (sync to word timestamps)

## Phase 5: Vertical depth (deprioritized by the Phase 4 change)
- [ ] Matched-glyph LaTeX morphing (upgrade inside texMorph seam)
- [ ] Graphs/axes/function-plot primitives
- [ ] Code-block primitive with line-highlight animations
