import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { CREDIT_COSTS, docDuration, type EuclidDoc } from '@euclid/dsl'
import { makeAuth } from './auth'
import { adjustCredits, billing, getBalance, handleStripeWebhook } from './billing'
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

function projectStub(env: Env, projectId: string): DurableObjectStub {
  return env.PROJECT.get(env.PROJECT.idFromName(projectId))
}

export default app
