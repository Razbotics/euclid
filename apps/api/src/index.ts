import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  CREDIT_COSTS,
  assetIdsInDoc,
  defaultAssetPath,
  docDuration,
  documentCues,
  normalizeAssetPath,
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

// Questions the agent puts to the human. Not document state — see
// packages/dsl/src/decisions.ts — but they ride the project's DO so the
// editor gets them live over the existing WebSocket.
app.get('/api/projects/:id/decisions', (c) => forwardToDO(c, c.req.param('id'), '/decisions'))
app.post('/api/projects/:id/decisions', (c) => forwardToDO(c, c.req.param('id'), '/decisions'))
app.post('/api/projects/:id/decisions/:decisionId/answer', (c) =>
  forwardToDO(c, c.req.param('id'), `/decisions/${c.req.param('decisionId')}`),
)

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
        // Named after the scene, so the explorer reads as a project's files
        // rather than a pile of uuids.
        path: `/narration/${slugify(scene.name)}.mp3`,
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

/**
 * Serve an R2 object with HTTP range support.
 *
 * Not an optimisation — it is what makes media *seekable*. Without
 * `Accept-Ranges` + `206`, Chrome reports `audio.seekable.end(0) === 0` even
 * for a fully buffered file, and every assignment to `currentTime` is silently
 * ignored. That looked like "the editor has no sound": scrubbing could not move
 * the narration, so it played from the wrong place or not at all.
 */
async function serveR2Range(
  bucket: R2Bucket,
  key: string,
  rangeHeader: string | undefined,
  headers: Record<string, string>,
): Promise<Response | null> {
  const head = await bucket.head(key)
  if (!head) return null
  const total = head.size
  const base = { ...headers, 'accept-ranges': 'bytes' }

  const match = /^bytes=(\d*)-(\d*)$/.exec((rangeHeader ?? '').trim())
  if (match) {
    const [, rawStart, rawEnd] = match
    let start: number
    let end: number
    if (rawStart === '') {
      const suffix = Number(rawEnd)
      if (!suffix) return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${total}` } })
      start = Math.max(0, total - suffix)
      end = total - 1
    } else {
      start = Number(rawStart)
      end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1)
    }
    if (!Number.isFinite(start) || start > end || start >= total) {
      return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${total}` } })
    }
    const part = await bucket.get(key, { range: { offset: start, length: end - start + 1 } })
    if (!part) return null
    return new Response(part.body, {
      status: 206,
      headers: {
        ...base,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${total}`,
      },
    })
  }

  const object = await bucket.get(key)
  if (!object) return null
  return new Response(object.body, { headers: { ...base, 'content-length': String(total) } })
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
  if (!job.project_id) return c.json({ error: 'job_missing_project' }, 500)
  if (!c.req.raw.body) return c.json({ error: 'empty_body' }, 400)

  const projectId = job.project_id
  const key = `renders/${projectId}/${jobId}.mp4`
  const object = await c.env.ASSETS.put(key, c.req.raw.body, {
    httpMetadata: { contentType: 'video/mp4' },
  })
  await c.env.DB.prepare('UPDATE render_jobs SET output_key = ?, updated_at = ? WHERE id = ?')
    .bind(key, Date.now(), jobId)
    .run()

  // A finished render is a file the project holds, so it joins the asset tree
  // rather than being reachable only through a job id. The row *points at the
  // render's existing R2 key* — the bytes are not copied, so the download
  // route and the explorer serve the same object.
  const doc = await docOf(c.env, projectId)
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO assets
       (id, project_id, kind, r2_key, mime, bytes, duration_sec, path, created_at)
     VALUES (?, ?, 'video', ?, 'video/mp4', ?, ?, ?, ?)`,
  )
    .bind(
      `render-${jobId}`,
      projectId,
      key,
      object?.size ?? 0,
      doc ? docDuration(doc) : null,
      `/renders/${doc ? slugify(doc.name) : 'render'}-${jobId.slice(0, 8)}.mp4`,
      Date.now(),
    )
    .run()
  return c.json({ key })
})

