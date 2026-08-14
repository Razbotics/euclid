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

## Phase 3: TTS  (status: done)

Ordered by dependency. 3a is a prerequisite that the roadmap didn't name:
`NarrationAudio.assetId` has been in the schema since Phase 0, but nothing
ever resolved an assetId to bytes.

### 3a. Asset registry (status: done — blocks everything below)
There was no asset storage layer. `schema.sql` had no `assets` table and the
API had no asset route; the R2 `ASSETS` binding was used only for `renders/`
keys. Built general rather than narration-shaped because Phase 4 of the
roadmap lists "assets as first-class" anyway — same work, no migration later.

- [x] `assets` table: `id, project_id, kind, r2_key, mime, bytes,
      duration_sec, created_at`, indexed on `(project_id, created_at DESC)`
- [x] `POST /api/projects/:id/assets` (internal-key only) — body is raw
      bytes, writes R2 under `assets/<projectId>/<assetId>`, inserts the row,
      returns `{ assetId }`
- [x] `GET /api/assets/:assetId` — owner session **or** internal key (the
      renderer needs it); streams from R2 with the stored mime
- [x] Verify: upload → fetch → byte-identical, and a non-owner gets 403

Verified by `apps/renderer/src/check-assets.ts` against a live API: 64KiB of
random bytes round-tripped byte-identical (compared with `Buffer.equals`, not
just by length), stored mime served back, owner reads 200, a different user
403, unknown asset 404, sessionless upload 403, unknown `kind` 400. D1 shows
exactly one row for the six requests — the rejected uploads stored nothing —
and `duration_sec` persists as a REAL (`3.018`, not truncated to an int).

Two decisions worth not re-deriving:
- **Bytes stream straight to R2** (`ASSETS.put(key, c.req.raw.body)`) rather
  than being buffered, so a large clip never has to fit in worker memory. The
  size for the row comes from the returned `R2Object.size`.
- **The row is written only after the bytes land**, and a zero-byte put is
  deleted before any row exists — a document must never hold an `assetId`
  that resolves to nothing.

### 3b. TTS adapter + provider (status: done)
- [x] `TtsProvider` interface in `apps/api/src/tts.ts`:
      `synthesize({ text, voiceId }) → { audio: ArrayBuffer, mime,
      durationSec, words: NarrationWord[] }`
- [x] ElevenLabs implementation (see decision below)
- [x] `ELEVENLABS_API_KEY` added to `apps/api/src/env.ts`; confirmed
      `scripts/sync-env.mjs` writes it into `apps/api/.dev.vars`

Verified by `apps/renderer/src/smoke-tts.ts`, which is **free to run** —
the character→word grouping is pure, so it is tested against recorded
provider output and costs nothing. Covered: words group on whitespace,
sentence-final punctuation stays attached, word `end` is the last character's
end, timings are monotonic and non-overlapping, runs of whitespace collapse
without emitting empty words, empty and ragged alignments yield no NaN
timings, blank text fails before any network call, and the resulting timings
drive an exact (`estimated: false`) caption cue with no other change.

`--live` adds one small real synthesis to confirm the provider still returns
this shape. Measured: `We rearrange both sides.` → 1.625s, 4 words, 27KiB
mp3, last word end equal to the reported duration.

Three decisions worth not re-deriving:
- **The adapter uses web-standard APIs only** (`fetch`, `atob`) and imports no
  Cloudflare types. That is what makes the provider seam real rather than
  nominal, and it is why `apps/renderer` can import and test the adapter
  directly despite the two packages having different tsconfig `types`.
- **Duration comes from the alignment, not from probing the mp3.** It is
  already exact for the only question it answers (does this speech fit the
  scene?) and needs no decoder in the worker. It measures end-of-speech, so
  it can sit a few ms under the file's true length — muxing uses the real
  file, so that difference never reaches the output.
- **ElevenLabs mp3 output begins with an ID3v2 tag**, not a bare frame sync.
  A byte-level check that assumes `0xFF Ex/Fx` will fail on valid audio.

### 3c. Generation endpoint + MCP tool (status: done)
Synthesis runs in the **API worker**, not the MCP worker: the API already
owns credits, R2, and the DO forward path, so the provider key lives in
exactly one place.

- [x] `POST /api/projects/:id/scenes/:sceneId/narration/generate` — price
      the text, check balance, debit, synthesize, store the asset, submit
      `narration.set` as a `system` actor, refund on failure
