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

## Phase 4b: Editor narration preview  (status: done)

Not originally planned. Audit before the milestone found the editor had **no
audio at all** — narration's only presence was a yellow dot in the timeline.
The milestone as written would still have passed (its editor step only tests
live sync), but its actual purpose is judging whether the video is *good*, and
tuning narration timing through a 30-second export cycle per iteration is not
that.

- [x] `planNarration` moved to `packages/dsl` so the editor and the export
      derive identical offsets and trims
- [x] `NarrationTrack` — one `<audio>` per narrated scene, driven off the
      existing rAF playback clock
- [x] `CaptionOverlay` — `documentCues` rendered over the canvas, dimmed and
      italic when `estimated`
- [x] Mute and CC toggles in the timeline controls
- [x] Inspector narration panel: script, duration, word count, and an overrun
      warning with a "fit scene to narration" button

Decisions worth not re-deriving:
- **Audio lives in the browser shell, never in `packages/engine`.** The
  sampler must stay a pure function of (document, time); playback is neither.
  The engine is untouched, so preview and export remain pixel-identical.
- **Re-seek only past 0.25s of drift.** Once started, the audio element keeps
  better time than a rAF loop; correcting every frame makes it stutter. We
  intervene only after a genuine slip (scrub, stall, tab throttle).
- **The script is read-only in the editor.** Rewriting it there would leave
  the generated audio and word timings describing text that no longer exists,
  and regenerating costs credits — that belongs to the agent. What the editor
  *can* usefully fix is the overrun `generate_narration` reports but doesn't
  enforce, and that's an ordinary `updateScene` op.

Verified by `check-narration-ui.ts` (**spends credits**). The load assertion is
the important one: assets are owner-scoped and served from a different origin,
so the elements carry `crossOrigin="use-credentials"` — if CORS or the cookie
path were wrong the UI would look perfect and simply never make a sound.
Measured: both elements reach `readyState 4` with decoded durations matching
the TTS output (1.39s / 2.93s), an exact non-estimated caption renders at the
playhead, the fitting scene shows no warning, the overrunning one is flagged
with the right delta, and the fit button extended a 1s scene to 2.7s through
the normal ops path.

## Phase 5: The milestone  (status: in progress)
- [x] Agent builds the full 60s narrated equation-morph video over MCP
- [ ] Human tweak in the editor lands mid-build (live sync)
- [x] Export, download, watch — and record what the result actually looks
      like, honestly

### The run (2026-08-15)

"The Quadratic Formula, Derived" (`daca6a6a`), built entirely over MCP:
3 scenes (hook / derivation / finale), 112 words of narration, one latex
node morphing through the whole completing-the-square chain. 64 credits
total (9 TTS + 55 render). 55.0s h264+aac 1080p60, 2.1MB.

The order that made it work: `set_narration` → `generate_narration` →
read word timings → size scenes → choreograph. Every morph start was
placed on a measured word onset (e.g. the completed-square morph starts
at 15.8s, on "add it to both sides"). Verified before rendering by
screenshotting the real doc through render.html; verified after by
extracting frames from the downloaded MP4 and running `silencedetect`:
every narration clip lands within ~40ms of its scene start.

### What the result actually looks like (recorded honestly)

Verdict: a *decent* explainer — coherent, correct, synced — at the level
of "clean lecture slides with dissolve transitions", not yet 3b1b.

Good: math legible and correct at every step; beat-accurate choreography
(morphs land exactly on the spoken operation); exact captions; clean
encode; A/V sync measured, not eyeballed.

