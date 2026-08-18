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
].join('\n')

const MODEL_NAMES = FAL_MODELS.map((m) => m.name) as [string, ...string[]]

const genArgs = {
  projectId: PROJECT_ID,
  prompt: z.string().min(1).describe('what to generate'),
  path: z
    .string()
    .optional()
    .describe('where to file it, e.g. /images/hero.jpg; defaults to a name from the prompt'),
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
      '**Nothing puts this in a frame yet.** There is no image node in the document, so a generated still lives in the project filesystem until the video phase lands one. Use it for reference, for export, or for feeding an image-to-3D model.',
    ].join('\n'),
    costsCredits: true,
    args: z.object({
      ...genArgs,
      model: z.enum(MODEL_NAMES).default('flux-schnell'),
      aspectRatio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']).default('1:1'),
    }),
    async handler(ctx, { projectId, prompt, model, aspectRatio, path }) {
      const r = await startGeneration(ctx.env, projectId, ctx.userId, {
        model,
        prompt,
        aspectRatio,
        ...(path ? { path } : {}),
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
      '**Nothing plays this in a frame yet.** The document has no video node, and compositing decoded video through the current per-frame capture path is the reason plans/003 replaces that path with WebCodecs first. The clip is a project asset you can download; putting it on a timeline is the general-video phase.',
    ].join('\n'),
    costsCredits: true,
    args: z.object({
      ...genArgs,
      model: z.enum(MODEL_NAMES).default('ltx-video'),
      aspectRatio: z.enum(['16:9', '9:16', '1:1']).optional(),
      durationSec: z.number().positive().max(30).optional().describe('where the model accepts one'),
    }),
    async handler(ctx, { projectId, prompt, model, aspectRatio, durationSec, path }) {
      const r = await startGeneration(ctx.env, projectId, ctx.userId, {
        model,
        prompt,
        ...(aspectRatio ? { aspectRatio } : {}),
        ...(durationSec ? { durationSec } : {}),
        ...(path ? { path } : {}),
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
    async handler(ctx, { projectId, prompt, model, durationSec, path }) {
      const r = await startGeneration(ctx.env, projectId, ctx.userId, {
        model,
        prompt,
        durationSec,
        ...(path ? { path } : {}),
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
      '**The engine cannot draw this.** `add_mesh` renders *parametric* solids — a sphere, a torus, a cube — described by a few numbers. A generated GLB is an imported vertex list, typically 50k–200k triangles against a 4,000-triangle ceiling, and reading one needs a binary parser plus decimation. That work is scoped in plans/009 and is deliberately not in this phase. Generate GLBs to export or hand to another tool; use add_mesh for solids that go in the video.',
    ].join('\n'),
    costsCredits: true,
    args: z.object({
      projectId: PROJECT_ID,
      imageUrl: z.string().url().describe('public URL of the image to lift into 3D'),
      prompt: z.string().default('').describe('optional hint; most image-to-3D models ignore it'),
      model: z.enum(MODEL_NAMES).default('trellis'),
      path: z.string().optional().describe('e.g. /models/statue.glb'),
    }),
    async handler(ctx, { projectId, imageUrl, prompt, model, path }) {
      const r = await startGeneration(ctx.env, projectId, ctx.userId, {
        model,
        prompt,
        imageUrl,
        ...(path ? { path } : {}),
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
}): string {
  if (r.status === 'done') {
    const kb = r.bytes ? `, ${Math.round(r.bytes / 1024)}KB` : ''
    return `generated with ${r.model}: ${r.path ?? 'stored'}${kb}, cost ${r.cost} credits (asset ${r.assetId})`
  }
  if (r.status === 'failed') {
    return `${r.model} failed: ${r.error} — the ${r.cost} credits were refunded`
  }
  return (
    `${r.model} is still running after ${r.waitedSec ?? 0}s (job ${r.jobId}, ${r.cost} credits). ` +
    `Call get_generation_status with this projectId to collect it.`
  )
}
