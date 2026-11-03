/**
 * Generative assets behind a provider seam — images, video, audio and 3D
 * models, all arriving as bytes a project can hold.
 *
 * Shaped after tts.ts, and for the same reason: the interesting part is the
 * *contract*, not the vendor. What differs is that TTS answers in one call and
 * these do not — a video generation runs for minutes — so the unit here is a
 * **submitted request** rather than a finished file.
 *
 * The queue is fal's, not ours. A request submitted to `queue.fal.run` is held
 * by fal until it is collected, so a job row here is bookkeeping (which project
 * asked, what it cost) rather than a work queue with a worker draining it.
 * That is the whole reason this phase needs no second process.
 *
 * Deliberately written against web-standard APIs only (fetch, URL) with no
 * Cloudflare types, so the adapter stays portable and testable outside the
 * worker.
 */

export type GenKind = 'image' | 'video' | 'audio' | 'model'

export interface GenerationRequest {
  prompt: string
  /**
   * Grounds an image-conditioned model. Only models that declare `needsImage`
   * accept one — see {@link checkRequest}, which refuses it elsewhere rather
   * than letting `input()` drop it silently.
   */
  imageUrl?: string
  /** 0..1 — how far an image-to-image model may travel from its reference. */
  strength?: number
  /**
   * Reference media for a reference-to-video model, in the order the prompt
   * names them: `@Image1`, `@Image2`… and `@Video1`… Already reachable by the
   * provider — the service layer uploads project assets before they get here.
   */
  referenceImages?: string[]
  referenceVideos?: string[]
  /** Total seconds of `referenceVideos` — billed by per-second models. */
  referenceVideoSec?: number
  /** e.g. '480p', where the model offers a choice. */
  resolution?: string
  /** Output shape, where the model takes one. */
  aspectRatio?: string
  /** Seconds, for video and audio models that accept a length. */
  durationSec?: number
  /** Provider-specific passthrough for anything the roster does not name. */
  extra?: Record<string, unknown>
}

/** What a finished generation yields: one file, addressable by URL. */
export interface GenerationOutput {
  url: string
  mime: string
  durationSec?: number
  width?: number
  height?: number
}

export interface SubmittedGeneration {
  requestId: string
  statusUrl: string
  responseUrl: string
}

export type GenerationState =
  | { status: 'pending'; queuePosition?: number }
  | { status: 'done'; output: GenerationOutput }
  | { status: 'failed'; detail: string }

export type FalErrorCode =
  | 'no_api_key'
  | 'unknown_model'
  | 'invalid_request'
  | 'provider_error'
  | 'no_output'

/** Distinguishes "the caller asked for something impossible" from "the provider broke". */
export class FalError extends Error {
  constructor(
    readonly code: FalErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'FalError'
  }
}

// ---------- the roster ----------

/**
 * One entry per model we expose. Adding a model is one entry here plus a price,
 * which is the point — the capability layer above is generic over kind, so a
 * new model costs no new tool, no new route and no client restart.
 *
 * `credits` is what we charge, not what fal charges. 1 credit ≈ $0.01 retail;
 * the margin covers the fact that a failed generation is refunded in full.
 */
export interface FalModel {
  /** Endpoint id, e.g. 'fal-ai/flux/schnell'. */
  id: string
  /** Short name the agent selects by. */
  name: string
  kind: GenKind
  credits: number
  /** Roughly how long fal takes, so the caller knows whether to wait. */
  typicalSec: number
  summary: string
  /**
   * True when the model needs an input image rather than only a prompt.
   *
   * It is both halves of one rule: a model with this flag *requires* an image,
   * and a model without it *refuses* one. There is no third state, because a
   * text-to-image endpoint handed an `image_url` does not fail — it ignores it
   * and returns a perfectly good picture of the wrong thing.
   *
   * Such a model also takes its output shape from the reference, so
   * `aspectRatio` is refused alongside.
   */
  needsImage?: boolean
  /** True when the model accepts `strength` — image-to-image only. */
  takesStrength?: boolean
  /** Reference-to-video: how many of each the model accepts. Absent means none. */
  takesReferences?: { images: number; videos: number; videoSecMin: number; videoSecMax: number }
  /**
   * Output seconds the model accepts, inclusive. Out-of-range requests are
   * refused rather than clamped: a clamp would bill a different clip from the
   * one asked for, and the caller would only find out by measuring it.
   */
  durationRange?: [number, number]
  /** The resolutions offered, first is the default. Absent means no choice. */
  resolutions?: string[]
  /**
   * What one call costs in credits, for models billed by what they produce
   * rather than per call. Absent means `credits` is the price.
   *
   * `credits` stays meaningful for these: it is the typical call, which is what
   * a plan estimate multiplies. The gate draws down the real price, so a plan
   * that underestimated is refused at the call that overruns it — loudly, with
   * "propose a revision" — rather than silently overspending.
   */
  price?(req: GenerationRequest): number
  input(req: GenerationRequest): Record<string, unknown>
  output(body: Record<string, unknown>): GenerationOutput | null
}

