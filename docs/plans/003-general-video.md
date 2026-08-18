# 003 — General video: assets, clips, reels (status: queued — Phase 5)

Sequenced after animation depth (plans/006) as of 2026-08-16: the argument
that put general video first was that verification, not visual vocabulary, was
the binding constraint — and Phase 3 settled verification. The analysis below
is unchanged; only its place in the queue is.

> **Reinstated as the product direction on 2026-08-15.** It was superseded
> briefly by [plans/006](006-animation-depth.md) (depth in the math vertical
> first); the third milestone run showed the binding constraint is not the
> visual vocabulary but that the agent cannot see its own output, which is
> platform work rather than vertical work. [plans/007](007-agent-sight.md)
> carries that reasoning and is the immediate prerequisite — its frame
> capture rides on the WebCodecs rework in §4 below, and its contact sheet is
> the same capability as the asset proxies/thumbnails in §1.
>
> So this is the **product direction** and the next phase, not the phase in
> flight: [Phase 3](000-roadmap.md) is 007. The asset filesystem in §1 landed
> early because agent blindness to files is the same problem 007 names for
> frames.

Direction change (decided 2026-08-14): Euclid is **not** limited to
educational math animation. The target is a general agentic video editor —
including "give it a reel link, have the agent generate segments from it,
then edit them." Math/explanatory becomes the **first vertical**, not the
ceiling.

## Why this is strategically right

It resolves the central tension in [market.md](../market.md): the math niche
was our differentiation *and* the market's lowest willingness-to-pay
segment. General video creation has budget behind it.

It also costs something, and the plan should be honest about it. We enter a
crowded field on two fronts:

- **Agentic motion graphics** — Midrender, Motion. Already shipping,
  already MCP-integrated.
- **Clip generation from source video** — Opus Clip, Reap, and the wider
  "long video → short clips" category. "Reel link → segments" is *exactly*
  this category, and it is well served.

The edge that survives the pivot is the same one that was always real: a
**deterministic document with one mutation path for agent and human**, so
generated edits and manual edits compose instead of fighting. Nobody in the
clip-generation category has a real editor behind the AI; nobody in the
motion-graphics category ingests source footage. The union is open.

## What survives (most of the system)

- **The document model, ops, reducer, event log, DO sync.** Nothing in it is
  math-specific. Scenes/nodes/tracks describe any composition.
- **MCP tool layer and live editor collaboration.** Unchanged in shape.
- **Job lifecycle, credits, R2, captions.** All carry over as-is. Captions
  get *more* valuable with reels (silent autoplay).
- **The purity invariant.** Still holds: source video is an input sampled
  deterministically at `(document, time)` — frame N of the output depends
  only on the document and which source frame time maps to.

## What must change

### 1. Assets become first-class
Today only narration audio has an `assetId`. Need a real registry: kind
(video/audio/image), R2 key, duration, dimensions, fps, a low-res **proxy**
for editing, thumbnail/filmstrip, source URL, and rights metadata.

#### Assets are a per-project filesystem, and nothing exposes it (2026-08-15)

Observed while reviewing the third milestone run in the editor. Every asset
*is* a file — narration mp3s, renders, and soon footage — but:

- **The agent cannot enumerate them.** The MCP surface has no `list_assets`,
  no upload, no delete. `generate_narration` mints an `assetId` as a side
  effect and that id appears in exactly one tool response; nothing can ask a
  project what it holds. Assets are the one part of a project the agent
  writes to but cannot read back — the same blindness
  [plans/007](007-agent-sight.md) names for frames.
- **The editor cannot show them.** The sidebar is a node inspector; there is
  no view of the project's files at all. A user cannot see that three
  narration clips exist, replace one, or delete a stale one — the Bayes run
  left an orphaned scene-2 mp3 after a regeneration, invisible in both
  surfaces.
- **There is no hierarchy.** `assets` is a flat table keyed by project. Once
  a project holds source footage, proxies, thumbnails and renders, flat is
  not navigable.

Direction: treat a project's assets as a **scoped filesystem** — folders and
files, owned by the project, with the same one-mutation-path discipline as
the document (moves and renames are ops, not direct writes). Two surfaces
over one model:

- **MCP** — `list_assets` (cheap text tree, free), `upload_asset`,
  `move_asset`/`rename`, `remove_asset`. The agent manages files the way it
  manages nodes.
- **Editor** — the sidebar becomes a **file explorer scoped to the open
  project**: folder tree, thumbnails, duration, size, drag-to-timeline.

