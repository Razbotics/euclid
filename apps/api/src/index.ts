import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  CREDIT_COSTS,
  docDuration,
  documentCues,
  op,
  toSRT,
  toVTT,
  ttsCost,
  type EuclidDoc,
  type Op,
} from '@euclid/dsl'
import { makeAuth } from './auth'
import { adjustCredits, billing, getBalance, handleStripeWebhook } from './billing'
import { elevenLabsProvider, TtsError } from './tts'
import type { Env, Vars } from './env'

export { ProjectDO } from './do'

const app = new Hono<{ Bindings: Env; Variables: Vars }>()

app.use(
  '/api/*',
  cors({
    origin: (origin, c) => (origin === c.env.APP_ORIGIN ? origin : undefined),
    credentials: true,
  }),
)

// Public: auth + Stripe webhook
app.on(['GET', 'POST'], '/api/auth/*', (c) => makeAuth(c.env).handler(c.req.raw))
app.post('/api/billing/webhook', (c) => handleStripeWebhook(c.env, c.req.raw))

// Everything else requires a session — or the internal service key (MCP/render workers)
app.use('/api/*', async (c, next) => {
  const internal = c.req.header('x-internal-key')
  if (internal) {
    if (internal !== c.env.INTERNAL_API_KEY) return c.json({ error: 'forbidden' }, 403)
    c.set('userId', c.req.header('x-user-id') ?? 'internal')
    return next()
  }
  const session = await makeAuth(c.env).api.getSession({ headers: c.req.raw.headers })
  if (session) {
    c.set('userId', session.user.id)
    return next()
  }
  if (c.env.DEV_ALLOW_ANON === '1') {
    c.set('userId', 'dev-user')
    return next()
  }
  return c.json({ error: 'unauthorized' }, 401)
})

app.route('/api/billing', billing)

// ---------- projects ----------

app.get('/api/projects', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, name, created_at FROM projects WHERE user_id = ? ORDER BY created_at DESC',
  )
    .bind(c.get('userId'))
    .all()
  return c.json({ projects: rows.results })
})

app.post('/api/projects', async (c) => {
  const { name } = (await c.req.json()) as { name: string }
  if (!name?.trim()) return c.json({ error: 'name_required' }, 400)
  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, c.get('userId'), name.trim(), Date.now())
    .run()
  await projectStub(c.env, id).fetch('https://do/init', {
    method: 'POST',
    body: JSON.stringify({ id, name: name.trim() }),
  })
  return c.json({ id, name: name.trim() })
})

