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
      audio; also the general-video phase's "assets as first-class" down payment
- [x] TTS adapter interface + ElevenLabs provider (word timestamps)
- [x] Narration audio in R2, wordTimings into the doc
- [x] Captions: SRT/VTT export, document-derived (upgrades to word-accurate when TTS lands)
- [x] Renderer: mux narration audio into the MP4
- [x] Run the milestone: agent builds the full video over MCP, export
      downloads. **Five runs done** (see plans/002); run 5 was given only a
      subject and produced a 67s synchronised circle→wave explainer, rendered
      unattended now that the queue has a consumer.
      The *human tweaks in the editor* half is **deferred** (2026-08-16): five
      runs say the value has come from the agent being able to check its own
      work, not from a human editing mid-build. The live-sync mechanism is
      verified separately by `check-live.ts`, so what is deferred is the
      workflow, not the capability.

Render queue: a **pull-based worker** (`render-worker.ts`) drains it as of
2026-08-16, so a submitted job now finishes unattended. Cloudflare Queues →
Containers remains the production shape and is still deferred; the job
lifecycle lives in the API either side of the claim, so swapping the producer
does not touch it.

## Phase 3: Agent sight → plans/007-agent-sight.md
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
- [x] `keyMoments(doc)` in packages/dsl — pure, the transition times worth seeing
- [x] `preview_frames` capability returning one labeled contact sheet — **free**
      (12 tiles in ~1.2s, versus ~3 min and ~61 credits for a render)
- [x] Full-res drill-down for a single suspicious frame
- [x] `check-preview.ts`; editor marks the same moments on the scrubber
- [~] Bind capture to the render backend — **no second renderer**. Both halves
      always drove the same `render.html` surface (run 4 verified export frames
      pixel-identical to preview tiles), and as of 2026-08-16 they are one
      process: `render-worker.ts` serves capture and drains the render queue.
      What remains is deployment — that process is still local, so an agent can
      see and export on this machine and nowhere else. Queues → Containers,
      with `PREVIEW_ORIGIN` as the only seam.
- [x] Use it in a milestone run — **done, run 4 (2026-08-16)**. 12 preview
      calls, 4 of which changed the video: the parabola's whole coordinate
      scale (the secant visually hugged the curve, invisible in any text
      tool), a `rotation` animation that reported success while being wrong
      by 25× (radians, not degrees), and two layout collisions. Sight now
      finds the class of bug that used to need a shell. See plans/007.

Preview frames are only trustworthy because of the purity invariant: a
preview frame is not an approximation of the export, it *is* the export.
Building an independent capture path would trade that away.

## Phase 4: Animation depth → plans/006-animation-depth.md
Promoted out of deferral 2026-08-16. It was parked because its own
verification step — "verify by screenshot at several camera angles" — assumed
a capability that did not exist, and because the binding constraint looked
like verification rather than visual vocabulary. Both premises have since
changed: Phase 3 shipped that capability, and five milestone runs have spent
their friction on *missing primitives* rather than on not being able to check
the output. Run 5 spent roughly 60% of its calls hand-rolling motion the scene
graph could have carried.

Ordered ahead of general video deliberately. Depth is work on the vertical
that already produces watchable videos, where each addition is checkable in
about a second; general video is a larger bet whose first item is a rights
decision. Doing the cheap, verifiable one first is not a change of direction —
plans/003 keeps its analysis and its place.

What already landed changes the shape of the remaining work: `add_group` gives
a real transform hierarchy, `path` + `plot_function` did the graph half, and
arc-length `write_on` is the beginning of path-following.
- [x] Camera on the scene (position/zoom/rotation), animated by ordinary tracks
      — a scene-level transform, now that per-node grouping exists. **Done
      2026-08-16**: `set_camera`/`move_camera`, camera moves are key moments so
      `preview_frames` samples them, and the editor draws a mini-map of the
      frame while scrubbing. Verified in pixels by `check-camera.ts`. It also
      turned up two defects in the sight path — the ink measurement counted the
      tile's own border, and the capture cache was keyed on the document's JSON
      *length*, so any length-preserving edit was served a stale frame. Both
      fixed; see plans/006
- [x] Structured primitives: `matrix`, `tokens`, cell-level addressing —
      **done 2026-08-16**. One node per grid, addressed as `{"rows":1}` /
      `{"cols":[0,2]}` rather than by coordinates; `morph_matrix` restates a
      grid and moves the cells that survived. Verified in pixels by
      `check-matrix.ts`, which proves *placement* by framing the camera on one
      row — Phase A paying for itself inside Phase B's test
- [x] Generalise stagger + element matching out of the glyph work in 002 —
      `writeGlyphAlphas` → `staggerAlphas(count, progress, {rank})` and
      `matchGlyphs` → `matchByKey(from, to, key)`. A `write` on a **group** now
      reveals its children one at a time as a free consequence