#### Built 2026-08-15 — decisions taken

- **Folders are virtual.** A `path` column on `assets`; `buildAssetTree`
  derives the hierarchy. Rename and move are the same single UPDATE, and an
  empty folder cannot exist to be cleaned up. `normalizeAssetPath` rejects
  `..` outright rather than resolving it — these paths never touch a
  filesystem, so traversal has no legitimate meaning.
- **A referenced asset resists deletion.** `DELETE` returns 409 naming the
  scenes that would be left pointing at nothing, honouring the Phase 2
  invariant; `?force=1` is the deliberate override and reports what it broke.
- **Renders are assets too.** A finished job registers its output at
  `/renders/<project-slug>-<job8>.mp4`. The row **points at the render's
  existing R2 key** — bytes are not copied, so the download URL and the
  explorer serve the same object. "In use" therefore means *referenced by the
  document **or** served by a finished job*, otherwise every render would read
  as garbage. Force-deleting one also NULLs the job's `output_key` so no job
  advertises a download that 410s.

Surfaces: `list_assets` / `move_asset` / `remove_asset` over MCP (all free),
and the editor sidebar as a project-scoped explorer. The Bayes run's orphaned
scene-2 clip — 341KB left behind by a regeneration, invisible to both
surfaces — was found and deleted this way, which is the whole point.

Deliberately **not** shown: an "unused" badge. It was in the first cut and
removed — with renders counted as in-use it flagged almost nothing, and a
scary label on a file the user may simply not have wired up yet is the wrong
nudge. The API still returns `usedBy`, because the delete guard needs it.

**Update 2026-08-17 ([plans/009](009-generative-assets.md)):** the registry
gained a second class of producer — fal generations (images, video, music, 3D
models) — and `kind` gained `model` for GLB files. That validates the "assets
are first-class" bet early: `generate_image` needed no new storage concept, only
a new producer into `storeAsset`. It also sharpens §2 below, because there is
now generated media in projects that **nothing can put on screen**, which is
precisely what the `video`/`image` node work is for.

#### The explorer becomes a workbench — 2026-08-17

The sidebar's two jobs had nothing to do with each other: files, and the
node/narration inspector for the scene at the playhead. Split them across the
window the way an editor does — explorer left, canvas centre, scene right,
both sides collapsible — and clicking a file **opens it in the centre as a
tab** rather than throwing it at a browser tab and losing the editor.

- **The canvas is a tab, not a thing tabs replace.** It is hidden rather than
  unmounted, because rebuilding Pixi's app to glance at a text file would
  restart the preview every time.
- **`mime` picks the viewer, the extension is only a fallback.** Both apply in
  practice: the 3D models generated before generic mimes were treated as
  absent are still stored as `application/octet-stream`, and a `.bin` holding
  `text/plain` still opens as text.
- **A model gets a structure view, not a render** — triangles, meshes,
  materials — read from a 4MB ranged prefix, since the glTF spec puts the JSON
  chunk first and a `hunyuan3d` GLB is 7.7MB. Verified against the roster
  numbers this plan's sibling recorded: the viewer reads **329,128 triangles**
  out of `captions-2.glb`, which is exactly what `check-fal-roster.ts`
  measured. Pretending to draw it would be the lie — the engine takes
  parametric geometry, not imported vertices.

This is the display seam the roadmap was careful about, in the one place it
costs nothing: a *file explorer* showing a file is not a *document* node
displaying it, so nothing here prejudges the `video`/`image` node work below.

Panels are draggable as well as collapsible (2026-08-17), and both widths
persist. A drag is bounded by what the *other* panel and a 360px canvas
already claim, so no drag — and no window resize — can leave the middle column
at zero.

Two CSS gotchas, both found by running it rather than reading it, both the
same shape (a rule that is silently inert):

- **A drag handle must be positioned.** `z-index` does nothing on a
  `position: static` element, so the handle's negative margin tucked half of
  it *under* the neighbouring panel: dragging from that half selected text
  instead of resizing. `position: relative` is load-bearing.
- **`max-height: 100%` needs a parent with a definite height.** The image
  wrapper sized itself to its content, so the percentage resolved against
  nothing and a 1024² image ran off the bottom of its pane. The wrapper now
  stretches (`align-self: stretch; flex: 1; min-height: 0`) and the image is
  genuinely contained.

Still open:
- Thumbnails in the tree and drag-to-timeline — both wait on the `video` and
  `image` nodes, since there is nothing to drop onto yet.