Wrong or weak, in rough order of impact:
1. ~~**texMorph is a cross-fade, not a glyph-correspondence morph.**~~
   **fixed.** Mid-morph frames showed both equations overlapped at
   partial opacity, and unchanged terms drifted because each form was
   centred independently. Glyphs are now paired by longest common
   subsequence of their MathJax `data-c` codes and the shared ones move;
   only new or removed glyphs fade, staggered so nothing arrives while
   something is still leaving. Verified by screenshot through the export
   surface: at the midpoint of the demo's `a²+b²=c²` → `c=√(a²+b²)`
   morph, `a² + b²` is fully opaque and moving while `= c²` has gone and
   `c = √` has not yet appeared — no muddy overlap. See
   [architecture.md](../architecture.md#equation-morphing).
2. ~~**No emphasis primitive.**~~ **fixed.** ~5s of static screen while
   the narration dwelt on one term, and nothing could mark it. A
   `highlight` transition now boxes or underlines a node — or one term
   inside an equation, named by its LaTeX: `highlight(tex: "b^2")`
   renders the fragment, finds its glyph-code run in the equation, and
   marks exactly those glyphs. The agent never needs screen
   coordinates, which is why no existing tool could do this. The pulse
   ramps in, holds, and ramps out rather than wiping. Verified by
   screenshot: a gold box around `b²` alone in `a² + b² = c²`.
3. ~~**write_on is a left-to-right wipe**~~ **fixed.** One mask edge swept
   across, slicing glyphs in half as it passed — fine on a line of text,
   mechanical on a wide equation. With glyph data available a write now
   reveals symbol by symbol in reading order, glyphs overlapping slightly
   so it flows rather than ticks. Verified by screenshot: mid-write,
   `a² +` is complete, `b` bright, `=` fainter and `c` just emerging,
   with no glyph cut in half. Falls back to the mask wipe for non-latex
   nodes and whenever glyph data isn't available.
4. ~~**Dead air is the cost of scene-sized narration.**~~ **addressed.**
   3.5s of silent hold after the derivation, 4.5s on the end card (~15%
   of runtime silent), and nothing in the pipeline reasoned about the
   *gap* between narration and scene end. `scenePacing`/`pacingSummary`
   (packages/dsl) now compute it and `outlineDoc` reports it, so
   `get_project` shows `8.3s silent (15%)` and flags any tail over
   `LONG_TAIL_SEC` as `(long)` — the numbers reproduce the milestone's
   manual finding exactly. `fit_scene_to_narration(sceneId, tailSec)`
   is the one-call fix; run on the finale it took the project from 15%
   to 10% silent. Deliberately *visible, not enforced*: a held beat is
   sometimes right, so the agent (or the human, via `ask_user`) decides.
5. ~~Caption cues split mid-phrase at the 84-char limit~~ **fixed.**
   Greedy filling produced "…add it to both / sides." — 79 characters
   then 6. `balancedCuts` in `captions.ts` now splits a sentence into as
   few even pieces as the limits require and nudges each cut to a nearby
   clause boundary. On the milestone's own narration the two bad splits
   became 49/36 and 42/52, both breaking at commas, and line-length
   spread fell from 73 to 31. Both fidelities share the helper, so
   estimated cues read the same way as word-timed ones.
6. The scene-2→3 cut silently rewrites the two-fraction form into the
   combined single-fraction formula; narration never mentions the step.
   Cross-scene continuity is on the agent, and nothing checks it.

None of 1–4 could be fixed by iterating on the document; they were engine
and tool-surface work. That was the milestone's actual finding: the
pipeline reliably produces a *correct, synced* video, and the ceiling on
*beauty* was the morph/reveal primitives, not the orchestration.

**All six are now addressed** (plus the `animate` bug in Notes below).
1, 2 and 3 turned out to be one piece of work rather than three: glyph
extraction, built for the morph, is also what locates a term to highlight
and what lets a write reveal symbol by symbol. A re-run of the milestone
is the honest way to find out whether the result now reads as *good* —
the flaws that remain will be different ones.

### The re-run (2026-08-15)

"Euler's Identity, in One Minute" (`9a78aa67`) — a different topic on
purpose, so the judgment isn't anchored on the quadratic video. 3 scenes
(hook / substitution derivation / five-constants finale), 130 words, one
latex node morphing e^{iθ}=cosθ+isinθ down to e^{iπ}+1=0, with the cut
into the finale carrying the *identical* form (old finding 6). 68 credits
(9 TTS + 59 render). 58.98s h264+aac 1080p60, 1.96MB.

New-tool usage, and what it changed about the build:
- Scenes were sized by `fit_scene_to_narration` (0.8s / 1.2s / 2.5s
  tails), not guessed; the finale's 0.39s overrun warning was cleared by
  the same call. `get_project` reported 8% silence (first run: 15%), and
  its one `(long)` flag was the deliberate end-card hold.
- 8 highlights: cosπ and sinπ boxed while the narration dwells on each
  (right before each collapses), the five constants boxed in sequence as
  the finale names them, and a closing whole-equation underline.
- `ask_user` posed the end-card hold length (tight/standard/long) with
  the editor seeked to the moment; the question stayed unanswered, so the
  stated default (2.5s) shipped and the decision is still open in the
  project. The loop works; it just needs a human present.

**Bug found and fixed mid-run: only one highlight per node survived.**
The MCP tool stripped every existing highlight before appending
(`filter(t => t.type !== 'highlight')`), and the engine sampled
`transitions.find(type === 'highlight')` — first one, regardless of `t`.
Single-highlight verification passed while the tool's actual use case (a
sequence) was impossible; the five-constants finale is what exposed it.
Fixed both ends: the sampler picks the highlight whose window contains
`t` (still a pure function of document and time), and the tool replaces
only highlights *overlapping* the new window, so sequences accumulate
and re-calling to adjust one still replaces it. `pnpm -r typecheck` and
`smoke.ts` green; docs updated (architecture.md, mcp-tools.md).