- [ ] Flows: arrows anchored to nodes, path-following along a `path`
- [ ] Axes, ticks and labels — the rest of the graph story `plot_function`
      started; hand-built today
- [ ] Code-block primitive with line-highlight animations
- [ ] Pseudo-3D by projection: optional `z`, camera yaw/pitch, depth cues.
      Last on purpose — the pseudo-3D-by-projection analysis in plans/006
      stands unchanged, but it is the least certain to earn its place

Done already, and kept here because it is the same plan: matched-glyph LaTeX
morphing, and the `path`/`plot_function` half of the graph primitives.

## Phase 5: General video → plans/003-general-video.md
Reinstated as the product direction 2026-08-15, and now sequenced after
animation depth (2026-08-16) rather than before it — the verification argument
that promoted it has been satisfied, and depth is the cheaper, more checkable
work. The direction is unchanged; only the order is.

This phase rides on the capture rework agent sight began: WebCodecs removes the
`page.screenshot()` round-trip, and asset proxies/thumbnails are the same
capability as a document contact sheet.
- [ ] Replace per-frame screenshot capture with WebCodecs (wins on the current path too)
- [x] Assets as first-class (registry) — done in Phase 2; proxies/thumbnails still to do
- [ ] `video` / `audio` node types; tracks and layering within a scene
- [ ] Multi-track timeline UI
- [ ] Ingest + analysis (fetch → transcode → STT → shot detection → segments)
- [ ] Decide the rights/ToS model **before** building the ingest fetcher
- [ ] Narration-anchored animation (sync to word timestamps)

## Phase 6: Real users — launch, and deliberately last
Moved to the end 2026-08-15. Auth, billing UI and a production deploy are
the work that only pays off once there is something worth signing up for,
and every hour spent on them is an hour not spent on the thing being sold.
Everything above is buildable against `DEV_ALLOW_ANON` and the internal
service key.

One consequence worth naming: plans/007 argues for agent sight partly
*because* this phase connects claude.ai over MCP OAuth, and that agent has
no shell. Deferring OAuth does not weaken the case — it means the shell-less
client arrives later, but the underlying problem is that looking at output
currently costs a 3-minute render and ~61 credits, which is true for an
agent holding a terminal too.

- [ ] MCP OAuth (workers-oauth-provider + Better Auth) — claude.ai connects
- [ ] Auth UI (sign up / sign in), remove DEV_ALLOW_ANON path from prod builds
- [~] Dashboard: project **list** done (`/` in the editor — agent-created
      projects were otherwise invisible, since the id only appears in a tool
      response). **Delete** done 2026-08-15 (`DELETE /api/projects/:id` with a
      full cascade — R2 bytes, rows, and the DO's document — plus a
      `delete_project` capability behind `confirm: true`); a create/delete
      **UI** and the credits page are still to do
- [ ] Deploy: workers, D1, R2, Containers; production secrets

## Parallel track: agent gateway → plans/008-mcp-gateway.md
Started 2026-08-15. Collapses the agent surface onto one implementation: a
capability catalog in the API worker behind three fixed MCP tools, so a new
verb costs one catalog entry instead of an endpoint plus a hand-written tool
plus a docs row — and a tool edit no longer needs a client restart.
- [x] Capability catalog in the API worker (25 entries) + shared services
- [x] Gateway endpoints: instructions / describe / execute (+ paid executor)
- [x] `apps/mcp` rewritten onto it: 807 lines → 295, five fixed tools
      (`instructions`, `describe`, `execute`, `execute_paid`, `ask_user`)
- [x] Re-run the milestone over the gateway — the feasibility gate. **Passed,
      run 4 (2026-08-16):** `instructions` called first unprompted, exactly
      **one** `describe` (batched, and for a question the summaries genuinely
      could not answer), and **zero failure loops** — 10 failed calls in 4
      distinct argument-shape mistakes, every one corrected on the next
      attempt from the error text alone. The generic executor is not costing
      reliability; the escape hatch stays unused. Two catalog *validation*
      bugs found — see plans/008.

## Parallel track: agent asks the human → plans/005-agent-questions.md
- [x] `ask_user` / `get_answer` / `record_answer`; questions ride the project
      DO and appear live in the editor, answerable there or relayed from chat

## Parallel track: desktop app → plans/004-desktop.md
Evaluated, deliberately not started. Everything that breaks on the server
(no H.264 encoder, no GPU, SwiftShader) is abundant on the desktop, and
local rendering inverts the cost model. Revisit when the general-video
direction is confirmed, container render cost becomes a constraint, or users
prove unwilling to upload source footage.

