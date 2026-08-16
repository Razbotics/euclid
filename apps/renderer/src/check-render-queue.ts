/**
 * The render queue actually drains.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-render-queue.ts
 *
 * **Spends ~4 credits** (two 2-second videos). Needs `dev:api` + `dev:web`.
 * Starts and stops its own render worker, so do not run one alongside it.
 *
 * Before the worker existed, `render_video` debited credits and created a job
 * that nothing would ever start — the worst shape of failure, because the user
 * has paid and the system looks busy. Milestone run 5 waited ten minutes on
 * one. So the thing worth proving is not that a render works (check-mux does
 * that) but that a *submitted* job reaches `done` with nobody driving it, and
 * that a job which fails still reaches `failed` and gives the credits back.
 */
import './load-env'
import assert from 'node:assert'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const API = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const HERE = dirname(fileURLToPath(import.meta.url))
const user = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-user-id': 'dev-user' }
const internal = { ...user, 'x-user-id': 'internal' }

const exec = async (name: string, args: unknown, q = '') => {
  const res = await fetch(`${API}/api/agent/tools/${name}/execute?format=json${q}`, {
    method: 'POST',
    headers: user,
    body: JSON.stringify(args),
  })
  const body = await res.text()
  assert.equal(res.status, 200, `${name}: ${body}`)
  return JSON.parse(body) as { text: string; data: any }
}
const balance = async () =>
  ((await (await fetch(`${API}/api/billing/balance`, { headers: user })).json()) as {
    balance: number
  }).balance
const jobOf = async (id: string) =>
  ((await (await fetch(`${API}/api/jobs/${id}`, { headers: internal })).json()) as {
    job: { status: string; output_key: string | null }
  }).job

/** Run a worker until it has taken `jobs` jobs, then stop it. */
function worker(jobs: number, env: Record<string, string> = {}): ChildProcess {
  return spawn('npx', ['tsx', join(HERE, 'render-worker.ts')], {
    cwd: join(HERE, '..'),
    stdio: 'ignore',
    env: { ...process.env, MAX_JOBS: String(jobs), POLL_MS: '1000', ...env },
  })
}
const waitFor = async (id: string, want: string[], seconds: number) => {
  for (let i = 0; i < seconds; i++) {
    const s = (await jobOf(id)).status
    if (want.includes(s)) return s
    await new Promise((r) => setTimeout(r, 1000))
  }
  return (await jobOf(id)).status
}

// ---------- claiming ----------
const anon = await fetch(`${API}/api/jobs/claim`, { method: 'POST' })
assert.equal(anon.status, 403, 'claiming is internal-only — it hands out paid work')

const empty = await (await fetch(`${API}/api/jobs/claim`, { method: 'POST', headers: internal })).json()
assert.equal((empty as { jobId: string | null }).jobId, null, 'an empty queue claims nothing')

// ---------- a submitted job finishes with nobody driving it ----------
const projectId = (await exec('create_project', { name: 'Queue Check' })).data.id
const sceneId = (await exec('add_scene', { projectId, name: 'S', duration: 2 })).data.sceneId
await exec('add_latex', { projectId, sceneId, tex: 'e^{i\\pi}+1=0', x: 960, y: 540 })

const before = await balance()
const job = (await exec('render_video', { projectId }, '&paid=1')).data
assert.equal((await jobOf(job.jobId)).status, 'queued', 'a fresh job is queued, not started')

// Two workers race for one job: exactly one may get it, or the same render
// runs twice and the output is uploaded twice.
const racers = [worker(1), worker(1)]
const finished = await waitFor(job.jobId, ['done', 'failed'], 180)
racers.forEach((w) => w.kill())
assert.equal(finished, 'done', `the queue must drain unattended, got ${finished}`)

const doneJob = await jobOf(job.jobId)
assert.ok(doneJob.output_key, 'a done job must have an uploaded output')
const dl = await fetch(`${API}/api/jobs/${job.jobId}/download`, {
  headers: { ...internal, Range: 'bytes=0-11' },
})
assert.equal(dl.status, 206, 'the MP4 must be downloadable')
assert.ok(Buffer.from(await dl.arrayBuffer()).includes('ftyp'), 'and be a real MP4')
assert.equal(await balance(), before - job.cost, 'a successful render keeps the credits')

// ---------- a job that cannot render still resolves, and refunds ----------
// Pointing the child at a page that does not exist is the closest cheap stand-in
// for the real failures (a wedged browser, a bad document): the worker must not
// leave the job stuck in `rendering`, which is the same trap `queued` was.
const failing = (await exec('render_video', { projectId }, '&paid=1')).data
const afterDebit = await balance()
const doomed = worker(1, { RENDER_PAGE_URL: 'http://localhost:9/nope.html' })
const outcome = await waitFor(failing.jobId, ['done', 'failed'], 120)
doomed.kill()
assert.equal(outcome, 'failed', `a broken render must reach failed, got ${outcome}`)
assert.equal(
  await balance(),
  afterDebit + failing.cost,
  'a failed render must refund — otherwise a broken worker silently charges',
)

await exec('delete_project', { projectId, confirm: true })
console.log(
  'render queue OK — claim is internal-only and single-winner; a submitted job ' +
    'reaches done unattended with a downloadable MP4; a failing job reaches failed ' +
    'and refunds',
)