/** fal returns `{url, content_type, file_size}` for files across most models. */
interface FalFile {
  url?: string
  content_type?: string
  file_name?: string
  duration?: number
  width?: number
  height?: number
}

/**
 * `application/octet-stream` is a provider saying "bytes" rather than saying
 * anything. Both image-to-3D models report it for files that are provably
 * glTF, so trusting it would store every generated model under a mime that
 * tells no one — and would leave `extensionFor`'s `model/gltf-binary` entry
 * permanently unreachable. The roster knows what it asked for; prefer that.
 */
const GENERIC_MIMES = new Set(['application/octet-stream', 'binary/octet-stream', ''])

function fileOut(f: unknown, fallbackMime: string): GenerationOutput | null {
  const file = f as FalFile | undefined
  if (!file?.url) return null
  const reported = (file.content_type ?? '').toLowerCase()
  return {
    url: file.url,
    mime: GENERIC_MIMES.has(reported) ? fallbackMime : file.content_type!,
    ...(typeof file.duration === 'number' ? { durationSec: file.duration } : {}),
    ...(typeof file.width === 'number' ? { width: file.width } : {}),
    ...(typeof file.height === 'number' ? { height: file.height } : {}),
  }
}

const imageSize = (aspect?: string): string => {
  switch (aspect) {
    case '16:9':
      return 'landscape_16_9'
    case '9:16':
      return 'portrait_16_9'
    case '4:3':
      return 'landscape_4_3'
    case '3:4':
      return 'portrait_4_3'
    default:
      return 'square_hd'
  }
}

/**
 * Seedance is billed in tokens, not seconds: tokens = width × height × seconds
 * × 24 / 1024, at a per-endpoint price (fal's pricing API, 2026-09-17: 2.5 is
 * $0.0214 per 1000). The per-second figures on fal's model page are that
 * formula rounded for one frame size, and pricing from them overcharged a 15s
 * 480p clip by ~6%. Pixel counts are the 16:9 / 9:16 frame at each resolution;
 * other aspect ratios are within a few percent.
 */
const SEEDANCE_PIXELS: Record<string, number> = { '480p': 480 * 864, '720p': 720 * 1280, '1080p': 1080 * 1920 }
/** Retail credits per USD — 1 credit ≈ $0.01, with the roster's ~1.5x margin. */
const CREDITS_PER_USD = 150

export function seedanceTokens(resolution: string, seconds: number): number {
  return ((SEEDANCE_PIXELS[resolution] ?? SEEDANCE_PIXELS['480p']!) * seconds * 24) / 1024
}

/** The output length a Seedance endpoint will actually be asked for. */
const seedanceSec = (r: GenerationRequest, maxSec: number) =>
  Math.min(maxSec, Math.max(4, Math.round(r.durationSec ?? 5)))

/**
 * A price function for one Seedance endpoint. The family shares the token
 * formula and differs only in the price per 1000 tokens — 2.5 costs three times
 * what 2.0 mini does for the same clip, which is the whole case for a cheap
 * test pass on mini before a real one on 2.5.
 */
