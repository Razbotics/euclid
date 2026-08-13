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
  if (!session) return c.json({ error: 'unauthorized' }, 401)
  c.set('userId', session.user.id)
  return next()
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
  return c.json({ jobId, cost, seconds, status: 'queued' })
})

app.get('/api/projects/:id/renders', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, status, cost, output_key, created_at FROM render_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 20',
  )
    .bind(c.req.param('id'))
    .all()
  return c.json({ jobs: rows.results })
})

function projectStub(env: Env, projectId: string): DurableObjectStub {
  return env.PROJECT.get(env.PROJECT.idFromName(projectId))
}

export default app