### What the re-run actually looks like (recorded honestly)

Verdict: **genuinely good** — the engine work moved it from "clean
slides with dissolves" to something that reads as deliberate animation.
The glyph reveal syncs with the narrator *reading* the formula, shared
glyphs hold still through morphs, and the gold boxes land exactly on the
term being spoken. Measured A/V offsets ≤ ~20ms again; the one mid-scene
silence flagged by `silencedetect` is the narrator's own breath between
sentences, not a placement error.

Remaining flaws, in rough order of impact — polish now, not correctness:
1. **Mid-morph the equation is briefly incomplete.** Staggered fades
   mean θ leaves before π arrives, so for ~0.4s the equation reads
   "e^i = cos + i sin" with holes. Honest trade — far better than the
   old double-exposure — but a careful viewer sees a momentarily wrong
   equation. A per-glyph *slide* from old to new position (true
   correspondence for changed glyphs, not leave-then-arrive) is the next
   step toward 3b1b.
2. **Highlight boxes inherit glyph size.** Boxing `i` or `π` inside the
   exponent of e^{iπ} draws a box a few pixels tall — precise but
   visually underweighted for a finale beat that names each constant. A
   minimum visual size, or a glow/scale emphasis style, would carry
   better at 1080p viewing distance.
3. **Nothing connects a highlight to *why*.** The five constants get
   boxes while the narration explains each, but on screen there is no
   label — a small callout ("growth", "rotation", …) under each would be
   the 3b1b move. That's a new primitive (labeled callouts), not a fix.
4. Caption cue 4/5 splits "e to the i / theta" — `balancedCuts` nudges
   to clause boundaries, but a long clause-free sentence still breaks
   mid-phrase. Only visible failure of the caption fix.
5. The hook is static from 2.5s to 5.9s while the narration muses —
   acceptable breathing room, but a slow drift or scale would keep it
   alive. No pacing signal exists for *visual* stillness, only audio.

The pipeline now makes a good sixty-second video. The distance to
*beautiful* is: per-glyph motion paths in the morph, visual weight
options for emphasis, and labeled callouts.

### The third run (2026-08-15)

"Bayes' Theorem, in One Minute" (`9843f817`) — a third topic on purpose, and
conditional probability rather than an algebra chain, so the judgment isn't
anchored on either earlier video. 3 scenes (hook / derivation / four names),
170 words, one latex node carrying `P(A \cap B)` through the two-way count
into Bayes' theorem. 76 credits (15 TTS + 61 render), against a ~930 budget.
60.9s h264+aac 1080p60, 2.6MB. `pnpm -r typecheck` green.

New-tool usage, and what it changed about the build:
- `ask_user` carried a real fork rather than a detail: derive symbolically, or
  teach it through a concrete disease-test number. Asked **before any scene
  existed**, blocked, answered in chat, `record_answer` stored it `via: agent`.
  First run where the loop actually closed with a human — the Euler question
  shipped unanswered. Asking early is the right shape: the answer decided
  scene 2 entirely, so guessing would have thrown away real work.
- `fit_scene_to_narration` sized all three scenes (0.5 / 0.9 / 2.2s tails) and
  cleared scene 3's 1.85s overrun with the same call. `get_project` reported
  **6% silence** (15% → 8% → 6% across the three runs); its one `(long)` flag
  is the deliberate end-card hold.
- 8 highlights, 5 of them accumulating on the finale's single node, every one
  located by LaTeX fragment (`P(B \mid A)`, `P(A)`, `P(B)`). The re-run's
  multi-highlight fix holds under a longer sequence.
