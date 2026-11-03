import { slugify } from '../shared'
import { adjustCredits, getBalance } from '../billing'
import { mayAccess, requireProjectAccess } from '../shared'
import {
  checkRequest,
  extensionFor,
  priceOf,
  falModel,
  falProvider,
  readOutput,
  FalError,
  type FalModel,
  type GenKind,
  type GenerationRequest,
} from '../fal'
import { requireAsset, storeAsset } from './assets'
import { PlanGateError, chargePlanBudget, refundPlanBudget, reviewModeOf } from './plan'
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
  /** The plan revision whose budget this drew from; NULL when ungated. */
  plan_id: string | null
  /** The asset this generation iterates on; copied onto the stored asset row. */
  revises: string | null
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
  /** Where the stored file starts with the human (plans/010). */
  reviewStatus?: 'pending' | 'approved'
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
 * fal fetches the reference image itself, and project assets are not publicly
 * readable — the read route is behind the same auth as everything else. So an
 * asset id cannot be handed over as a link; the bytes are inlined as a data
 * URL instead.
 *
 * This is what makes the grounding recipe work at all (docs/recipes.md): the
 * image you want to ground on is almost always one this system just generated,
 * which means it is an asset, not a URL. A signed asset URL (plans/003 §5)
 * would be the cheaper mechanism and is still worth having — it would replace
 * the body of this function and nothing else.
 *
 * The cap is on the *encoded* size, since that is what the request carries.
 */
const MAX_INLINE_BYTES = 3 * 1024 * 1024

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  // Chunked: String.fromCharCode(...bytes) on a multi-megabyte array blows the
  // argument limit, and does it as a RangeError nobody would connect to size.
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

async function resolveImageUrl(
  env: Env,
  userId: string,
  ref: string,
): Promise<string> {
  if (/^(https?|data):/i.test(ref)) return ref

  let asset
  try {
    asset = await requireAsset(env, ref, userId)
  } catch {
    throw new GenerationError(
      'image_not_found',
      `imageUrl "${ref}" is neither a URL nor an asset you can read. Pass a public URL, ` +
        `a data: URL, or the id of an image asset — list_assets shows the ids`,
      404,
    )
  }
  if (asset.kind !== 'image') {
    throw new GenerationError(
      'image_wrong_kind',
      `asset ${ref} is a ${asset.kind}, and a generation can only be grounded on an image. ` +
        `To ground on a moment of a video, capture the frame first`,
      400,
    )
  }
  if (asset.bytes > MAX_INLINE_BYTES) {
    throw new GenerationError(
      'image_too_large',
      `asset ${ref} is ${Math.round(asset.bytes / 1024)}KB, over the ${MAX_INLINE_BYTES / 1024}KB ` +
        `inline limit — it has to travel to the provider inside the request. Use a smaller image`,
      413,
    )
  }
  const object = await env.ASSETS.get(asset.r2_key)
  if (!object) {
    throw new GenerationError('image_missing', `asset ${ref} has no stored bytes`, 410)
  }
  return `data:${asset.mime};base64,${toBase64(await object.arrayBuffer())}`
}

/**
 * The rows behind reference videos, with the rule that they be assets.
 *
 * A URL would do for fal, but not for us: a per-second model is priced from the
 * reference's length, and only a probed asset knows its length. So an id is
 * required, and one whose probe has not run yet is refused with "ask again"
 * rather than priced as zero seconds.
 */
