import { z } from 'zod'
import { FAL_MODELS, modelsOfKind, type GenKind } from '../fal'
import {
  GenerationError,
  collectPending,
  listGenerations,
  startGeneration,
} from '../services/generate'
import { PROJECT_ID } from './schemas'
import { capability, said, CapabilityError } from './types'

function asCapabilityError(e: unknown): never {
  if (e instanceof GenerationError) {
    const extra = Object.entries(e.extra)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')
    throw new CapabilityError(`${e.message}${extra ? ` (${extra})` : ''}`, e.status)
  }
  throw e
}

/** The roster, rendered into the tool doc so the choice is visible without a second call. */
function rosterFor(kind: GenKind): string {
  return modelsOfKind(kind)
    .map((m) => `- \`${m.name}\` — ${m.credits} credits, ~${m.typicalSec}s. ${m.summary}`)
    .join('\n')
}

const WAITING = [
  '',
  'Fast models are waited for inline and return the asset directly. Anything slower comes back `pending` with a job id — call get_generation_status to collect it. Polling is free and cannot double-charge.',
  '',
  'A generation that fails refunds its credits in full, so a failure costs time and nothing else.',
  '',
  'In review mode the file lands **pending the human\'s approval** — call request_review on it and wait before placing it. When iterating on a rejected file, pass `revises` with the old asset id so the versions stay linked and the human can compare them.',
].join('\n')

const MODEL_NAMES = FAL_MODELS.map((m) => m.name) as [string, ...string[]]

const genArgs = {
  projectId: PROJECT_ID,
  prompt: z.string().min(1).describe('what to generate'),
  path: z
    .string()
    .optional()
    .describe('where to file it, e.g. /images/hero.jpg; defaults to a name from the prompt'),
  revises: z
    .string()
    .optional()
    .describe('asset id this replaces — links the versions so the review UI can compare them'),
}

