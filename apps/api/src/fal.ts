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
  /** Seeds an image-to-X model; ignored by text-only models. */
  imageUrl?: string
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
  /** True when the model needs an input image rather than only a prompt. */
  needsImage?: boolean
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

// ---------- the provider ----------

const FAL_QUEUE = 'https://queue.fal.run'

export interface FalProvider {
  readonly name: string
  submit(model: FalModel, req: GenerationRequest): Promise<SubmittedGeneration>
  poll(sub: Pick<SubmittedGeneration, 'statusUrl' | 'responseUrl'>): Promise<GenerationState>
  /** Fetch the finished bytes, for handing straight to storeAsset. */
  fetchBytes(url: string): Promise<ArrayBuffer>
}

export function falProvider(apiKey: string): FalProvider {
  if (!apiKey) throw new FalError('no_api_key', 'FAL_KEY is not configured')
  const auth = { Authorization: `Key ${apiKey}` }

  return {
    name: 'fal',

    async submit(model, req) {
      if (!req.prompt.trim() && !req.imageUrl) {
        throw new FalError('invalid_request', 'a prompt or an input image is required')
      }
      if (model.needsImage && !req.imageUrl) {
        throw new FalError(
          'invalid_request',
          `${model.name} builds from an image — pass imageUrl (an image asset in this project, or any public URL)`,
        )
      }

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