async function loadVideoRefs(
  env: Env,
  userId: string,
  model: FalModel,
  ids: string[],
): Promise<{ id: string; durationSec: number }[]> {
  const out: { id: string; durationSec: number }[] = []
  for (const id of ids) {
    if (/^(https?|data):/i.test(id)) {
      throw new GenerationError(
        'reference_needs_asset',
        `referenceVideos takes asset ids, not URLs — the price depends on each video's length, ` +
          `and only a stored, probed file has one. Import or upload it first`,
        400,
      )
    }
    let asset
    try {
      asset = await requireAsset(env, id, userId)
    } catch {
      throw new GenerationError('reference_not_found', `reference video ${id} is not an asset you can read — see list_assets`, 404)
    }
    if (asset.kind !== 'video') {
      throw new GenerationError('reference_wrong_kind', `reference ${id} is a ${asset.kind}; referenceVideos takes videos`, 400)
    }
    if (!asset.duration_sec) {
      throw new GenerationError(
        'reference_not_probed',
        `reference video ${id} has not been measured yet — probing runs in the background after the file lands. Ask again shortly`,
        409,
      )
    }
    const range = model.takesReferences
    if (range && (asset.duration_sec < range.videoSecMin || asset.duration_sec > range.videoSecMax)) {
      throw new GenerationError(
        'reference_bad_length',
        `reference video ${id} is ${asset.duration_sec.toFixed(2)}s; ${model.name} takes ` +
          `${range.videoSecMin}–${range.videoSecMax}s per video. Join short shots into one reference, or trim a long one`,
        400,
      )
    }
    out.push({ id, durationSec: asset.duration_sec })
  }
  return out
}

