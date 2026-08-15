import { CREDIT_COSTS, docDuration } from '@euclid/dsl'
import { adjustCredits, getBalance } from '../billing'
import { docOf, requireProjectAccess } from '../shared'
import type { Env } from '../env'

export interface RenderJobRow {
  id: string
  project_id?: string
  user_id?: string
  status: string
  cost: number
  output_key: string | null
  created_at: number
}

export const JOB_TERMINAL = ['done', 'failed']

export class RenderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

export function downloadUrlFor(
  origin: string,
  job: { id: string; status: string; output_key: string | null },
): string | null {
  return job.status === 'done' && job.output_key ? `${origin}/api/jobs/${job.id}/download` : null
}

/**
 * Price the video, debit up front, and create a `queued` job. The render
 * worker drives it from there — and a `failed` job refunds automatically, so
 * nothing here needs to compensate.
 */
export async function startRender(
  env: Env,
  projectId: string,
  userId: string,
): Promise<{ jobId: string; cost: number; seconds: number; status: 'queued' }> {
  await requireProjectAccess(env, projectId, userId)
  const doc = await docOf(env, projectId)
  if (!doc) throw new RenderError('project_not_found', 'project has no document', 404)

  const seconds = Math.ceil(docDuration(doc))
  if (seconds === 0) {
    throw new RenderError('empty_project', 'nothing to render — add a scene first', 400)
  }
  const perSecond =
    doc.canvas.height > 720 ? CREDIT_COSTS.renderPerSecond1080 : CREDIT_COSTS.renderPerSecond720
  const cost = Math.ceil(seconds * perSecond)

  const balance = await getBalance(env, userId)
  if (balance < cost) {
    throw new RenderError('insufficient_credits', 'not enough credits', 402, {
      required: cost,
      balance,
    })
  }

  const jobId = crypto.randomUUID()
  await adjustCredits(env, userId, -cost, `render:${jobId}`)
  await env.DB.prepare(
    `INSERT INTO render_jobs (id, project_id, user_id, status, cost, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
  )
    .bind(jobId, projectId, userId, cost, Date.now(), Date.now())
    .run()

  // TODO(render): push jobId onto a Cloudflare Queue consumed by the container
  // worker (apps/renderer). Until the queue is wired, run the renderer manually:
  //   pnpm --filter @euclid/renderer render -- --project <id> --job <jobId>
  // The worker then drives this job to done/failed (failure refunds the cost).
  return { jobId, cost, seconds, status: 'queued' }
}

export async function listRenderJobs(
  env: Env,
  projectId: string,
  origin: string,
): Promise<(RenderJobRow & { downloadUrl: string | null })[]> {
  const rows = await env.DB.prepare(
    'SELECT id, status, cost, output_key, created_at FROM render_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 20',
  )
    .bind(projectId)
    .all<RenderJobRow>()
  return rows.results.map((j) => ({ ...j, downloadUrl: downloadUrlFor(origin, j) }))
}