- **Labeled callouts** — the primitive the re-run listed as missing — were
  composed by hand from four text nodes cross-fading under the boxed term.
  They read well (see below), but only because each term's x-position was
  measured off a screenshot and hardcoded, which is exactly the
  coordinate-hunting `highlight` exists to avoid.

The milestone's second task (**human tweak in the editor lands mid-build**) is
still unproven: the human answered in chat, not by editing, so live sync was
not exercised. It stays `[ ]`.

**Two tool-surface defects found; neither blocked the run.**
1. **`update_node` silently drops unknown patch keys and reports success.**
   Position is stored as `{position:{x,y}}`, but `add_text`/`add_latex` *take*
   `x`/`y` — so the natural patch `{"x":1190}` merges, gets stripped by Zod's
   default unknown-key stripping in `NodeSchema.safeParse`
   (`packages/dsl/src/reducer.ts:116-125`), writes the node back unchanged,
   and returns `updated`. Seven position edits did nothing and only a
   screenshot caught it. This is a genuine trap, not a doc gap: the tool that
   *creates* a node and the tool that *moves* it disagree about the shape.
2. **`morph_latex` is append-only.** No way to revise or delete a queued
   morph, unlike `highlight` (replaces an overlapping window) and `animate`
   (replaces later keyframes). Restructuring the final morph meant rewriting
   the node's whole `transitions` array through `update_node`.

### What the third run actually looks like (recorded honestly)

Verdict: **good — better than the Euler run in the finale, worse in one
morph.** The finale is the strongest thing the pipeline has produced: the
formula carries across the scene cut unchanged, rises and scales as it is
named, and then each of the four terms is boxed with its technical name
fading in directly beneath it, on the word that describes it. That sequence
reads as deliberate teaching, not as slides.

Flaws, in rough order of impact:
1. **Morph quality depends on whether the layout is rearranged, not on the
   morph.** *Additive* morphs are excellent: at the midpoint of
   `P(A \cap B)` → `P(A \cap B) = P(A)P(B \mid A)`, the left side is fully
   opaque and perfectly still while the new right side staggers in — nothing
   overlaps, nothing is missing. But collapsing the equality into a fraction
   re-lays-out every glyph, and for ~0.6s the frame is genuinely illegible:
   two `P(` forms overlapping each other at partial opacity, no `=`, no
   fraction bar. Splitting it into two morphs (chain → two-way equality →
   fraction) bought a clean legible resting state in between and roughly
   halved the mess, but did not remove it. This sharpens the re-run's finding
   1: not "briefly incomplete" but **briefly overlapping** — the
   double-exposure the matched-glyph morph was built to kill returns whenever
   source and target layouts don't correspond. Per-glyph motion paths are
   still the fix; the LCS pairing is what needs the work, not the fade.
2. **Nothing connects a highlight to a label except arithmetic the agent does
   by hand.** The callouts land correctly only because positions were read
   off a rendered frame. A `label` option on `highlight` — same glyph lookup,
   text anchored under the located run — would make this a one-call move and
   remove the only place in the run where the agent needed screen
   coordinates.
3. **Whole-node `underline` is blunt.** A thick, saturated bar set well below
   the equation; it reads as a divider rule rather than emphasis. The re-run
   complained that boxes were too *small* on exponents; the underline has the
   opposite problem.
4. In numerator highlights the box's bottom edge lands on the fraction rule —
   a few pixels of collision. Cosmetic.
5. Captions: 18 cues, every one a complete sentence, none split mid-phrase.
   Honest caveat — **no sentence exceeded the 84-char limit**, so
   `balancedCuts` never had to split anything. The re-run's caption flaw did
   not recur, but it also was not tested.

Measured, not eyeballed: `silencedetect` on the downloaded MP4 puts scene 2's
audio 19ms after its scene boundary and scene 3's 38ms after; every other
detected silence matches a sentence gap in the stored word timings. The
download URL returned by `get_render_status` was fetched as an agent would
and served the 2.6MB file.

The distance to *beautiful* is unchanged from the re-run and now better
localised: **glyph correspondence through a layout change** is the one piece
of engine work that would lift every derivation video at once.