/** Ownership gate + forward to the project's Durable Object. */
async function forwardToDO(
  c: { env: Env; get: (k: 'userId') => string; req: { raw: Request } },
  projectId: string,
  doPath: string,
): Promise<Response> {
  const row = await c.env.DB.prepare('SELECT user_id FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ user_id: string }>()
  if (!row) return Response.json({ error: 'project_not_found' }, { status: 404 })
  const userId = c.get('userId')
  if (row.user_id !== userId && userId !== 'internal') {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  const url = new URL(c.req.raw.url)
  return projectStub(c.env, projectId).fetch(
    new Request(`https://do${doPath}${url.search}`, c.req.raw),
  )
}

app.get('/api/projects/:id/doc', (c) => forwardToDO(c, c.req.param('id'), '/doc'))
app.get('/api/projects/:id/events', (c) => forwardToDO(c, c.req.param('id'), '/events'))
app.post('/api/projects/:id/ops', (c) => forwardToDO(c, c.req.param('id'), '/ops'))
app.get('/api/projects/:id/ws', (c) => forwardToDO(c, c.req.param('id'), '/ws'))

// ---------- captions ----------

/**
 * Derived from the document, so it's always current and costs no credits.
 * Cues are word-accurate where TTS timings exist and estimated from text
 * elsewhere; `?format=json` exposes which is which per cue.
 */
app.get('/api/projects/:id/captions', async (c) => {
  const docRes = await forwardToDO(c, c.req.param('id'), '/doc')
  if (!docRes.ok) return docRes
  const { doc } = (await docRes.json()) as { doc: EuclidDoc }
  const cues = documentCues(doc)
  const format = c.req.query('format') ?? 'srt'

  if (format === 'json') return c.json({ cues, estimated: cues.some((q) => q.estimated) })
  if (format !== 'srt' && format !== 'vtt') return c.json({ error: 'unsupported_format' }, 400)

  const body = format === 'vtt' ? toVTT(cues) : toSRT(cues)
  return new Response(body, {
    headers: {
      'content-type': format === 'vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8',
      'content-disposition': `attachment; filename="${slugify(doc.name)}.${format}"`,
    },
  })
})

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'captions'
}

// ---------- narration (TTS) ----------

/**
 * Synthesize a scene's narration, store the audio as an asset, and write the
 * result back into the document as a `system` op — so the editor sees it
 * appear live and the agent can read the real duration before choreographing
 * against it.
 *
 * Credits are debited up front (the price is a function of the text, so it's
 * knowable before synthesis) and refunded if anything after the debit fails.
 */
app.post('/api/projects/:id/scenes/:sceneId/narration/generate', async (c) => {
  const projectId = c.req.param('id')
  const sceneId = c.req.param('sceneId')

  const docRes = await forwardToDO(c, projectId, '/doc') // also the ownership gate
  if (!docRes.ok) return docRes
  const { doc } = (await docRes.json()) as { doc: EuclidDoc }

  const scene = doc.scenes.find((s) => s.id === sceneId)
  if (!scene) return c.json({ error: 'scene_not_found', sceneId }, 404)

  const body = (await c.req.json().catch(() => ({}))) as { text?: string; voiceId?: string }
  const text = (body.text ?? scene.narration?.text ?? '').trim()
  if (!text) {
    return c.json({ error: 'no_narration_text', detail: 'set narration text first, or pass text' }, 400)
  }
  const voiceId = body.voiceId ?? scene.narration?.voiceId

  const cost = ttsCost(text)
  const userId = c.get('userId')
  const balance = await getBalance(c.env, userId)
  if (balance < cost) return c.json({ error: 'insufficient_credits', required: cost, balance }, 402)

  // One id ties the debit and any refund together in the ledger, the same way
  // a job id does for renders.
  const ttsId = crypto.randomUUID()
  await adjustCredits(c.env, userId, -cost, `tts:${ttsId} (${sceneId})`)
  const refund = (why: string) =>
    adjustCredits(c.env, userId, cost, `refund:${ttsId} (${why})`)

  let synthesis
  try {
    synthesis = await elevenLabsProvider(c.env.ELEVENLABS_API_KEY).synthesize({ text, voiceId })
  } catch (e) {
    const detail = e instanceof TtsError ? e.message : String(e)
    await refund('tts failed')
    return c.json({ error: 'tts_failed', detail, refunded: cost }, 502)
  }

  let assetId: string
  try {
    assetId = (
      await storeAsset(c.env, projectId, {
        kind: 'audio',
        mime: synthesis.mime,
        durationSec: synthesis.durationSec,
        body: synthesis.audio,
      })
    ).assetId
    await submitSystemOps(c.env, projectId, [
      op.setNarration(sceneId, {
        text,
        voiceId,
        audio: { assetId, durationSec: synthesis.durationSec, words: synthesis.words },
      }),
    ])
  } catch (e) {
    await refund('store failed')
    return c.json({ error: 'narration_store_failed', detail: String(e), refunded: cost }, 500)
  }

  // Overflow is reported, not enforced: the mismatch is only knowable after
  // synthesis, so rejecting here would discard audio the user just paid for
  // and make the retry cost again. The agent still decides what to change.
  const fits = synthesis.durationSec <= scene.duration
  const suggested = Math.ceil(synthesis.durationSec * 10) / 10
  return c.json({
    assetId,
    sceneId,
    cost,
    durationSec: synthesis.durationSec,
    words: synthesis.words.length,
    sceneDuration: scene.duration,
    fits,
    ...(fits
      ? {}
      : {
          warning:
            `narration runs ${synthesis.durationSec.toFixed(2)}s but scene "${sceneId}" is ` +
            `${scene.duration}s, so ${(synthesis.durationSec - scene.duration).toFixed(2)}s would be cut. ` +
            `The audio is saved and already in the document — either call ` +
            `update_scene(sceneId="${sceneId}", duration=${suggested}) or shorten the script and regenerate.`,
        }),
  })
})

/**
 * Submit ops to a project's DO as the `system` actor, rebasing on conflict.
 * Used by server-side producers that have no client version to work from.
 */
async function submitSystemOps(env: Env, projectId: string, ops: Op[]): Promise<void> {
  const stub = projectStub(env, projectId)
  let lastError = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    const docRes = await stub.fetch('https://do/doc')
    if (!docRes.ok) throw new Error(`doc unavailable: ${docRes.status}`)
    const { version } = (await docRes.json()) as { version: number }

    const res = await stub.fetch('https://do/ops', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: crypto.randomUUID(),
        baseVersion: version,
        actor: { type: 'system' },
        ops,
      }),
    })
    if (res.ok) return
    lastError = await res.text()
    if (res.status !== 409) break
  }
  throw new Error(`ops rejected: ${lastError}`)
}

