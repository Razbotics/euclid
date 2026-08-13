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

## Phase 2: Close the render job loop (status: done)
`POST /render` debited credits and created a job row that nothing consumed —
a user could pay and receive nothing. Now the endpoint honors what it charges.
- [x] Renderer uploads the finished MP4 to R2 under the job's key
      (`PUT /api/jobs/:id/output`, internal-key only)
- [x] Renderer PATCHes `render_jobs` status (queued → rendering → done/failed)
- [x] API exposes a download URL for a finished job, streamed from R2
- [x] Refund credits automatically when a job fails
- [x] `get_render_status` MCP tool returns the URL when ready

Verified end-to-end: 100 credits → job costs 8 → balance 92 → render →
`done` with a download URL → downloaded file is byte-identical (91,053 B) and
probes as 1920x1080, 480 frames, 8.000s. Failure path: balance 84 → PATCH
failed → refunded to 92; a second failed PATCH returns `applied:false` and
does **not** double-refund; a terminal job cannot be revived to `done`.
Ledger shows `-8 render:<id>` then `+8 refund:<id> (simulated crash)`.

## Captions / subtitles (status: done ahead of TTS)
Built early because cues are a pure function of the document and degrade
gracefully — they work now from narration text and sharpen automatically
when TTS word timings arrive.
- [x] `documentCues(doc)` in `packages/dsl/src/captions.ts`, both fidelities
- [x] SRT + VTT formatters, subtitle conventions (~84 chars, ≤6s, sentence breaks)
- [x] `GET /api/projects/:id/captions?format=srt|vtt|json`
- [x] `get_captions` MCP tool (free — no credits)
- [x] Verified: `smoke-captions.ts` (offsets, ordering, formats, empty doc)
      plus live API and MCP round-trips
- [ ] Burn-in option at render time (deferred — sidecar file first; decide
      after seeing whether users want hardcoded captions)

## Phase 3: TTS  ← NEXT
- [ ] `TtsProvider` adapter interface (synthesize → audio + word timings)
- [ ] First provider, chosen for word-level timestamps
- [ ] Audio stored in R2; `narration.audio` (assetId, duration, words)
      written back into the doc as an op, so the document stays the single
      source of truth
- [ ] Credit metering for TTS minutes

### Design decisions (already made — don't re-derive)

**The DSL already models this.** `NarrationAudio { assetId, durationSec,
words[] }` and the `narration.set` op exist in `packages/dsl`; `ActorSchema`
already has a `system` actor. Writing generated audio back into the document
needs no schema change.

**Word-level timestamps are the selection criterion** for the provider, not
voice quality. Timestamps are what later allow animations to anchor to
narration beats (Phase 4 of the roadmap). OpenAI or Azure both expose them;
ElevenLabs is the premium-voice upgrade later. Put it behind the adapter so
the choice is reversible.

**Generation is explicit, not implicit.** Add an MCP tool
`generate_narration(projectId, sceneId)` that synthesizes, stores audio in
R2, and submits a `narration.set` op with the audio attached — as a `system`
actor. Rationale: the op flows through the Durable Object like any other
mutation, so the editor sees narration appear live, and the agent can
inspect the real duration before choreographing animation against it.
Generating silently at render time would hide that from both.

**Credits:** debit TTS minutes at generation time (`CREDIT_COSTS.ttsPerMinute`
already exists), the same up-front pattern as renders. Refund on failure.

### Open question to resolve early

Scene duration vs narration duration. If a 12-second narration lands in an
8-second scene, the options are: (a) auto-extend the scene, (b) reject the
op and make the agent choose, (c) let it clip. Recommendation is (b) —
return the mismatch to the agent as a tool error with both durations, since
the agent is the one who can rewrite either the script or the timing. Decide
this before wiring the renderer, because Phase 4 assumes audio fits.

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

## Notes / gotchas
- Client-facing URLs must be built from `PUBLIC_API_ORIGIN`, not from the
  request. Service-binding calls (MCP worker → API) arrive with the internal
  hostname, so deriving the origin produced an unusable `https://api/...`
  download link for agents. Caught only by fetching the URL an agent actually
  receives.
- Refund idempotency comes from the SQL, not application logic: the UPDATE
  matches only non-terminal rows and the refund is gated on `meta.changes`,
  so duplicate or retried callbacks can't pay a user twice.

## Known issues
- Capture speed is bounded by one `page.screenshot()` round-trip per frame.
  If it becomes painful, the fix is a CDP screencast or batching frames via
  `canvas.toBlob` — measure before optimizing; correctness of the output
  matters more than render speed right now.