/** A reference, made reachable: URLs pass through, assets go to fal's CDN. */
async function uploadReference(
  env: Env,
  userId: string,
  provider: ReturnType<typeof falProvider>,
  ref: string,
  kind: 'image' | 'video',
): Promise<string> {
  if (/^(https?|data):/i.test(ref)) return ref
  let asset
  try {
    asset = await requireAsset(env, ref, userId)
  } catch {
    throw new GenerationError('reference_not_found', `reference ${ref} is not an asset you can read — see list_assets`, 404)
  }
  if (asset.kind !== kind) {
    throw new GenerationError('reference_wrong_kind', `reference ${ref} is a ${asset.kind}, expected ${kind}`, 400)
  }
  const object = await env.ASSETS.get(asset.r2_key)
  if (!object) throw new GenerationError('reference_missing', `asset ${ref} has no stored bytes`, 410)
  try {
    return await provider.upload(await object.arrayBuffer(), asset.mime, `${asset.id}.${asset.mime.split('/')[1] ?? 'bin'}`)
  } catch (e) {
    throw new GenerationError('reference_upload_failed', (e as Error).message, 502)
  }
}

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
    strength?: number
    /** Asset ids or URLs, in @Image1… order. */
    referenceImages?: string[]
    /** Video asset ids, in @Video1… order — ids only, since the price needs their length. */
    referenceVideos?: string[]
    resolution?: string
    aspectRatio?: string
    durationSec?: number
    path?: string
    /** The asset this generation replaces — recorded as lineage (plans/010). */
    revises?: string
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

  // Reference videos are looked up first, and only in the database: their
  // lengths are part of the price and part of what checkRequest enforces, and
  // reading a row costs nothing, where reading the bytes does.
  const videoRefs = await loadVideoRefs(env, userId, model, args.referenceVideos ?? [])
  const referenceVideoSec = videoRefs.length
    ? videoRefs.reduce((sum, v) => sum + v.durationSec, 0)
    : undefined

  // Checked here, against the raw arguments, so a combination the model cannot
  // accept is refused before the plan budget is drawn down or any reference is
  // read out of R2. `submit` checks it again at the seam.
  const raw: GenerationRequest = {
    prompt: args.prompt,
    ...(args.imageUrl ? { imageUrl: args.imageUrl } : {}),
    ...(args.strength !== undefined ? { strength: args.strength } : {}),
    ...(args.referenceImages?.length ? { referenceImages: args.referenceImages } : {}),
    ...(videoRefs.length ? { referenceVideos: videoRefs.map((v) => v.id) } : {}),
    ...(referenceVideoSec !== undefined ? { referenceVideoSec } : {}),
    ...(args.resolution ? { resolution: args.resolution } : {}),
    ...(args.aspectRatio ? { aspectRatio: args.aspectRatio } : {}),
    ...(args.durationSec ? { durationSec: args.durationSec } : {}),
  }
  try {
    checkRequest(model, raw)
  } catch (e) {
    throw new GenerationError('invalid_request', (e as Error).message, 400)
  }

  if (args.revises) {
    const prior = await env.DB.prepare(
      'SELECT id, kind FROM assets WHERE id = ? AND project_id = ?',
    )
      .bind(args.revises, projectId)
      .first<{ id: string; kind: string }>()
    if (!prior) {
      throw new GenerationError(
        'revises_not_found',
        `revises names asset ${args.revises}, which is not in this project — see list_assets`,
        404,
      )
    }
    if (prior.kind !== model.kind) {
      throw new GenerationError(
        'revises_kind_mismatch',
        `revises names a ${prior.kind} asset, but ${model.name} generates ${model.kind} — ` +
          `a revision replaces a file of its own kind`,
        400,
      )
    }
  }

  // Read before anything is charged: resolving an asset id can fail (wrong
  // kind, too large, not readable), and a failure after the plan drawdown
  // below would strand budget that only `submit` knows how to refund.
  const imageUrl = args.imageUrl
    ? await resolveImageUrl(env, userId, args.imageUrl)
    : undefined
  // References go to fal's CDN rather than inline: a video is megabytes, and
  // a reference photo is routinely over the inline ceiling too.
  const referenceImages = await Promise.all(
    (args.referenceImages ?? []).map((ref) => uploadReference(env, userId, provider, ref, 'image')),
  )
  const referenceVideos = await Promise.all(
    videoRefs.map((v) => uploadReference(env, userId, provider, v.id, 'video')),
  )

  const cost = priceOf(model, raw)
  const balance = await getBalance(env, userId)
  if (balance < cost) {
    throw new GenerationError('insufficient_credits', 'not enough credits', 402, {
      required: cost,
      balance,
    })
  }

  // The review-mode gate (plans/010): while it is on, this call must fit the
  // approved plan's roster and remaining budget. Drawn down before the
  // provider sees the request, so a refusal has no side effects; everything
  // after this refunds the drawdown on failure, alongside the credits.
  let planId: string | null = null
  try {
    planId = (await chargePlanBudget(env, projectId, model.kind, cost))?.planId ?? null
  } catch (e) {
    if (e instanceof PlanGateError) throw new GenerationError(e.code, e.message, e.status)
    throw e
  }

  const req: GenerationRequest = {
    ...raw,
    ...(imageUrl ? { imageUrl } : {}),
    ...(referenceImages.length ? { referenceImages } : {}),
    ...(referenceVideos.length ? { referenceVideos } : {}),
    prompt: args.prompt,
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
    if (planId) await refundPlanBudget(env, projectId, planId, cost)
    const detail = e instanceof FalError ? e.message : String(e)
    const status = e instanceof FalError && e.code === 'invalid_request' ? 400 : 502
    throw new GenerationError('submit_failed', detail, status)
  }

  const jobId = crypto.randomUUID()
  await adjustCredits(env, userId, -cost, `gen:${jobId} (${model.name})`)

  const now = Date.now()
  // plan_id records which plan's budget this drew from, so a failure found
  // minutes later during a poll can return the budget where it came from.
  await env.DB.prepare(
    `INSERT INTO generation_jobs
       (id, project_id, user_id, provider, model, kind, status, cost, prompt,
        request_id, status_url, response_url, plan_id, revises, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      planId,
      args.revises ?? null,
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
  if (!mayAccess(job.user_id, userId)) {
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
    if (job.plan_id) await refundPlanBudget(env, job.project_id, job.plan_id, job.cost)
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
    // Capped: a slug of the whole prompt made 491-character paths for the
    // long reference prompts, which then overflowed every surface that names
    // the file (a review question refused them outright).
    const slug = slugify(job.prompt ?? model.name).slice(0, 60).replace(/-+$/, '')
    const name = suggestedPath ?? `/${model.kind}s/${slug || model.name}.${ext}`
    // Provenance sets the initial review status (plans/010): a generated file
    // is born pending while the project is in review mode — judged at collect
    // time, since that is when the file exists to be judged.
    const pending = await reviewModeOf(env, job.project_id)
    const stored = await storeAsset(env, job.project_id, {
      kind: model.kind,
      mime: output.mime,
      durationSec: output.durationSec ?? null,
      path: name,
      body: bytes,
      review: {
        status: pending ? 'pending' : 'approved',
        ...(pending ? {} : { via: 'auto' as const, note: 'review mode off' }),
        revises: job.revises,
      },
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
      reviewStatus: pending ? 'pending' : 'approved',
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
