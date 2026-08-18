import { slugify } from '../shared'
import { adjustCredits, getBalance } from '../billing'
import { requireProjectAccess } from '../shared'
import {
  extensionFor,
  falModel,
  falProvider,
  readOutput,
  FalError,
  type FalModel,
  type GenKind,
  type GenerationRequest,
} from '../fal'
import { storeAsset } from './assets'
import type { Env } from '../env'

export class GenerationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

export interface GenerationJobRow {
  id: string
  project_id: string
  user_id: string
  provider: string
  model: string
  kind: string
  status: string
  cost: number
  prompt: string | null
  request_id: string
  status_url: string
  response_url: string
  asset_id: string | null
  error: string | null
  created_at: number
  updated_at: number
}

export interface GenerationResult {
  jobId: string
  model: string
  kind: GenKind
  cost: number
  status: 'pending' | 'done' | 'failed'
  assetId?: string
  path?: string
  bytes?: number
  durationSec?: number
  error?: string
  /** Seconds waited inline before handing back a job id. */
  waitedSec?: number
}

function providerOf(env: Env) {
  if (!env.FAL_KEY) {
    throw new GenerationError(
      'no_provider_key',
      'generation is not configured on this deployment — FAL_KEY is unset',
      501,
    )
  }
  return falProvider(env.FAL_KEY)
}

/**
 * How long a submit call will sit waiting for its own result before giving up
 * and handing back a job id.
 *
 * An image lands in a couple of seconds, and making the agent poll for that
 * would be a worse tool for no reason. A video takes minutes, which no request
 * can hold. One code path covers both: wait a little, then degrade to polling.
 * The ceiling is well inside a Worker's request budget.
 */
const INLINE_WAIT_MS = 20_000
const POLL_EVERY_MS = 1_500

/**
 * Submit a generation, debit for it, and wait briefly for the result.
 *
 * Credits are taken up front because the price is a property of the *model*,
 * so it is knowable before the work runs — the same argument ttsCost makes.
 * Anything that fails after the debit refunds it, including a provider failure
 * discovered minutes later during a poll.
 *
 * Lives here rather than in the catalog because credits, the provider, R2 and
 * the job row meet at one boundary; splitting it would create two refund paths.
 */
export async function startGeneration(
  env: Env,
  projectId: string,
  userId: string,
  args: {
    model: string
    prompt: string
    imageUrl?: string
    aspectRatio?: string
    durationSec?: number
    path?: string
    extra?: Record<string, unknown>
  },
): Promise<GenerationResult> {
  await requireProjectAccess(env, projectId, userId)
  const provider = providerOf(env)

  let model: FalModel
  try {
    model = falModel(args.model)
  } catch (e) {
    throw new GenerationError('unknown_model', (e as Error).message, 400)
  }

  const cost = model.credits
  const balance = await getBalance(env, userId)
  if (balance < cost) {
    throw new GenerationError('insufficient_credits', 'not enough credits', 402, {
      required: cost,
      balance,
    })
  }

  const req: GenerationRequest = {
    prompt: args.prompt,
    ...(args.imageUrl ? { imageUrl: args.imageUrl } : {}),
    ...(args.aspectRatio ? { aspectRatio: args.aspectRatio } : {}),
    ...(args.durationSec ? { durationSec: args.durationSec } : {}),
    ...(args.extra ? { extra: args.extra } : {}),
  }

  // Submit BEFORE debiting: a rejected request (no prompt, missing image) must
  // not cost anything, and the provider is the only thing that knows.
  let submitted
  try {
    submitted = await provider.submit(model, req)
  } catch (e) {
    const detail = e instanceof FalError ? e.message : String(e)
    const status = e instanceof FalError && e.code === 'invalid_request' ? 400 : 502
    throw new GenerationError('submit_failed', detail, status)
  }

  const jobId = crypto.randomUUID()
  await adjustCredits(env, userId, -cost, `gen:${jobId} (${model.name})`)

  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO generation_jobs
       (id, project_id, user_id, provider, model, kind, status, cost, prompt,
        request_id, status_url, response_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      jobId,
      projectId,
      userId,
      provider.name,
      model.name,
      model.kind,
      cost,
      args.prompt.slice(0, 500),
      submitted.requestId,
      submitted.statusUrl,
      submitted.responseUrl,
      now,
      now,
    )
    .run()

  // Wait for the fast models rather than making the caller poll for 3 seconds.
  const deadline = Date.now() + INLINE_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS))
    const settled = await collectGeneration(env, jobId, userId, args.path)
    if (settled.status !== 'pending') {
      return { ...settled, waitedSec: Math.round((Date.now() - now) / 1000) }
    }
  }

  return {
    jobId,
    model: model.name,
    kind: model.kind,
    cost,
    status: 'pending',
    waitedSec: Math.round((Date.now() - now) / 1000),
  }
}