- Upload from the editor (drag-and-drop) and an `upload_asset` MCP tool —
  `POST /assets` is still internal-key only, so today only producers create
  files. `generate_3d` makes this sharper: it needs a *publicly reachable*
  image URL, so a user cannot lift their own picture into 3D yet.
- Bulk actions, and a "delete every file no scene references" sweep.

### 2. New node types
- `video` — `assetId`, `sourceIn`/`sourceOut`, `playbackRate`, fit/crop.
  Trimming is a source-range property, not a document-time property.
- ~~`audio` — music/SFX with gain, fades, and ducking against narration.~~
  **Done 2026-08-18, but not as a node** — see below.

The DSL's discriminated union was built for this; it's an extension, not a
rewrite. Existing documents stay valid.

#### Audio became a track, not a node — 2026-08-18

This item was written as "a new node type", and building it that way would
have been wrong. A node is something the sampler *draws*; audio is never on
screen, and putting it in the scene graph would have given it a position, a
scale and an opacity that mean nothing, and scoped it to one scene when the
entire point of a music bed is that it runs across cuts.

So: `doc.audio?: AudioTrack[]`, clips placed in **global** time. What landed:

- **One placement function.** `planAudio(doc)` merges generated narration and
  every track into one list, and the timeline, the preview mixer and the
  ffmpeg mux all read it — the discipline `planNarration` set, kept. Muted
  clips are flagged rather than dropped, because a lane you cannot see is a
  lane you cannot unmute; `audibleAudio` is what the export uses.
- **Mute is in the document, solo is not.** Mute changes the render; solo is a
  monitoring choice, and putting it in a shared document would let one
  person's listening change everyone's export.
- **Gain attenuates only (0…1)**, because `HTMLMediaElement.volume` caps at 1
  and a document that could not be previewed at its own level would be lying.
- **The timeline became a lane editor**: a ruler, one scroller so no two lanes
  can disagree about where a second is, zoom to 8×, clips that drag between
  lanes, trim from either edge, snap to cuts, and fades drawn as the ramps
  they are.
- **Drag an audio file from the explorer onto a lane.** This is the
  "drag-to-timeline" item from §1, arriving early because audio needed it
  first. A file the user uploaded has no recorded duration — only producers
  write one — so the browser is asked for it rather than a length being
  guessed.
- **The agent got the same surface**: `add_audio_track`, `add_audio_clip`,
  `update_audio`, and audio lines in `get_project`'s outline.

Verified in a real 19s export, measured rather than eyeballed: effects at gain
0.5 read −21.2 dB against a −15.2 dB source (halving amplitude is −6.02 dB),
the 3→6s gap reads −91 dB, and the bed's fade-out reads −47.4 dB at 15s.
`silencedetect` puts the edges at 3.00s and 6.23s — the second being the 2s
fade-in crossing the threshold, which is the fade proving itself.

Still open: **ducking** — dropping the bed under narration automatically. It
needs a sidechain in the mux and an envelope in the preview that both derive
from the same numbers, which is the same one-placement-function problem again
and deserves its own pass. Today you set the bed's gain by hand.

One bug this work found and fixed: `get_project`'s new audio lines first
reported each clip's *file* length, so a 30s bed on an 8s video read as 30s —
the outline describing audio the export throws away. It reads `planAudio` now,
and says `(cut from 30s at the end of the video)`.

### 3. Layers within a scene
Scenes are currently *sequential* on the global timeline. A reel is one
composition with **stacked tracks** (footage, overlay graphics, captions,
music). Groups give partial z-ordering, but real tracks need explicit
ordering plus mute/lock/solo for the editor.

### 4. The render pipeline must be replaced — this is the big one
`page.screenshot()` per frame is *already* the bottleneck at ~3.6× realtime
for pure vector content (see plans/002). Compositing decoded HD video
through per-frame PNG screenshots is untenable — it would be slower than
realtime by a wide margin.

Two paths:

- **WebCodecs (recommended).** Decode source frames with `VideoDecoder`,
  upload as textures into the same Pixi stage, encode output with
  `VideoEncoder`. Keeps one renderer for preview and export, preserves the
  purity model, and removes the screenshot round-trip entirely — likely an
  order of magnitude faster even for today's vector-only work.
- **ffmpeg filter graph.** Compile the document to an ffmpeg filter chain,
  with Pixi output as a transparent overlay sequence. Faster to build, but
  splits the renderer in two and limits what animation can do *over* video.