// ---------- render ----------

app.post('/api/projects/:id/render', async (c) => {
  const projectId = c.req.param('id')
  const docRes = await forwardToDO(c, projectId, '/doc')
  if (!docRes.ok) return docRes
  const { doc } = (await docRes.json()) as { doc: EuclidDoc }

  const seconds = Math.ceil(docDuration(doc))
  if (seconds === 0) return c.json({ error: 'empty_project' }, 400)
  const perSecond =
    doc.canvas.height > 720 ? CREDIT_COSTS.renderPerSecond1080 : CREDIT_COSTS.renderPerSecond720
  const cost = Math.ceil(seconds * perSecond)

  const userId = c.get('userId')
  const balance = await getBalance(c.env, userId)
  if (balance < cost) {
    return c.json({ error: 'insufficient_credits', required: cost, balance }, 402)
  }

  const jobId = crypto.randomUUID()
  await adjustCredits(c.env, userId, -cost, `render:${jobId}`)
  await c.env.DB.prepare(
    `INSERT INTO render_jobs (id, project_id, user_id, status, cost, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
  )
    .bind(jobId, projectId, userId, cost, Date.now(), Date.now())
    .run()

  // TODO(render): push jobId onto a Cloudflare Queue consumed by the container
  // worker (apps/renderer). Until the queue is wired, run the renderer manually:
  //   pnpm --filter @euclid/renderer render -- --project <id> --job <jobId>
  // The worker then drives this job to done/failed (failure refunds the cost).
  return c.json({ jobId, cost, seconds, status: 'queued' })
})

app.get('/api/projects/:id/renders', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, status, cost, output_key, created_at FROM render_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 20',
  )
    .bind(c.req.param('id'))
    .all<RenderJobRow>()
  const origin = publicOrigin(c)
  return c.json({
    jobs: rows.results.map((j) => ({ ...j, downloadUrl: downloadUrlFor(origin, j) })),
  })
})

// ---------- render jobs (lifecycle driven by the render worker) ----------

interface RenderJobRow {
  id: string
  project_id?: string
  user_id?: string
  status: string
  cost: number
  output_key: string | null
  created_at: number
}

const JOB_TERMINAL = ['done', 'failed']

function downloadUrlFor(origin: string, job: { id: string; status: string; output_key: string | null }) {
  return job.status === 'done' && job.output_key ? `${origin}/api/jobs/${job.id}/download` : null
}

/**
 * Origin to use in client-facing URLs. Service-binding requests (MCP worker)
 * have an internal hostname, so a configured origin always wins.
 */
function publicOrigin(c: { env: Env; req: { url: string } }): string {
  return c.env.PUBLIC_API_ORIGIN ?? new URL(c.req.url).origin
}

/** Service-to-service calls only (render worker), not just any authenticated user. */
function isInternal(c: { req: { header: (k: string) => string | undefined }; env: Env }): boolean {
  const key = c.req.header('x-internal-key')
  return !!key && key === c.env.INTERNAL_API_KEY
}

async function loadJob(env: Env, jobId: string): Promise<RenderJobRow & { user_id: string } | null> {
  return env.DB.prepare('SELECT * FROM render_jobs WHERE id = ?')
    .bind(jobId)
    .first<RenderJobRow & { user_id: string }>()
}

app.get('/api/jobs/:jobId', async (c) => {
  const job = await loadJob(c.env, c.req.param('jobId'))
  if (!job) return c.json({ error: 'job_not_found' }, 404)
  const userId = c.get('userId')
  if (job.user_id !== userId && userId !== 'internal') return c.json({ error: 'forbidden' }, 403)
  return c.json({ job: { ...job, downloadUrl: downloadUrlFor(publicOrigin(c), job) } })
})

/**
 * Status transitions from the render worker. Terminal states are final, so a
 * retry or duplicate callback can't double-refund: the UPDATE only matches
 * non-terminal rows and the refund is gated on it having actually applied.
 */
app.patch('/api/jobs/:jobId', async (c) => {
  if (!isInternal(c)) return c.json({ error: 'forbidden' }, 403)
  const { status, error } = (await c.req.json()) as { status: string; error?: string }
  if (!['rendering', 'done', 'failed'].includes(status)) {
    return c.json({ error: 'invalid_status' }, 400)
  }
  const jobId = c.req.param('jobId')
  const job = await loadJob(c.env, jobId)
  if (!job) return c.json({ error: 'job_not_found' }, 404)

  const res = await c.env.DB.prepare(
    `UPDATE render_jobs SET status = ?, updated_at = ?
     WHERE id = ? AND status NOT IN (${JOB_TERMINAL.map(() => '?').join(',')})`,
  )
    .bind(status, Date.now(), jobId, ...JOB_TERMINAL)
    .run()

  const applied = (res.meta?.changes ?? 0) > 0
  if (applied && status === 'failed') {
    await adjustCredits(c.env, job.user_id, job.cost, `refund:${jobId}${error ? ` (${error})` : ''}`)
  }
  return c.json({ status: applied ? status : job.status, applied, refunded: applied && status === 'failed' })
})

/** Render worker uploads the finished MP4 here; body is the raw file. */
app.put('/api/jobs/:jobId/output', async (c) => {
  if (!isInternal(c)) return c.json({ error: 'forbidden' }, 403)
  const jobId = c.req.param('jobId')
  const job = await loadJob(c.env, jobId)
  if (!job) return c.json({ error: 'job_not_found' }, 404)
  if (!c.req.raw.body) return c.json({ error: 'empty_body' }, 400)

  const key = `renders/${job.project_id}/${jobId}.mp4`
  await c.env.ASSETS.put(key, c.req.raw.body, {
    httpMetadata: { contentType: 'video/mp4' },
  })
  await c.env.DB.prepare('UPDATE render_jobs SET output_key = ?, updated_at = ? WHERE id = ?')
    .bind(key, Date.now(), jobId)
    .run()
  return c.json({ key })
})

app.get('/api/jobs/:jobId/download', async (c) => {
  const job = await loadJob(c.env, c.req.param('jobId'))
  if (!job) return c.json({ error: 'job_not_found' }, 404)
  const userId = c.get('userId')
  if (job.user_id !== userId && userId !== 'internal') return c.json({ error: 'forbidden' }, 403)
  if (!job.output_key) return c.json({ error: 'not_ready', status: job.status }, 409)

  const object = await c.env.ASSETS.get(job.output_key)
  if (!object) return c.json({ error: 'output_missing' }, 410)
  return new Response(object.body, {
    headers: {
      'content-type': 'video/mp4',
      'content-length': String(object.size),
      'content-disposition': `attachment; filename="euclid-${job.id}.mp4"`,
    },
  })
})

// ---------- assets ----------

interface AssetRow {
  id: string
  project_id: string
  kind: string
  r2_key: string
  mime: string
  bytes: number
  duration_sec: number | null
  created_at: number
}

const ASSET_KINDS = ['audio', 'video', 'image']

/**
 * Assets are created by server-side producers (TTS today, ingest later), never
 * uploaded by the browser, so this is internal-key only. The server mints the
 * id — hence POST rather than the render output's PUT, where the job id
 * already determines the key.
 *
 * Body is the raw file, streamed straight to R2 so a large clip never has to
 * fit in the worker's memory; `mime` comes from content-type, the rest from
 * the query string.
 */
app.post('/api/projects/:id/assets', async (c) => {
  if (!isInternal(c)) return c.json({ error: 'forbidden' }, 403)
  const projectId = c.req.param('id')
  const project = await c.env.DB.prepare('SELECT user_id FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ user_id: string }>()
  if (!project) return c.json({ error: 'project_not_found' }, 404)

  const kind = c.req.query('kind') ?? 'audio'
  if (!ASSET_KINDS.includes(kind)) return c.json({ error: 'invalid_kind', allowed: ASSET_KINDS }, 400)

  const durationRaw = c.req.query('durationSec')
  const durationSec = durationRaw === undefined ? null : Number(durationRaw)
  if (durationSec !== null && (!Number.isFinite(durationSec) || durationSec <= 0)) {
    return c.json({ error: 'invalid_duration' }, 400)
  }

  const mime = c.req.header('content-type') ?? 'application/octet-stream'
  if (!c.req.raw.body) return c.json({ error: 'empty_body' }, 400)

  try {
    const { assetId, bytes } = await storeAsset(c.env, projectId, {
      kind,
      mime,
      durationSec,
      body: c.req.raw.body,
    })
    return c.json({ assetId, kind, mime, bytes, durationSec })
  } catch {
    return c.json({ error: 'empty_body' }, 400)
  }
})

/**
 * Shared by the upload route and the in-worker producers (TTS today). The row
 * is written only once the bytes are really in R2, and a zero-byte put is
 * removed before any row exists — a document must never hold an assetId that
 * resolves to nothing.
 */
async function storeAsset(
  env: Env,
  projectId: string,
  input: {
    kind: string
    mime: string
    durationSec?: number | null
    body: ReadableStream | ArrayBuffer
  },
): Promise<{ assetId: string; bytes: number }> {
  const assetId = crypto.randomUUID()
  const key = `assets/${projectId}/${assetId}`
  const object = await env.ASSETS.put(key, input.body, {
    httpMetadata: { contentType: input.mime },
  })
  if (!object || object.size === 0) {
    await env.ASSETS.delete(key)
    throw new Error('empty_asset_body')
  }
  await env.DB.prepare(
    `INSERT INTO assets (id, project_id, kind, r2_key, mime, bytes, duration_sec, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(assetId, projectId, input.kind, key, input.mime, object.size, input.durationSec ?? null, Date.now())
    .run()
  return { assetId, bytes: object.size }
}

/**
 * Readable by the owning user or by an internal caller — the render worker
 * fetches narration audio through here with the internal key. Assets are
 * immutable, so they cache forever.
 */
app.get('/api/assets/:assetId', async (c) => {
  const asset = await c.env.DB.prepare(
    `SELECT a.*, p.user_id AS owner FROM assets a
     JOIN projects p ON p.id = a.project_id
     WHERE a.id = ?`,
  )
    .bind(c.req.param('assetId'))
    .first<AssetRow & { owner: string }>()
  if (!asset) return c.json({ error: 'asset_not_found' }, 404)

  const userId = c.get('userId')
  if (asset.owner !== userId && userId !== 'internal') return c.json({ error: 'forbidden' }, 403)

  const object = await c.env.ASSETS.get(asset.r2_key)
  if (!object) return c.json({ error: 'asset_missing' }, 410)
  return new Response(object.body, {
    headers: {
      'content-type': asset.mime,
      'content-length': String(object.size),
      'cache-control': 'private, max-age=31536000, immutable',
    },
  })
})

function projectStub(env: Env, projectId: string): DurableObjectStub {
  return env.PROJECT.get(env.PROJECT.idFromName(projectId))
}

export default app