/**
 * Poll one job and, if the provider is finished, pull the bytes into R2 and
 * register the asset.
 *
 * Idempotent: a job already `done` returns its asset without re-fetching, so
 * polling repeatedly is free and cannot duplicate a file.
 */
export async function collectGeneration(
  env: Env,
  jobId: string,
  userId: string,
  suggestedPath?: string,
): Promise<GenerationResult> {
  const job = await env.DB.prepare('SELECT * FROM generation_jobs WHERE id = ?')
    .bind(jobId)
    .first<GenerationJobRow>()
  if (!job) throw new GenerationError('job_not_found', `generation ${jobId} not found`, 404)
  if (job.user_id !== userId && userId !== 'internal') {
    throw new GenerationError('forbidden', 'not your generation', 403)
  }

  const base = {
    jobId: job.id,
    model: job.model,
    kind: job.kind as GenKind,
    cost: job.cost,
  }
  if (job.status === 'done') {
    return { ...base, status: 'done', ...(job.asset_id ? { assetId: job.asset_id } : {}) }
  }
  if (job.status === 'failed') {
    return { ...base, status: 'failed', ...(job.error ? { error: job.error } : {}) }
  }

  const provider = providerOf(env)
  const model = falModel(job.model)
  const state = await provider.poll({ statusUrl: job.status_url, responseUrl: job.response_url })

  if (state.status === 'pending') return { ...base, status: 'pending' }

  const fail = async (detail: string): Promise<GenerationResult> => {
    await adjustCredits(env, job.user_id, job.cost, `refund:gen:${job.id} (${detail.slice(0, 60)})`)
    await env.DB.prepare(
      "UPDATE generation_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
    )
      .bind(detail.slice(0, 500), Date.now(), job.id)
      .run()
    return { ...base, status: 'failed', error: detail }
  }

  if (state.status === 'failed') return fail(state.detail)

  // fal hands back a JSON body whose shape only the roster entry understands.
  let output
  try {
    output = readOutput(model, state.output)
  } catch (e) {
    return fail((e as Error).message)
  }

  try {
    const bytes = await provider.fetchBytes(output.url)
    const ext = extensionFor(output.mime, model.kind)
    const name = suggestedPath ?? `/${model.kind}s/${slugify(job.prompt ?? model.name) || model.name}.${ext}`
    const stored = await storeAsset(env, job.project_id, {
      kind: model.kind,
      mime: output.mime,
      durationSec: output.durationSec ?? null,
      path: name,
      body: bytes,
    })
    await env.DB.prepare(
      "UPDATE generation_jobs SET status = 'done', asset_id = ?, updated_at = ? WHERE id = ?",
    )
      .bind(stored.assetId, Date.now(), job.id)
      .run()
    return {
      ...base,
      status: 'done',
      assetId: stored.assetId,
      path: stored.path,
      bytes: stored.bytes,
      ...(output.durationSec ? { durationSec: output.durationSec } : {}),
    }
  } catch (e) {
    // The provider did its work but we could not keep it. Refunding is still
    // right: the user has nothing to show for the credits.
    return fail(`could not store the generated file: ${(e as Error).message}`)
  }
}

/** Every generation in a project, newest first — the agent's poll surface. */
export async function listGenerations(
  env: Env,
  projectId: string,
  userId: string,
): Promise<GenerationJobRow[]> {
  await requireProjectAccess(env, projectId, userId)
  const rows = await env.DB.prepare(
    'SELECT * FROM generation_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 20',
  )
    .bind(projectId)
    .all<GenerationJobRow>()
  return rows.results
}

/**
 * Collect every pending job in a project. This is what `get_generation_status`
 * calls, so simply asking about a project is also what advances it — there is
 * no worker, and a job nobody asks about is one nobody is waiting for.
 */
export async function collectPending(
  env: Env,
  projectId: string,
  userId: string,
): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id FROM generation_jobs WHERE project_id = ? AND status = 'pending'",
  )
    .bind(projectId)
    .all<{ id: string }>()
  for (const r of rows.results) {
    await collectGeneration(env, r.id, userId).catch(() => {
      // One stuck job must not hide the others' progress.
    })
  }
}