Recommendation: WebCodecs, and note that it pays for itself on the existing
vector path regardless of whether the pivot completes.

#### Server reality — measured, not assumed (2026-08-14)

WebCodecs is a browser API, and the renderer already runs headless Chromium
in a container, so the topology doesn't change. What *does* change by
environment is which codecs exist. Measured with `bench-webcodecs.ts`
locally and the same benchmark inside `mcr.microsoft.com/playwright:v1.62.1-noble`
(GPU disabled, `--use-gl=swiftshader`, i.e. what a CPU-only container gives):

| Environment | H.264 | VP9 / VP8 / AV1 | 1080p encode |
|---|---|---|---|
| macOS (local) | **yes** (Main L4.0) | yes | ~169–179 fps |
| Linux container | **no** | yes | ~114 fps (VP9) |

Two conclusions:

1. **Chromium on Linux has no H.264 *encoder*.** Both `avc1.4d0028` and
   `avc1.640028` report unsupported in a stock container — the known
   licensing/build situation, not a misconfiguration. Any design that assumes
   in-browser H.264 will work locally and fail in production.
2. **Hardware acceleration is irrelevant here.** Disabling the GPU locally
   made encoding *slightly faster* (179 vs 169 fps), so it was already
   software-encoding. [Cloudflare Containers have no GPU](https://developers.cloudflare.com/changelog/product/containers/)
   (GPU is Workers AI only), and that turns out not to matter.

So the pipeline should be: **encode VP9 in-browser → transfer chunks (~15 KB
a frame, versus 1–2 MB of PNG) → mux to WebM → transcode to H.264/MP4 with
ffmpeg only where MP4 is required.** ffmpeg has libx264 and is already in the
image. The double encode costs some CPU, but the PNG round-trip that
currently dominates is gone either way. Deliver WebM directly where the
target is the web.

#### Unmeasured risk: WebGL under SwiftShader

The container benchmark encoded a 2D canvas. It did **not** measure Pixi's
WebGL rendering, which in a GPU-less container falls back to SwiftShader
(software rasterization). That cost is unknown and applies to the *current*
renderer too — `render.ts` has only ever been run on macOS with a real GPU.

**Next concrete step before committing to Cloudflare Containers:** run the
existing `render.ts` inside the Linux image against a real project and
measure end-to-end fps. If SwiftShader is the bottleneck rather than
encoding, the answer changes (bigger instance types, or a GPU host
elsewhere, or moving compositing to ffmpeg).

### 5. Ingest + analysis subsystem (new)
`link or upload → fetch → transcode + proxy → probe → STT transcript →
shot/scene detection → candidate segments`.

"Generate video segments" **is** this pipeline. The agent doesn't invent
segments; it selects and arranges the ones analysis surfaced, using the
transcript and shot boundaries as its handles. Each stage is a metered,
creditable operation.

## Rights and platform ToS — decide before building the fetcher

Downloading from social links generally violates platform terms and may
infringe copyright. This needs a product decision, not an implementation
default. Realistic options:

1. **User uploads their own media** — cleanest, no ToS exposure.
2. **Official platform APIs** where they exist — limited but legitimate.
3. **User attests rights + takedown process** — what most tools in this
   category actually do; shifts liability but doesn't eliminate it.

Pick one before writing the ingest fetcher. It also affects positioning: (1)
is a creator tool, (3) is a repurposing tool, and they attract different
customers.

## Sequencing

1. **Finish the current audio/render loop first** (plans/002 Phases 3–4).
   TTS, audio muxing, and captions are all needed for reels too — none of
   that work is wasted.
2. **Stop investing in math-specific depth.** Matched-glyph LaTeX morphing
   drops down the priority list; it's a vertical feature, not a platform one.
3. **Replace the capture path with WebCodecs.** Standalone win, and the
   prerequisite for everything below.
4. **Assets + `video`/`audio` nodes + tracks.** DSL extension, editor
   support, renderer support.
5. **Ingest + analysis**, once the rights model is decided.
6. **Segment generation** as MCP tools over the analysis output.

## Open questions

- Does the editor need a real multi-track timeline UI before or after video
  nodes land? (Probably before — a reel is unusable on a scene-strip.)
- Do reels want vertical-first canvas presets (1080×1920) as a document
  concern, or just a canvas size? Likely just canvas size plus templates.
- Where does STT run — same adapter as TTS, or a separate provider?