export const genTools = [
  capability({
    name: 'generate_image',
    summary: 'Generate a still image into the project. SPENDS CREDITS.',
    doc: [
      '**Costs credits**, priced per model. The image is stored as a project asset and appears in list_assets.',
      '',
      'Models:',
      rosterFor('image'),
      '',
      'Iterate on `flux-schnell` and only move up once the prompt is settled — the expensive models are not better at telling you whether the composition is right.',
      WAITING,
      '',
      '**Then put it in a scene with `add_image`**, which draws the still as an ordinary node — camera, animation and write_on all work on it. It can also feed generate_3d, though that needs a publicly reachable URL rather than a project asset.',
    ].join('\n'),
    costsCredits: true,
    args: z.object({
      ...genArgs,
      model: z.enum(MODEL_NAMES).default('flux-schnell'),
      aspectRatio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']).default('1:1'),
    }),
    async handler(ctx, { projectId, prompt, model, aspectRatio, path, revises }) {
      const r = await startGeneration(ctx.env, projectId, ctx.userId, {
        model,
        prompt,
        aspectRatio,
        ...(path ? { path } : {}),
        ...(revises ? { revises } : {}),
      }).catch(asCapabilityError)
      return said(describe(r), r)
    },
  }),

  capability({
    name: 'generate_video',
    summary: 'Generate a video clip into the project. SPENDS CREDITS.',
    doc: [
      '**Costs credits**, and takes minutes rather than seconds — expect a job id back, not a file.',
      '',
      'Models:',
      rosterFor('video'),
      WAITING,
      '',
      '**Then put it in a scene with `add_video`**, which plays the clip as an ordinary node. Note that video is much slower to render than anything else — every frame seeks the source and copies a picture out of it.',
    ].join('\n'),
    costsCredits: true,
    args: z.object({
      ...genArgs,
      model: z.enum(MODEL_NAMES).default('ltx-video'),
      aspectRatio: z.enum(['16:9', '9:16', '1:1']).optional(),
      durationSec: z.number().positive().max(30).optional().describe('where the model accepts one'),
    }),
    async handler(ctx, { projectId, prompt, model, aspectRatio, durationSec, path, revises }) {
      const r = await startGeneration(ctx.env, projectId, ctx.userId, {
        model,
        prompt,
        ...(aspectRatio ? { aspectRatio } : {}),
        ...(durationSec ? { durationSec } : {}),
        ...(path ? { path } : {}),
        ...(revises ? { revises } : {}),
      }).catch(asCapabilityError)
      return said(describe(r), r)
    },
  }),

  capability({
    name: 'generate_audio',
    summary: 'Generate music or a sound bed. SPENDS CREDITS.',
    doc: [
      '**Costs credits.** For music, ambience and sound effects.',
      '',
      '**This is not narration.** Speech belongs to generate_narration, which uses a provider chosen for word-level timestamps — the thing captions and narration-anchored animation are built on. Nothing here returns timings.',
      '',
      'Models:',
      rosterFor('audio'),
      WAITING,
    ].join('\n'),
    costsCredits: true,
    args: z.object({
      ...genArgs,
      model: z.enum(MODEL_NAMES).default('stable-audio'),
      durationSec: z.number().positive().max(120).default(30),
    }),
    async handler(ctx, { projectId, prompt, model, durationSec, path, revises }) {
      const r = await startGeneration(ctx.env, projectId, ctx.userId, {
        model,
        prompt,
        durationSec,
        ...(path ? { path } : {}),
        ...(revises ? { revises } : {}),
      }).catch(asCapabilityError)
      return said(describe(r), r)
    },
  }),

  capability({
    name: 'generate_3d',
    summary: 'Turn an image into a 3D model file (GLB). SPENDS CREDITS.',
    doc: [
      '**Costs credits.** Takes an image and returns a GLB, stored as a project asset.',
      '',
      'Models:',
      rosterFor('model'),
      '',
      '`imageUrl` must be reachable by the provider — a public URL, or a data URL. An asset id is not enough on its own, because project assets are not publicly readable.',
      WAITING,
      '',
      '**Then put it in the video with `import_mesh`**, which reads the GLB this produces and lands it as an ordinary mesh node — camera, animation and write_on all work on it. It is simplified on the way in, because imported geometry is stored in the document and the document has a hard size budget; the response says what it started from and what it became.',
      '',
      '`trellis` is the better source to import: it returns far fewer triangles than `hunyuan3d`, and both are reduced to the same ceiling, so hunyuan3d discards much more of what you paid for. Use `add_mesh` instead when a plain solid — sphere, cylinder, cone — would do, since it costs nothing and stays sharp at any size.',
    ].join('\n'),
    costsCredits: true,
    args: z.object({
      projectId: PROJECT_ID,
      imageUrl: z.string().url().describe('public URL of the image to lift into 3D'),
      prompt: z.string().default('').describe('optional hint; most image-to-3D models ignore it'),
      model: z.enum(MODEL_NAMES).default('trellis'),
      path: z.string().optional().describe('e.g. /models/statue.glb'),
      revises: z
        .string()
        .optional()
        .describe('asset id this replaces — links the versions for review'),
    }),
    async handler(ctx, { projectId, imageUrl, prompt, model, path, revises }) {
      const r = await startGeneration(ctx.env, projectId, ctx.userId, {
        model,
        prompt,
        imageUrl,
        ...(path ? { path } : {}),
        ...(revises ? { revises } : {}),
      }).catch(asCapabilityError)
      return said(describe(r), r)
    },
  }),

  capability({
    name: 'get_generation_status',
    summary: 'Recent generations; collects any that have finished.',
    doc: [
      'Free, and it is also what *advances* a pending job: there is no background worker, so asking is what collects a finished file into the project. Poll as often as you like — a collected job is never re-fetched or re-charged.',
      '',
      'A `done` job names its asset; a `failed` one has already been refunded.',
    ].join('\n'),
    args: z.object({ projectId: PROJECT_ID }),
    async handler(ctx, { projectId }) {
      await ctx.requireProject(projectId)
      await collectPending(ctx.env, projectId, ctx.userId).catch(() => {
        // Reporting what we know beats failing the whole call over one job.
      })
      const jobs = await listGenerations(ctx.env, projectId, ctx.userId)
      if (jobs.length === 0) return said('no generations yet', { jobs: [] })
      const now = Date.now()
      const age = (ms: number) => {
        const s = Math.max(0, Math.round((now - ms) / 1000))
        return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`
      }
      return said(
        jobs
          .map(
            (j) =>
              `${j.id.slice(0, 8)}  ${j.model.padEnd(13)} ${j.status.padEnd(8)} ${j.cost} credits  ` +
              `${age(j.created_at)} old` +
              (j.asset_id ? `  asset ${j.asset_id}` : '') +
              (j.error ? `  ${j.error.slice(0, 120)}` : ''),
          )
          .join('\n'),
        { jobs },
      )
    },
  }),
]

/** One sentence covering both the waited-for and the still-running outcome. */
function describe(r: {
  status: string
  model: string
  cost: number
  jobId: string
  assetId?: string
  path?: string
  bytes?: number
  error?: string
  waitedSec?: number
  reviewStatus?: 'pending' | 'approved'
}): string {
  if (r.status === 'done') {
    const kb = r.bytes ? `, ${Math.round(r.bytes / 1024)}KB` : ''
    const review =
      r.reviewStatus === 'pending'
        ? ' — PENDING REVIEW: call request_review and wait before placing it'
        : ''
    return `generated with ${r.model}: ${r.path ?? 'stored'}${kb}, cost ${r.cost} credits (asset ${r.assetId})${review}`
  }
  if (r.status === 'failed') {
    return `${r.model} failed: ${r.error} — the ${r.cost} credits were refunded`
  }
  return (
    `${r.model} is still running after ${r.waitedSec ?? 0}s (job ${r.jobId}, ${r.cost} credits). ` +
    `Call get_generation_status with this projectId to collect it.`
  )
}
