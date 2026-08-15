# 003 — General video: assets, clips, reels (status: deferred)

> **Superseded as the active direction on 2026-08-15** by
> [plans/006](006-animation-depth.md) — depth in the math vertical first,
> one problem at a time. Deferred, not abandoned: the analysis below stands
> unchanged, and the WebCodecs and container-codec findings in it are
> prerequisites for general video whenever it resumes. The reasoning for the
> switch is in 006 under "What this replaces, and why".

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

### 2. New node types
- `video` — `assetId`, `sourceIn`/`sourceOut`, `playbackRate`, fit/crop.
  Trimming is a source-range property, not a document-time property.
- `audio` — music/SFX with gain, fades, and ducking against narration.

The DSL's discriminated union was built for this; it's an extension, not a
rewrite. Existing documents stay valid.

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