function seedancePricer(usdPer1kTokens: number, maxSec: number) {
  return (r: GenerationRequest): number => {
    const inSec = r.referenceVideoSec ?? 0
    // Reference video is billed too — its seconds join the output's, at 0.6x.
    const tokens = seedanceTokens(r.resolution ?? '480p', inSec + seedanceSec(r, maxSec))
    const usd = (tokens / 1000) * usdPer1kTokens * (inSec > 0 ? 0.6 : 1)
    return Math.ceil(usd * CREDITS_PER_USD)
  }
}

/** Unit prices from fal's pricing API, USD per 1000 tokens (2026-09-17). */
const seedance25Price = seedancePricer(0.0214, 30)
const seedance20Price = seedancePricer(0.014, 15)
const seedance20MiniPrice = seedancePricer(0.007, 15)

/** A reference-to-video request body, shared by the family. */
function seedanceInput(maxSec: number) {
  return (r: GenerationRequest) => ({
    prompt: r.prompt,
    ...(r.referenceImages?.length ? { image_urls: r.referenceImages } : {}),
    ...(r.referenceVideos?.length ? { video_urls: r.referenceVideos } : {}),
    duration: String(seedanceSec(r, maxSec)),
    resolution: r.resolution ?? '480p',
    aspect_ratio: r.aspectRatio ?? 'auto',
    // Sound belongs to the edit, not the generation: a clone lays the source
    // audio (or a new bed) with add_audio_clip, and fal charges the same
    // either way, so nothing is saved by asking for audio we would discard.
    generate_audio: false,
    ...r.extra,
  })
}

export function priceOf(model: FalModel, req: GenerationRequest): number {
  return model.price ? model.price(req) : model.credits
}

