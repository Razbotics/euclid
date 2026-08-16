/**
 * The thing that drains the render queue.
 *   pnpm --filter @euclid/renderer exec tsx src/render-worker.ts
 *
 * Without this, `render_video` accepts a job, prices it, debits the credits —
 * and nothing ever starts it. Milestone run 5 waited ten minutes on a job that
 * was never going to run, which is the worst possible failure: the user has
 * paid and the system looks busy.
 *
 * **A pull, not a push.** A Cloudflare Worker cannot run Chromium, so the
 * renderer lives outside and comes to ask for work. When this moves to Queues +
 * Containers the producer changes and `POST /api/jobs/claim` goes away, but
 * nothing either side of it does: the job lifecycle (rendering → done/failed,
 * with the refund on failure) already lives in the API, deliberately, so
 * whatever renders stays swappable.
 *
 * **One child process per job.** `render.ts` is spawned rather than imported,
 * for the same reason production would use a container per job: a render that
 * wedges Chromium, exhausts memory or throws on a malformed document takes its
 * own process down and not the worker. The child already drives the job's
 * status transitions, so a crash still lands the job in `failed` — and a failed
 * job refunds the credits automatically.
 *
 * Env: API_URL, INTERNAL_API_KEY, RENDER_PAGE_URL (passed through to the child),
 *      POLL_MS (default 3000), MAX_JOBS (exit after N jobs; for tests).
 */
import './load-env'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const API_URL = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const POLL_MS = Number(process.env.POLL_MS ?? 3000)
const MAX_JOBS = Number(process.env.MAX_JOBS ?? 0) // 0 = run forever
const HERE = dirname(fileURLToPath(import.meta.url))

const headers = {
  'content-type': 'application/json',
  'x-internal-key': KEY,
  'x-user-id': 'internal',
}

interface Claim {
  jobId: string | null
  projectId?: string
}

async function claim(): Promise<Claim> {
  const res = await fetch(`${API_URL}/api/jobs/claim`, { method: 'POST', headers })
  if (!res.ok) throw new Error(`claim failed (${res.status}): ${await res.text()}`)
  return (await res.json()) as Claim
}

/**
 * Run one job to completion. Resolves whatever the outcome — a failed render is
 * a normal event here, not an error the worker should die of.
 */
function render(projectId: string, jobId: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      ['tsx', join(HERE, 'render.ts'), '--project', projectId, '--job', jobId],
      { cwd: join(HERE, '..'), stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
    )
    // ffmpeg is extremely chatty on stderr and most of it is progress, so only
    // the child's own lines are echoed; its failures reach the job status
    // regardless, which is the thing that actually matters.
    child.stdout.on('data', (b: Buffer) => {
      const line = b.toString().trim()
      if (line) console.log(`  [${jobId.slice(0, 8)}] ${line.split('\n').at(-1)}`)
    })
    let stderrTail = ''
    child.stderr.on('data', (b: Buffer) => {
      stderrTail = (stderrTail + b.toString()).slice(-2000)
    })
    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`  [${jobId.slice(0, 8)}] exited ${code}\n${stderrTail.trim().slice(-600)}`)
      }
      resolve(code ?? 1)
    })
    child.on('error', (e) => {
      console.error(`  [${jobId.slice(0, 8)}] could not start: ${e.message}`)
      resolve(1)
    })
  })
}

/**
 * A job the child failed to finish must not be left claimed.
 *
 * The child marks its own failures, but it cannot mark one it never reached —
 * a spawn failure, or a kill. `rendering` is not terminal, so without this the
 * job would sit exactly as `queued` used to, having already been paid for.
 */
async function failJob(jobId: string, reason: string): Promise<void> {
  await fetch(`${API_URL}/api/jobs/${jobId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'failed', error: reason }),
  }).catch(() => {})
}

async function jobStatus(jobId: string): Promise<string | null> {
  const res = await fetch(`${API_URL}/api/jobs/${jobId}`, { headers })
  if (!res.ok) return null
  return ((await res.json()) as { job: { status: string } }).job.status
}

let running = true
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log('\nstopping after the current job…')
    running = false
  })
}

console.log(`render worker polling ${API_URL} every ${POLL_MS}ms`)
let done = 0
while (running) {
  let next: Claim
  try {
    next = await claim()
  } catch (e) {
    // The API being down is a reason to wait, not to exit: this is a daemon.
    console.error(`claim error: ${(e as Error).message}`)
    await new Promise((r) => setTimeout(r, POLL_MS))
    continue
  }

  if (!next.jobId || !next.projectId) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    continue
  }

  const started = Date.now()
  console.log(`claimed ${next.jobId} (project ${next.projectId.slice(0, 8)})`)
  const code = await render(next.projectId, next.jobId)
  const status = await jobStatus(next.jobId)
  if (status !== 'done' && status !== 'failed') {
    // Exited without reaching a terminal state — the case the child could not
    // report on itself.
    await failJob(next.jobId, `render worker: child exited ${code} without finishing`)
    console.error(`  [${next.jobId.slice(0, 8)}] marked failed; credits refunded`)
  } else {
    console.log(`  [${next.jobId.slice(0, 8)}] ${status} in ${((Date.now() - started) / 1000).toFixed(0)}s`)
  }

  if (MAX_JOBS && ++done >= MAX_JOBS) break
}
console.log('render worker stopped')