app.get('/api/jobs/:jobId/download', async (c) => {
  const job = await loadJob(c.env, c.req.param('jobId'))
  if (!job) return c.json({ error: 'job_not_found' }, 404)
  const userId = c.get('userId')
  if (job.user_id !== userId && userId !== 'internal') return c.json({ error: 'forbidden' }, 403)
  if (!job.output_key) return c.json({ error: 'not_ready', status: job.status }, 409)

  // `inline` so pasting the URL in a browser *plays* it; ?download=1 still
  // forces the save dialog. As an attachment it could only ever be downloaded.
  const disposition = `${c.req.query('download') ? 'attachment' : 'inline'}; filename="euclid-${job.id}.mp4"`
  const ranged = await serveR2Range(c.env.ASSETS, job.output_key, c.req.header('range'), {
    'content-type': 'video/mp4',
    'content-disposition': disposition,
  })
  if (!ranged) return c.json({ error: 'output_missing' }, 410)
  return ranged
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
 * Suffix a path until it is free, so a regenerated narration clip sits beside
 * the old one instead of colliding with it (the explorer is what finally makes
 * those leftovers visible).
 */
async function uniqueAssetPath(env: Env, projectId: string, wanted: string): Promise<string> {
  const dot = wanted.lastIndexOf('.')
  const stem = dot > wanted.lastIndexOf('/') ? wanted.slice(0, dot) : wanted
  const ext = dot > wanted.lastIndexOf('/') ? wanted.slice(dot) : ''
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? wanted : `${stem}-${n + 1}${ext}`
    const clash = await env.DB.prepare('SELECT id FROM assets WHERE project_id = ? AND path = ?')
      .bind(projectId, candidate)
      .first<{ id: string }>()
    if (!clash) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

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
    /** Virtual path; defaults to /<kind>/<id>.<ext> when the caller has no better name. */
    path?: string | null
    body: ReadableStream | ArrayBuffer
  },
): Promise<{ assetId: string; bytes: number; path: string }> {
  const assetId = crypto.randomUUID()
  const key = `assets/${projectId}/${assetId}`
  const object = await env.ASSETS.put(key, input.body, {
    httpMetadata: { contentType: input.mime },
  })
  if (!object || object.size === 0) {
    await env.ASSETS.delete(key)
    throw new Error('empty_asset_body')
  }
  let path = defaultAssetPath(input.kind, input.mime, assetId)
  if (input.path) {
    try {
      path = await uniqueAssetPath(env, projectId, normalizeAssetPath(input.path))
    } catch {
      // A bad suggested name must not lose the bytes we already stored.
    }
  }
  await env.DB.prepare(
    `INSERT INTO assets (id, project_id, kind, r2_key, mime, bytes, duration_sec, path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(assetId, projectId, input.kind, key, input.mime, object.size, input.durationSec ?? null, path, Date.now())
    .run()
  return { assetId, bytes: object.size, path }
}

/**
 * The project's document, straight from the DO. Callers here have already
 * checked ownership, so this deliberately skips the auth forwarding.
 */
async function docOf(env: Env, projectId: string): Promise<EuclidDoc | null> {
  const res = await projectStub(env, projectId).fetch('https://do/doc')
  if (!res.ok) return null
  return ((await res.json()) as { doc: EuclidDoc }).doc
}

/** R2 keys that finished render jobs still hand out download URLs for. */
async function renderOutputKeys(env: Env, projectId: string): Promise<Set<string>> {
  const rows = await env.DB.prepare(
    'SELECT output_key FROM render_jobs WHERE project_id = ? AND output_key IS NOT NULL',
  )
    .bind(projectId)
    .all<{ output_key: string }>()
  return new Set(rows.results.map((r) => r.output_key))
}

/** Owner-or-internal lookup shared by the asset routes. */
async function loadAsset(env: Env, assetId: string) {
  return env.DB.prepare(
    `SELECT a.*, p.user_id AS owner FROM assets a
     JOIN projects p ON p.id = a.project_id
     WHERE a.id = ?`,
  )
    .bind(assetId)
    .first<AssetRow & { owner: string; path: string | null }>()
}

/**
 * A project's files. `path` is a virtual path — folders are derived from it,
 * never stored — so the editor and the MCP tools build the same tree from
 * these rows with `buildAssetTree`.
 *
 * `usedBy` marks assets the document depends on, which is what makes deletion
 * refusable rather than silently breaking a scene.
 */
app.get('/api/projects/:id/assets', async (c) => {
  const projectId = c.req.param('id')
  const project = await c.env.DB.prepare('SELECT user_id FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ user_id: string }>()
  if (!project) return c.json({ error: 'project_not_found' }, 404)
  const userId = c.get('userId')
  if (project.user_id !== userId && userId !== 'internal') return c.json({ error: 'forbidden' }, 403)

  const rows = await c.env.DB.prepare(
    'SELECT id, kind, mime, bytes, duration_sec, path, r2_key, created_at FROM assets WHERE project_id = ? ORDER BY created_at',
  )
    .bind(projectId)
    .all<{
      id: string
      kind: string
      mime: string
      bytes: number
      duration_sec: number | null
      path: string | null
      r2_key: string
      created_at: number
    }>()

  const doc = await docOf(c.env, projectId)
  const used = doc ? assetIdsInDoc(doc) : new Set<string>()
  // A render output is not referenced by the *document* but is very much in
  // use — its job hands out a download URL for it. Without this every render
  // would read as "unused", which is exactly the wrong nudge.
  const renderKeys = await renderOutputKeys(c.env, projectId)

  return c.json({
    assets: rows.results.map((r) => ({
      id: r.id,
      kind: r.kind,
      mime: r.mime,
      bytes: r.bytes,
      durationSec: r.duration_sec,
      // Rows predating the path column still resolve to a sensible place.
      path: r.path || defaultAssetPath(r.kind, r.mime, r.id),
      createdAt: r.created_at,
      usedBy: used.has(r.id) || renderKeys.has(r.r2_key),
    })),
  })
})

/** Rename or move — both are just a new virtual path. */
app.patch('/api/assets/:assetId', async (c) => {
  const asset = await loadAsset(c.env, c.req.param('assetId'))
  if (!asset) return c.json({ error: 'asset_not_found' }, 404)
  const userId = c.get('userId')
  if (asset.owner !== userId && userId !== 'internal') return c.json({ error: 'forbidden' }, 403)

  const body = (await c.req.json().catch(() => null)) as { path?: unknown } | null
  if (!body || typeof body.path !== 'string') return c.json({ error: 'path_required' }, 400)

  let path: string
  try {
    path = normalizeAssetPath(body.path)
  } catch (e) {
    return c.json({ error: 'invalid_path', detail: (e as Error).message }, 400)
  }

  // Two files sharing a path would render an ambiguous tree.
  const clash = await c.env.DB.prepare(
    'SELECT id FROM assets WHERE project_id = ? AND path = ? AND id != ?',
  )
    .bind(asset.project_id, path, asset.id)
    .first<{ id: string }>()
  if (clash) return c.json({ error: 'path_taken', detail: path, assetId: clash.id }, 409)

  await c.env.DB.prepare('UPDATE assets SET path = ? WHERE id = ?').bind(path, asset.id).run()
  return c.json({ assetId: asset.id, path })
})

/**
 * Delete, unless the document still points at it.
 *
 * Phase 2 established that a document must never hold an assetId resolving to
 * nothing; that invariant is worth as much on the way out as on the way in.
 * `?force=1` is the deliberate override, and it reports what it broke.
 */
app.delete('/api/assets/:assetId', async (c) => {
  const asset = await loadAsset(c.env, c.req.param('assetId'))
  if (!asset) return c.json({ error: 'asset_not_found' }, 404)
  const userId = c.get('userId')
  if (asset.owner !== userId && userId !== 'internal') return c.json({ error: 'forbidden' }, 403)

  const doc = await docOf(c.env, asset.project_id)
  const used = doc ? assetIdsInDoc(doc) : new Set<string>()
  const force = !!c.req.query('force')
  const renderKeys = await renderOutputKeys(c.env, asset.project_id)
  const isRenderOutput = renderKeys.has(asset.r2_key)
  const inUse = used.has(asset.id) || isRenderOutput

  if (inUse && !force) {
    const scenes = (doc?.scenes ?? [])
      .filter((s) => s.narration?.audio?.assetId === asset.id)
      .map((s) => s.name)
    return c.json(
      {
        error: 'asset_in_use',
        scenes,
        ...(isRenderOutput ? { reason: 'a finished render job still serves this file' } : {}),
        hint: 'pass ?force=1 to delete anyway',
      },
      409,
    )
  }

  await c.env.ASSETS.delete(asset.r2_key)
  await c.env.DB.prepare('DELETE FROM assets WHERE id = ?').bind(asset.id).run()
  // Don't leave a job advertising a download that now 410s.
  if (isRenderOutput) {
    await c.env.DB.prepare('UPDATE render_jobs SET output_key = NULL WHERE output_key = ?')
      .bind(asset.r2_key)
      .run()
  }
  return c.json({ deleted: asset.id, wasInUse: inUse })
})

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

  // Range-aware: narration audio must be seekable or the editor cannot line it
  // up with the playhead (see serveR2Range).
  const ranged = await serveR2Range(c.env.ASSETS, asset.r2_key, c.req.header('range'), {
    'content-type': asset.mime,
    'cache-control': 'private, max-age=31536000, immutable',
  })
  if (!ranged) return c.json({ error: 'asset_missing' }, 410)
  return ranged
})

function projectStub(env: Env, projectId: string): DurableObjectStub {
  return env.PROJECT.get(env.PROJECT.idFromName(projectId))
}

export default app