export const FAL_MODELS: FalModel[] = [
  // ---- images ----
  {
    id: 'fal-ai/flux/schnell',
    name: 'flux-schnell',
    kind: 'image',
    credits: 2,
    typicalSec: 3,
    summary: 'Fast, cheap stills. The default — good enough to iterate with.',
    input: (r) => ({
      prompt: r.prompt,
      image_size: imageSize(r.aspectRatio),
      num_images: 1,
      ...r.extra,
    }),
    output: (b) => fileOut((b.images as unknown[])?.[0], 'image/jpeg'),
  },
  {
    id: 'fal-ai/flux/dev',
    name: 'flux-dev',
    kind: 'image',
    credits: 6,
    typicalSec: 12,
    summary: 'Slower, better stills. Worth it once the prompt is settled.',
    input: (r) => ({
      prompt: r.prompt,
      image_size: imageSize(r.aspectRatio),
      num_images: 1,
      ...r.extra,
    }),
    output: (b) => fileOut((b.images as unknown[])?.[0], 'image/jpeg'),
  },

  {
    id: 'fal-ai/flux-pro/v1.1',
    name: 'flux-pro',
    kind: 'image',
    credits: 12,
    typicalSec: 15,
    summary: 'The best stills in the roster, and the most expensive.',
    input: (r) => ({
      prompt: r.prompt,
      image_size: imageSize(r.aspectRatio),
      num_images: 1,
      ...r.extra,
    }),
    output: (b) => fileOut((b.images as unknown[])?.[0], 'image/jpeg'),
  },

  {
    id: 'fal-ai/flux/dev/image-to-image',
    name: 'flux-i2i',
    kind: 'image',
    credits: 6,
    typicalSec: 12,
    summary:
      'A still built FROM a reference image rather than from a prompt alone — the way to carry a background, a person, a garment or a colour across two generations. `strength` decides how far it may travel.',
    needsImage: true,
    takesStrength: true,
    // No image_size: the output takes the reference's dimensions, which is
    // why checkRequest refuses an aspectRatio alongside.
    input: (r) => ({
      prompt: r.prompt,
      image_url: r.imageUrl,
      ...(r.strength !== undefined ? { strength: r.strength } : {}),
      num_images: 1,
      ...r.extra,
    }),
    output: (b) => fileOut((b.images as unknown[])?.[0], 'image/jpeg'),
  },

  // ---- video ----
  {
    id: 'fal-ai/ltx-video',
    name: 'ltx-video',
    kind: 'video',
    credits: 25,
    typicalSec: 60,
    summary: 'Short text-to-video clips, and the cheapest way to see one. Minutes, not seconds — poll for it.',
    input: (r) => ({ prompt: r.prompt, ...r.extra }),
    output: (b) => fileOut(b.video, 'video/mp4'),
  },
  {
    id: 'fal-ai/kling-video/v1/standard/text-to-video',
    name: 'kling-video',
    kind: 'video',
    credits: 60,
    typicalSec: 180,
    summary: 'Longer, steadier video than ltx. Slow and priced accordingly.',
    input: (r) => ({
      prompt: r.prompt,
      ...(r.durationSec ? { duration: String(Math.round(r.durationSec)) } : {}),
      ...(r.aspectRatio ? { aspect_ratio: r.aspectRatio } : {}),
      ...r.extra,
    }),
    output: (b) => fileOut(b.video, 'video/mp4'),
  },

  {
    id: 'fal-ai/ltx-video/image-to-video',
    name: 'ltx-video-i2v',
    kind: 'video',
    credits: 25,
    typicalSec: 60,
    summary:
      'ltx, but starting from a still you supply — the clip opens on that image, so a shot can continue from the last frame of the one before it.',
    needsImage: true,
    input: (r) => ({ prompt: r.prompt, image_url: r.imageUrl, ...r.extra }),
    output: (b) => fileOut(b.video, 'video/mp4'),
  },
  {
    id: 'fal-ai/kling-video/v1/standard/image-to-video',
    name: 'kling-video-i2v',
    kind: 'video',
    credits: 60,
    typicalSec: 180,
    summary: 'kling from a still. The steadiest way to animate a generated frame, and the priciest.',
    needsImage: true,
    input: (r) => ({
      prompt: r.prompt,
      image_url: r.imageUrl,
      ...(r.durationSec ? { duration: String(Math.round(r.durationSec)) } : {}),
      ...r.extra,
    }),
    output: (b) => fileOut(b.video, 'video/mp4'),
  },

  // The Seedance family bills in tokens (width × height × seconds × 24 / 1024)
  // rather than per call, so these entries carry a computed price. `credits` is
  // the plan-estimate figure: a 10s clip at 480p with no reference video.
  {
    id: 'bytedance/seedance-2.5/reference-to-video',
    name: 'seedance-2.5-ref',
    kind: 'video',
    credits: seedance25Price({ prompt: '', durationSec: 10 }),
    typicalSec: 240,
    summary:
      'Video directed by references named in the prompt: the subject and per-shot control tiles as `referenceImages` (@Image1…), optionally footage you own the look of as `referenceVideos` (@Video1…) — never the clip being cloned. Up to 30 images, 4–30s. Priced by output length and resolution; needs `durationSec`.',
    // From the 2.5 schema (30 images, 10 videos, 50 files in all) — not 2.0's 9/3.
    takesReferences: { images: 30, videos: 10, videoSecMin: 1.8, videoSecMax: 30.2 },
    resolutions: ['480p', '720p', '1080p'],
    durationRange: [4, 30],
    price: seedance25Price,
    input: (r) => ({ task: 'reference', ...seedanceInput(30)(r) }),
    output: (b) => fileOut(b.video, 'video/mp4'),
  },
  {
    id: 'bytedance/seedance-2.0/reference-to-video',
    name: 'seedance-2.0-ref',
    kind: 'video',
    credits: seedance20Price({ prompt: '', durationSec: 10 }),
    typicalSec: 180,
    summary:
      'The middle of the family: two-thirds the price of seedance-2.5-ref, twice mini. Up to 9 reference images and 3 videos, 4–15s, 480p to 1080p.',
    takesReferences: { images: 9, videos: 3, videoSecMin: 1.8, videoSecMax: 15.2 },
    // The endpoint also offers 4k; left out until its frame size is known,
    // because the price is computed from pixel count.
    resolutions: ['480p', '720p', '1080p'],
    durationRange: [4, 15],
    price: seedance20Price,
    input: seedanceInput(15),
    output: (b) => fileOut(b.video, 'video/mp4'),
  },
  {
    id: 'bytedance/seedance-2.0/mini/reference-to-video',
    name: 'seedance-2.0-mini-ref',
    kind: 'video',
    credits: seedance20MiniPrice({ prompt: '', durationSec: 10 }),
    typicalSec: 120,
    summary:
      'seedance-2.5-ref at a third of the price, with tighter limits: up to 9 reference images and 3 videos, 4–15s, 480p or 720p. The test pass — find out whether a prompt and its references work here before paying for 2.5.',
    takesReferences: { images: 9, videos: 3, videoSecMin: 1.8, videoSecMax: 15.2 },
    resolutions: ['480p', '720p'],
    durationRange: [4, 15],
    price: seedance20MiniPrice,
    input: seedanceInput(15),
    output: (b) => fileOut(b.video, 'video/mp4'),
  },

  // ---- audio ----
  {
    id: 'fal-ai/stable-audio',
    name: 'stable-audio',
    kind: 'audio',
    credits: 10,
    typicalSec: 30,
    summary:
      'Music and sound beds from a prompt. For *speech* use generate_narration — that is ElevenLabs, and it returns word timings this cannot.',
    input: (r) => ({
      prompt: r.prompt,
      seconds_total: Math.round(r.durationSec ?? 30),
      ...r.extra,
    }),
    output: (b) => fileOut(b.audio_file ?? b.audio, 'audio/mpeg'),
  },

  // ---- 3D ----
  //
  // These produce a GLB *file*, which the project stores like any other asset —
  // and `import_mesh` turns one into a mesh node the engine draws, decimating
  // it to fit the document budget on the way in (plans/009 Phase C). Trellis is
  // the better source for that: it returns ~10-19k triangles where hunyuan3d
  // returns ~330k, and both decimate to the same ceiling, so hunyuan3d throws
  // far more detail away.
  {
    id: 'fal-ai/trellis',
    name: 'trellis',
    kind: 'model',
    credits: 15,
    typicalSec: 60,
    summary:
      'An image turned into a 3D model, delivered as a GLB file. Stored as a project asset; import_mesh puts it in a scene. The better of the two for importing — fewer triangles to throw away.',
    needsImage: true,
    input: (r) => ({ image_url: r.imageUrl, ...r.extra }),
    output: (b) => fileOut(b.model_mesh ?? b.model_glb, 'model/gltf-binary'),
  },
  {
    id: 'fal-ai/hunyuan3d/v2',
    name: 'hunyuan3d',
    kind: 'model',
    credits: 20,
    typicalSec: 90,
    summary: 'Image to 3D with cleaner topology than trellis, and slower. Also a GLB.',
    needsImage: true,
    input: (r) => ({ input_image_url: r.imageUrl, ...r.extra }),
    output: (b) => fileOut(b.model_mesh ?? b.model_glb, 'model/gltf-binary'),
  },
]

