# 002 — Render pipeline & narration (status: in progress)

Goal: the v1 milestone — an agent builds a 60-second narrated
equation-morph video over MCP, a human tweaks it in the editor, and it
exports to a downloadable MP4 with audio.

Sequencing principle: prove the unexecuted path before adding new ones.
Everything below assumes the renderer works, so it gets verified first.

## Phase 1: Silent export (status: done)
- [x] Run `render.ts` against a real project end-to-end
- [x] Verify container metadata (1920x1080, 60fps, 480 frames, 8.000s)
- [x] Verify animation is actually in the file — frames extracted from the
      MP4 show write-on at 50% at t=1.5s and the completed position move at
      t=4.6s, matching the document exactly

Measured: 480 frames in ~29s (~16.5 fps capture, ~3.6× realtime). A 60s
video costs ~3.6 min; the 10-min ceiling costs ~36 min. Acceptable for v1,
but see "Known issues" before scaling.

## Phase 2: Close the render job loop
`POST /render` currently debits credits and creates a job row that nothing
consumes — a user can pay and receive nothing. This phase makes the endpoint
honor what it charges for.
- [ ] Renderer uploads the finished MP4 to R2 under the job's key
- [ ] Renderer PATCHes `render_jobs` status (rendering → done/failed)
- [ ] API exposes a download URL for a finished job
- [ ] Refund credits automatically when a job fails
- [ ] `get_render_status` MCP tool returns the URL when ready

## Phase 3: TTS
- [ ] `TtsProvider` adapter interface (synthesize → audio + word timings)
- [ ] First provider, chosen for word-level timestamps
- [ ] Audio stored in R2; `narration.audio` (assetId, duration, words)
      written back into the doc as an op, so the document stays the single
      source of truth
- [ ] Credit metering for TTS minutes

## Phase 4: Audio in the export
- [ ] Renderer fetches per-scene narration audio
- [ ] Offset each clip to its scene's global start; mux with the frame
      stream in the existing ffmpeg invocation
- [ ] Verify A/V sync on a multi-scene project

## Phase 5: The milestone
- [ ] Agent builds the full 60s narrated equation-morph video over MCP
- [ ] Human tweak in the editor lands mid-build (live sync)
- [ ] Export, download, watch — and record what the result actually looks
      like, honestly

## Deferred on purpose
- **Cloudflare Queues + Containers.** The flagged infra risk, and it's
  orchestration for a pipeline that hasn't yet proven it makes a *good*
  video. Manual `render.ts` invocation carries the milestone; automate once
  the output is worth automating.
- **MCP OAuth.** Gates other people using this, not the milestone. The
  internal-key path works for first-party testing.

## Known issues
- Capture speed is bounded by one `page.screenshot()` round-trip per frame.
  If it becomes painful, the fix is a CDP screencast or batching frames via
  `canvas.toBlob` — measure before optimizing; correctness of the output
  matters more than render speed right now.