## Deferred on purpose
- **Cloudflare Queues + Containers.** The flagged infra risk, and it's
  orchestration for a pipeline that hasn't yet proven it makes a *good*
  video. Manual `render.ts` invocation carries the milestone; automate once
  the output is worth automating.
- **MCP OAuth.** Gates other people using this, not the milestone. The
  internal-key path works for first-party testing.

## Notes / gotchas
- ~~**`update_node` reports success for a patch it silently discarded.**~~
  **fixed.** The reducer merged every patch key, then `NodeSchema.safeParse`
  stripped the ones the schema doesn't know (Zod's default) and wrote the
  stripped result back. So `{"x":1190}` — the shape `add_text`/`add_latex`
  themselves accept — was a no-op that returned `updated`. Found in the third
  milestone run after seven position edits appeared to work and changed
  nothing; only a screenshot caught it. `node.update` now records which keys
  it assigned and compares them against what survived the parse, so a key the
  node has no property for is an `invalid_patch` error naming the key and the
  right shape, rather than a silent success. Comparing assigned-vs-survived
  rather than hardcoding a key list per node type means it stays correct as
  the schema grows. Verified over MCP: `{"x":700}` on a latex node is
  rejected with *"has no property x — nothing would have changed. Position is
  {"position":{"x":…,"y":…}}"*, while `{"position":{…},"color":…}` applies.
- ~~**`morph_latex` can only append.**~~ **fixed.** `highlight` replaced an
  overlapping window and `animate` replaced later keyframes, but a queued
  `texMorph` had no revise or delete path — a second call at the same `start`
  stacked a second morph, and reworking one meant rewriting the node's whole
  `transitions` array through `update_node` (which is what the third run
  did). `morph_latex` now replaces morphs whose window overlaps the new one
  and says so in its result, matching `highlight`. Two morphs overlapping in
  time were never meaningful anyway: the later one's source would be a
  half-finished equation. Verified over MCP — a morph at `[2.5, 3.7]`
  reported `(replaced 1 overlapping morph)` over one at `[2, 3.5]`, while a
  later non-overlapping morph still chained.
- ~~`animate`'s `to` union rejects stringified numbers~~ **fixed.** At least
  one real MCP client (Claude Code) serializes values for union-typed params
  as strings — `to: 1.12` arrived as `"1.12"` and failed validation, forcing
  the Phase 5 run to bypass its own tools and call the worker over raw
  JSON-RPC. `to` now uses `NUMBERISH` (`apps/mcp/src/index.ts`), a
  number-or-numeric-string union placed **first** so `"#ff0000"` still falls
  through to `COLOR`. Deliberately a regex, not `z.coerce.number()`:
  coercion accepts `""`, `true`, `null` and `[]` as 0/1, which would animate
  to a silently wrong value rather than report a bad argument. Guarded by
  `check-mcp-tools.ts`, which also asserts the *document* ends up holding
  real numbers — a string reaching a keyframe would interpolate as NaN and
  fail only at render time. `animate.to` was the only union in the surface.
- Client-facing URLs must be built from `PUBLIC_API_ORIGIN`, not from the
  request. Service-binding calls (MCP worker → API) arrive with the internal
  hostname, so deriving the origin produced an unusable `https://api/...`
  download link for agents. Caught only by fetching the URL an agent actually
  receives.
- Refund idempotency comes from the SQL, not application logic: the UPDATE
  matches only non-terminal rows and the refund is gated on `meta.changes`,
  so duplicate or retried callbacks can't pay a user twice.

- `update_node` had two ways to report success and change nothing on screen,
  both found in real runs and both now fixed. **Unknown keys**: Zod strips
  properties the node type doesn't have, so `{x, y}` — the top-level form
  `add_latex`/`add_text` accept — parsed cleanly and did nothing; the reducer
  now compares what it assigned against what survived validation and rejects
  the patch by name. **Shadowed by a track**: patching a property that an
  animation keyframes *does* change the document, so `get_scene` confirms the
  new value, but `resolveNode` lets tracks override base values, so the render
  ignores it; the MCP tool now warns and names the property. The second is the
  nastier of the two precisely because inspecting the document agrees with you.

## Known issues
- Capture speed is bounded by one `page.screenshot()` round-trip per frame.
  If it becomes painful, the fix is a CDP screencast or batching frames via
  `canvas.toBlob` — measure before optimizing; correctness of the output
  matters more than render speed right now.