const BY_NAME = new Map(FAL_MODELS.map((m) => [m.name, m]))

export function falModel(name: string): FalModel {
  const m = BY_NAME.get(name)
  if (!m) {
    throw new FalError(
      'unknown_model',
      `unknown model "${name}". Available: ${FAL_MODELS.map((x) => x.name).join(', ')}`,
    )
  }
  return m
}

export function modelsOfKind(kind: GenKind): FalModel[] {
  return FAL_MODELS.filter((m) => m.kind === kind)
}

/**
 * Every rule about what a model will accept, in one function.
 *
 * Exported because it is checked **twice on purpose**: once by the capability
 * layer, so a bad combination is refused before any budget is drawn down, and
 * once inside `submit`, so the seam cannot be bypassed by a future caller. Two
 * call sites, one rule — the alternative is two rules that drift.
 *
 * Every refusal here names what the caller could have used instead. An agent
 * reading `"flux-schnell takes a prompt only"` learns nothing it can act on;
 * the model list after it is the whole value of the error.
 */
export function checkRequest(model: FalModel, req: GenerationRequest): void {
  const withImage = () =>
    modelsOfKind(model.kind)
      .filter((m) => m.needsImage)
      .map((m) => m.name)
      .join(', ') || 'none in this roster'

  if (!req.prompt.trim() && !req.imageUrl) {
    throw new FalError('invalid_request', 'a prompt or an input image is required')
  }
  if (model.needsImage && !req.imageUrl) {
    throw new FalError(
      'invalid_request',
      `${model.name} builds from an image — pass imageUrl (an image asset in this project, or any public URL)`,
    )
  }
  if (req.imageUrl && !model.needsImage) {
    throw new FalError(
      'invalid_request',
      `${model.name} takes a prompt only and would ignore imageUrl, returning a good picture of ` +
        `the wrong thing. To ground a generation on an image use: ${withImage()}`,
    )
  }
  if (req.aspectRatio && model.needsImage) {
    throw new FalError(
      'invalid_request',
      `${model.name} takes its shape from the image you pass it, so aspectRatio would be ignored — ` +
        `drop it, or crop the reference to the shape you want`,
    )
  }
  const refs = model.takesReferences
  const nImages = req.referenceImages?.length ?? 0
  const nVideos = req.referenceVideos?.length ?? 0
  if ((nImages || nVideos) && !refs) {
    throw new FalError(
      'invalid_request',
      `${model.name} takes no reference media. Models that do: ` +
        (FAL_MODELS.filter((m) => m.takesReferences).map((m) => m.name).join(', ') || 'none'),
    )
  }
  if (refs && nImages > refs.images) {
    throw new FalError('invalid_request', `${model.name} takes at most ${refs.images} reference images (got ${nImages})`)
  }
  if (refs && nVideos > refs.videos) {
    throw new FalError('invalid_request', `${model.name} takes at most ${refs.videos} reference videos (got ${nVideos})`)
  }
  if (refs && req.referenceVideoSec !== undefined && req.referenceVideoSec > refs.videoSecMax) {
    throw new FalError(
      'invalid_request',
      `${model.name} takes at most ${refs.videoSecMax}s of reference video in total; these add up to ` +
        `${req.referenceVideoSec.toFixed(2)}s. Trim them, or split the work across two generations`,
    )
  }
  if (req.resolution !== undefined) {
    if (!model.resolutions) {
      throw new FalError('invalid_request', `${model.name} has no resolution choice — drop resolution`)
    }
    if (!model.resolutions.includes(req.resolution)) {
      throw new FalError(
        'invalid_request',
        `${model.name} offers ${model.resolutions.join(', ')}, not ${req.resolution}`,
      )
    }
  }
  if (model.durationRange && req.durationSec !== undefined) {
    const [lo, hi] = model.durationRange
    if (req.durationSec < lo || req.durationSec > hi) {
      throw new FalError(
        'invalid_request',
        `${model.name} makes ${lo}–${hi}s clips, not ${req.durationSec}s` +
          (req.durationSec > hi ? ' — split the work across two generations, or use a model with a longer ceiling' : ''),
      )
    }
  }
  if (model.price && req.durationSec === undefined) {
    throw new FalError(
      'invalid_request',
      `${model.name} is billed per second, so it needs durationSec to be priced — "auto" would be a blank cheque`,
    )
  }
  if (req.strength !== undefined && !model.takesStrength) {
    throw new FalError(
      'invalid_request',
      `${model.name} has no strength control` +
        (model.needsImage
          ? ' — it is an image-to-video model, and the still it starts from is not negotiable'
          : `. strength belongs to image-to-image: ${withImage()}`),
    )
  }
}

