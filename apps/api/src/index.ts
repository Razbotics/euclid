import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { docDuration, documentCues, toSRT, toVTT, type EuclidDoc } from '@euclid/dsl'
import { makeAuth } from './auth'
import { adjustCredits, billing, handleStripeWebhook } from './billing'
import { AccessError, docOf, projectStub, requireProjectAccess, slugify } from './shared'
import { createProject, deleteProject, listProjects, projectContents } from './services/projects'
import {
  ASSET_KINDS,
  AssetInUse,
  AssetPathTaken,
  deleteAsset,
  listProjectAssets,
  loadAsset,
  moveAsset,
  storeAsset,
} from './services/assets'
import { NarrationError, generateSceneNarration } from './services/narration'
import {
  JOB_TERMINAL,
  type RenderJobRow,
  RenderError,
  downloadUrlFor,
  listRenderJobs,
  startRender,
} from './services/render'
import { agent } from './agent/routes'
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
// The agent gateway: three endpoints over the capability catalog. Same auth as
// everything else, so the MCP worker reaches it with the internal key.
app.route('/api/agent', agent)

// ---------- projects ----------

app.get('/api/projects', async (c) => {
  return c.json({ projects: await listProjects(c.env, c.get('userId')) })
})

app.post('/api/projects', async (c) => {
  const { name } = (await c.req.json()) as { name: string }
  if (!name?.trim()) return c.json({ error: 'name_required' }, 400)
  return c.json(await createProject(c.env, name, c.get('userId')))
})

/**
 * Delete a project and everything it owns — R2 bytes, asset and job rows, and
 * the Durable Object's document and decisions.
 *
 * Irreversible and not undoable through the event log, which lives in the
 * storage this destroys. `?dryRun=1` reports what would go without touching
 * anything, which is what makes a bulk cleanup checkable before it runs.
 */
app.delete('/api/projects/:id', async (c) => {
  const projectId = c.req.param('id')
  try {
    if (c.req.query('dryRun')) {
      await requireProjectAccess(c.env, projectId, c.get('userId'))
      return c.json({ dryRun: true, ...(await projectContents(c.env, projectId)) })
    }
    return c.json(await deleteProject(c.env, projectId, c.get('userId')))
  } catch (e) {
    if (e instanceof AccessError) return c.json({ error: e.message }, e.status as 403)
    throw e
  }
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
  try {
    const result = await generateSceneNarration(
      c.env,
      c.req.param('id'),
      c.req.param('sceneId'),
      c.get('userId'),
      (await c.req.json().catch(() => ({}))) as { text?: string; voiceId?: string },
    )
    return c.json(result)
  } catch (e) {
    if (e instanceof NarrationError) {
      return c.json({ error: e.code, detail: e.message, ...e.extra }, e.status as 400)
    }
    if (e instanceof AccessError) return c.json({ error: e.message }, e.status as 403)
    throw e
  }
})

// ---------- render ----------

app.post('/api/projects/:id/render', async (c) => {
  try {
    return c.json(await startRender(c.env, c.req.param('id'), c.get('userId')))
  } catch (e) {
    if (e instanceof RenderError) {
      return c.json({ error: e.code, detail: e.message, ...e.extra }, e.status as 400)
    }
    if (e instanceof AccessError) return c.json({ error: e.message }, e.status as 403)
    throw e
  }
})

app.get('/api/projects/:id/renders', async (c) => {
  return c.json({ jobs: await listRenderJobs(c.env, c.req.param('id'), publicOrigin(c)) })
})

// ---------- render jobs (lifecycle driven by the render worker) ----------

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

app.get('/api/projects/:id/assets', async (c) => {
  try {
    return c.json({ assets: await listProjectAssets(c.env, c.req.param('id'), c.get('userId')) })
  } catch (e) {
    if (e instanceof AccessError) return c.json({ error: e.message }, e.status as 403)
    throw e
  }
})

/** Rename or move — both are just a new virtual path. */
app.patch('/api/assets/:assetId', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { path?: unknown } | null
  if (!body || typeof body.path !== 'string') return c.json({ error: 'path_required' }, 400)
  try {
    return c.json(await moveAsset(c.env, c.req.param('assetId'), body.path, c.get('userId')))
  } catch (e) {
    if (e instanceof AccessError) return c.json({ error: e.message }, e.status as 403)
    if (e instanceof AssetPathTaken) {
      return c.json({ error: 'path_taken', detail: e.path, assetId: e.assetId }, 409)
    }
    return c.json({ error: 'invalid_path', detail: (e as Error).message }, 400)
  }
})

app.delete('/api/assets/:assetId', async (c) => {
  try {
    return c.json(
      await deleteAsset(c.env, c.req.param('assetId'), !!c.req.query('force'), c.get('userId')),
    )
  } catch (e) {
    if (e instanceof AccessError) return c.json({ error: e.message }, e.status as 403)
    if (e instanceof AssetInUse) {
      return c.json(
        {
          error: 'asset_in_use',
          scenes: e.scenes,
          ...(e.isRenderOutput ? { reason: 'a finished render job still serves this file' } : {}),
          hint: 'pass ?force=1 to delete anyway',
        },
        409,
      )
    }
    throw e
  }
})

/**
 * Readable by the owning user or by an internal caller — the render worker
 * fetches narration audio through here with the internal key. Assets are
 * immutable, so they cache forever.
 */
app.get('/api/assets/:assetId', async (c) => {
  const asset = await loadAsset(c.env, c.req.param('assetId'))
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

export default app
