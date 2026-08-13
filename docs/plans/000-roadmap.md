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

## Phase 2: v1 milestone — 60s narrated equation-morph video E2E
- [ ] TTS adapter interface + first provider (word timestamps)
- [ ] Narration audio generation + storage in R2, wordTimings into the doc
- [ ] Renderer: mux narration audio into the MP4
- [ ] Render queue (Cloudflare Queues) → renderer container; job status updates; MP4 to R2
- [ ] Run the milestone: agent builds the full video over MCP, human tweaks in editor, export downloads

## Phase 3: Real users
- [ ] MCP OAuth (workers-oauth-provider + Better Auth) — claude.ai connects
- [ ] Auth UI (sign up / sign in), remove DEV_ALLOW_ANON path from prod builds
- [ ] Dashboard: project list, create/delete, credits page + Stripe checkout flow
- [ ] Deploy: workers, D1, R2, Containers; production secrets

## Phase 4: Depth
- [ ] Matched-glyph LaTeX morphing (upgrade inside texMorph seam)
- [ ] Graphs/axes/function-plot primitives
- [ ] Narration-anchored animation (sync to word timestamps)
- [ ] Timeline editor: drag keyframes, per-track lanes
- [ ] Code-block primitive with line-highlight animations