// ---------- the provider ----------

const FAL_QUEUE = 'https://queue.fal.run'
const FAL_STORAGE = 'https://rest.alpha.fal.ai'

export interface FalProvider {
  readonly name: string
  submit(model: FalModel, req: GenerationRequest): Promise<SubmittedGeneration>
  poll(sub: Pick<SubmittedGeneration, 'statusUrl' | 'responseUrl'>): Promise<GenerationState>
  /** Fetch the finished bytes, for handing straight to storeAsset. */
  fetchBytes(url: string): Promise<ArrayBuffer>
  /**
   * Put bytes on fal's CDN and return a URL fal can fetch. For reference media
   * too large to inline as a data URL — a video, in practice. The URL is
   * unguessable but public, which is the same exposure as sending the bytes to
   * fal for inference in the first place.
   */
  upload(body: ArrayBuffer, mime: string, fileName: string): Promise<string>
}

export function falProvider(apiKey: string): FalProvider {
  if (!apiKey) throw new FalError('no_api_key', 'FAL_KEY is not configured')
  const auth = { Authorization: `Key ${apiKey}` }

  return {
    name: 'fal',

    async submit(model, req) {
      checkRequest(model, req)

      const res = await fetch(`${FAL_QUEUE}/${model.id}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(model.input(req)),
      })
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300)
        throw new FalError('provider_error', `fal ${res.status} submitting ${model.id}: ${detail}`)
      }
      const body = (await res.json()) as {
        request_id?: string
        status_url?: string
        response_url?: string
      }
      // The URLs fal hands back are used verbatim rather than rebuilt from the
      // model id. Endpoints with a sub-path (`fal-ai/flux/schnell`) are polled
      // at the *app* path (`fal-ai/flux/requests/...`), so constructing them
      // ourselves would be wrong for exactly the models most likely to be used.
      if (!body.request_id || !body.status_url || !body.response_url) {
        throw new FalError('provider_error', 'fal accepted the request but returned no queue URLs')
      }
      return {
        requestId: body.request_id,
        statusUrl: body.status_url,
        responseUrl: body.response_url,
      }
    },

    async poll({ statusUrl, responseUrl }) {
      const res = await fetch(statusUrl, { headers: auth })
      if (!res.ok) {
        return { status: 'failed', detail: `fal status ${res.status}: ${(await res.text()).slice(0, 200)}` }
      }
      const body = (await res.json()) as {
        status?: string
        queue_position?: number
        error?: string
      }
      if (body.status === 'IN_QUEUE' || body.status === 'IN_PROGRESS') {
        return {
          status: 'pending',
          ...(typeof body.queue_position === 'number' ? { queuePosition: body.queue_position } : {}),
        }
      }
      if (body.status !== 'COMPLETED') {
        return { status: 'failed', detail: body.error ?? `fal reported status ${body.status}` }
      }

      const out = await fetch(responseUrl, { headers: auth })
      if (!out.ok) {
        return {
          status: 'failed',
          detail: `fal result ${out.status}: ${(await out.text()).slice(0, 200)}`,
        }
      }
      return { status: 'done', output: (await out.json()) as never }
    },

    async fetchBytes(url) {
      const res = await fetch(url)
      if (!res.ok) throw new FalError('provider_error', `could not fetch generated file: ${res.status}`)
      return res.arrayBuffer()
    },

    async upload(body, mime, fileName) {
      // Two steps, the same ones fal's own client takes: ask for a signed PUT
      // target, then send the bytes to it. The returned file_url is what a
      // model is handed.
      const init = await fetch(`${FAL_STORAGE}/storage/upload/initiate?storage_type=fal-cdn-v3`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ content_type: mime, file_name: fileName }),
      })
      if (!init.ok) {
        throw new FalError('provider_error', `fal upload initiate ${init.status}: ${(await init.text()).slice(0, 200)}`)
      }
      const { upload_url, file_url } = (await init.json()) as { upload_url?: string; file_url?: string }
      if (!upload_url || !file_url) throw new FalError('provider_error', 'fal upload initiate returned no URLs')
      const put = await fetch(upload_url, { method: 'PUT', headers: { 'content-type': mime }, body })
      if (!put.ok) throw new FalError('provider_error', `fal upload PUT ${put.status}`)
      return file_url
    },
  }
}

/**
 * `poll` hands back the raw body so the caller can apply the model's own
 * reader — the shape differs per model and only the roster entry knows it.
 */
export function readOutput(model: FalModel, body: unknown): GenerationOutput {
  const out = model.output((body ?? {}) as Record<string, unknown>)
  if (!out) {
    throw new FalError(
      'no_output',
      `${model.name} completed but returned no file in the shape the roster expects`,
    )
  }
  return out
}

/** Extension for the stored file, so the asset explorer reads as files rather than uuids. */
export function extensionFor(mime: string, kind: GenKind): string {
  const known: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'model/gltf-binary': 'glb',
  }
  return known[mime] ?? { image: 'png', video: 'mp4', audio: 'mp3', model: 'glb' }[kind]
}