- [x] `generate_narration(projectId, sceneId, text?, voiceId?)` MCP tool
- [x] Overflow handling per the decision below
- [x] `update_scene` MCP tool — **not originally planned**. The overflow
      warning tells the agent to extend the scene, but no tool could change a
      scene's duration: `op.updateScene` existed in the DSL with nothing
      exposing it. The advice would have been unfollowable.
- [x] Fix two stale tool descriptions: `set_narration` claimed audio is
      "generated at render time" (it isn't — generation is explicit), and
      `render_video` claimed it charges "per second of video + TTS minutes"
      (`/render` charges video seconds only)

**Pricing is on characters, not on the resulting audio** — `ttsCost(text)` in
`packages/dsl/src/limits.ts`, via `TTS_CHARS_PER_MINUTE = 900`. This is what
makes an up-front debit honest: the price is knowable before synthesis, can be
quoted in a 402, and needs no post-hoc reconciliation. It also tracks how TTS
providers actually bill (per character). Minimum 1 credit.

Verified by `apps/renderer/src/check-narration.ts` against a live API
(**spends credits** — two short real calls). Covered: quoted cost equals
`ttsCost()`, balance falls by exactly that, the `system` op reaches the
document with finite ordered word timings, the asset is fetchable and is real
mp3, captions come back `estimated: false`, the overflow case warns while
keeping the audio, `update_scene` actually fixes it, and the 400/402/404 paths
charge nothing. Ledger shows clean `tts:<id> (<sceneId>)` debits with no
spurious refunds.

`--refund` covers the provider-failure path separately (run with a
deliberately broken key; costs nothing): 502, credits returned, balance
unchanged, and — importantly — **no audio reference written to the
document**, so a failed synthesis can't leave a dangling assetId.

The agent path was exercised through the MCP worker itself, not just the API:
`create_project → add_scene → set_narration → generate_narration →
get_captions` returned a word-accurate cue (`00:00:00,000 → 00:00:01,347`)
where the estimated version would have stretched that sentence across the
whole 10s scene. 19 tools now registered.

### 3d. Verification (status: done)
- [x] `smoke-tts.ts` in `apps/renderer/src`, matching the existing
      `smoke-*`/`check-*` convention
- [x] Captions upgrade themselves: `?format=json` cues flip from
      `estimated: true` to `false` after generation, with no other change
- [x] Credits: balance debited by the metered amount; a forced provider
      failure refunds it
- [x] Overrunning cues no longer bleed into the next scene (see below)

**Known gap, accepted:** if `storeAsset` succeeds but the op submission then
fails, credits are refunded but the stored asset row and R2 object remain,
unreferenced. That is wasted storage, not a correctness bug — the failure
mode a document could actually be hurt by (a dangling `assetId` inside the
document) is prevented, and verified. Worth a sweep job if it ever shows up
in practice; not worth machinery now.

### Design decisions (already made — don't re-derive)

**The DSL already models this.** `NarrationAudio { assetId, durationSec,
words[] }` and the `narration.set` op exist in `packages/dsl`; `ActorSchema`
already has a `system` actor. Writing generated audio back into the document
needs no schema change.

**Word-level timestamps are the selection criterion** for the provider, not
voice quality. Timestamps are what later allow animations to anchor to
narration beats (Phase 4 of the roadmap). Put the provider behind the adapter
so the choice stays reversible.

**Provider: ElevenLabs** — `POST /v1/text-to-speech/{voice_id}/with-timestamps`.
An earlier draft of this plan claimed ElevenLabs was a premium-voice upgrade
that lacked timestamps and pointed at OpenAI/Azure instead. That was wrong,
and a spike against the real key disproved it: the endpoint returns
`alignment.{characters, character_start_times_seconds,
character_end_times_seconds}`. Grouping characters on whitespace yields the
`{word, start, end}` shape `NarrationAudio` already declares, and the last
character's end time gives `durationSec` for free — no audio probing.
Measured on "Consider the equation. We rearrange both sides." →
`[["Consider",0,0.37],["the",0.42,0.49],["equation.",0.53,1.07],
["We",1.39,1.53],…]`, 3.018s total. It is also the only TTS key provisioned
in `.env`.

Two consequences worth knowing before writing the adapter:
- Derived words keep their trailing punctuation (`"equation."`), which is
  exactly what `cuesFromWords` tests for (`/[.!?]$/`) to break cues at
  sentence ends. The caption layer needs no change to sharpen.
- The response is JSON with base64 audio, so the whole clip must be buffered
  and decoded in the Worker. Fine at these sizes (60s of 128kbps mp3 ≈ 960KB,
  ~1.3MB base64) but it rules out streaming the synthesis straight to R2.

**Generation is explicit, not implicit.** `generate_narration` synthesizes,
stores audio, and submits a `narration.set` op with the audio attached — as a
`system` actor. Rationale: the op flows through the Durable Object like any
other mutation, so the editor sees narration appear live, and the agent can
inspect the real duration before choreographing animation against it.
Generating silently at render time would hide that from both.

**Credits:** debit TTS minutes at generation time (`CREDIT_COSTS.ttsPerMinute`
already exists), the same up-front pattern as renders. Refund on failure.

**Scene vs narration duration (the open question, now resolved).** If a
12-second narration lands in an 8-second scene: store the audio, write the
op, and return a prominent mismatch to the agent — both durations plus the
exact remedy (`set_scene_duration('s1', 12.4)`).

This is a deliberate deviation from this plan's earlier recommendation of
"reject the op". Rejection sounded cleaner, but the mismatch is only knowable
*after* synthesis, so rejecting discards audio the user has already been
billed for and the retry bills them again. Writing the op keeps the agent in
control (it still chooses whether to rewrite the script or the timing)
without charging twice. Auto-extending was rejected outright: it silently
shifts a timeline the agent already choreographed keyframes against, leaving
dead air after the existing animation.

This decision has one consequence that was predicted and then confirmed as a
real bug: because the document can now hold audio longer than its scene,
`documentCues` emitted cues past the scene end. Measured before the fix, a
3.2s narration in a 1s scene produced a cue spanning `[0 → 3.20]` while the
next scene's cue began at `1.00` — **two subtitles on screen at once**.
`clampToScene` in `packages/dsl/src/captions.ts` now trims cues to the scene
boundary and drops any that start beyond it; `smoke-captions.ts` guards it.

Phase 4 inherits the same question for audio: the mux must decide whether
overrunning narration is cut at the scene boundary or allowed to bleed over
the next scene's frames. Captions now assume the former.

### Flagged, not blocking

`CREDIT_COSTS.ttsPerMinute = 10` prices TTS at $0.10/min (`PACKS` sets
1 credit ≈ $0.01). A minute of speech is roughly 850–900 characters, which
costs materially more than that at ElevenLabs list rates — this looks
under-cost. It doesn't block the milestone (first-party key, own usage), but
it needs a real pricing pass before anyone else can spend credits, alongside
the Phase 3 work in `000-roadmap.md`.

## Phase 4: Audio in the export  (status: done)
- [x] Renderer fetches per-scene narration audio via `GET /api/assets/:id`
      with the internal key
- [x] Offset each clip to its scene's global start; mux with the frame
      stream in the existing ffmpeg invocation
- [x] Scenes without narration still need their silence — clips are laid on a
      timeline with `adelay`, not concatenated
- [x] Verify A/V sync on a multi-scene project

Placement logic lives in `apps/renderer/src/mux.ts` (`planNarration`,
`buildFfmpegArgs`), separated from downloading so offsets and trims are
testable without a render.

**Overrunning narration is cut at the scene boundary**, matching what captions
do. The alternative — letting it bleed over the next scene's frames — would
put one scene's voice on another's visuals with nothing in the editor to show
it. `playSec = min(audio.durationSec, scene.duration)`, applied via `atrim`.

The filter graph, and why each piece is load-bearing:
- `aformat` first — `amix` misbehaves when inputs disagree on sample rate or
  channel layout.
- `adelay=<sceneStartMs>:all=1` places the clip; silence between clips is a
  consequence of placement, not padding files.
- `amix=...:normalize=0` — **without `normalize=0` amix divides by the input
  count**, so narration would get quieter the more narrated scenes a project
  has.
- `apad` + `-shortest` — the audio track spans the whole video and ends with
  it; without `apad` the file would stop at the last word, truncating a
  trailing silent scene.

Verified two ways. `smoke-mux.ts` is free (pure planning + argument
construction): only scenes with generated audio become clips, offsets equal
scene starts, overrunning audio is cut, clips never overlap, and a document
with no narration still produces the old simple silent command with no audio
stream.

`check-mux.ts` renders for real (**spends credits**, needs ffmpeg + dev
servers) against a project with a deliberately **silent middle scene**, which
is what makes sync objectively measurable rather than a matter of listening.
Measured: 8.00s h264+aac, `silencedetect` finds quiet across `[1.30 → 5.05]`
spanning the silent scene, and speech resumes at **5.05s against an expected
5.00s** — a clip placed at the wrong offset moves that boundary and fails.

## Phase 5: The milestone  ← NEXT
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
