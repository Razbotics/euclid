/**
 * The render backend: it drains the render queue **and** serves preview frames.
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
 * **Capture lives here rather than beside it.** plans/007 asked for preview
 * frames to be bound to whichever backend the render path landed on, and not
 * to a second renderer — because a preview frame is only worth trusting if it
 * *is* an export frame. Both halves already drove the same
 * `window.__euclid.renderFrame`; keeping them in separate processes meant two
 * browsers, two things to start, and two places for that to drift. One process
 * holds a warm page for previews (fast, called constantly) and spawns a child
 * per render job (isolated, called rarely).
 *
 * The HTTP listener is best-effort: a second worker on the same machine finds
 * the port taken, says so, and carries on draining the queue. Serving preview
 * is a role one worker takes, not a precondition for rendering.
 *
 * Env: API_URL, INTERNAL_API_KEY, RENDER_PAGE_URL (passed through to the child),
 *      POLL_MS (default 3000), MAX_JOBS (exit after N jobs; for tests),
 *      PREVIEW_PORT (default 8790), PREVIEW_DISABLE=1 to not serve at all.
 */
import './load-env'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { EuclidDoc } from '@euclid/dsl'
import { PreviewCapturer } from './sheet'

const API_URL = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const POLL_MS = Number(process.env.POLL_MS ?? 3000)
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT ?? 8790)
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


// ---------- preview capture ----------
// A warm page, because an agent previews the same project repeatedly while
// editing it and a preview that pays for a browser launch per call is one
// nobody calls twice. Render jobs do not touch this page: they get their own
// process.
const capturer = new PreviewCapturer()

/** One page, so overlapping captures would interleave frames. */
let queue: Promise<unknown> = Promise.resolve()
function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.catch(() => {})
  return next
}

function servePreview(): void {
  const server = createServer((req, res) => {
    const send = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'text/plain' })
      res.end(body)
    }
    if (req.method === 'GET' && req.url === '/health') return send(200, 'ok')
    if (req.headers['x-internal-key'] !== KEY) return send(403, 'forbidden')
    if (req.method !== 'POST' || !['/preview', '/frame'].includes(req.url ?? '')) {
      return send(404, 'not found')
    }

    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      let body: {
        doc: EuclidDoc
        tiles?: { t: number; label: string }[]
        t?: number
        columns?: number
        tileWidth?: number
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString())
      } catch {
        return send(400, 'invalid json')
      }
      if (!body?.doc?.scenes) return send(400, 'missing doc')

      const started = Date.now()
      serialise(async (): Promise<{ png: Buffer; ink: number[] }> =>
        req.url === '/frame'
          ? { png: await capturer.frame(body.doc, body.t ?? 0), ink: [] }
          : capturer.sheet(body.doc, body.tiles ?? [], {
              columns: body.columns,
              tileWidth: body.tileWidth,
            }),
      )
        .then(({ png, ink }) => {
          res.writeHead(200, {
            'content-type': 'image/png',
            'content-length': png.byteLength,
            // Per-tile lit fraction, so the caller can tell "rendered a dark
            // frame" from "captured nothing" without decoding the image.
            'x-preview-ink': JSON.stringify(ink.map((v) => Number(v.toFixed(5)))),
          })
          res.end(png)
          console.log(
            `preview ${req.url} ${body.tiles?.length ?? 1} frame(s) → ` +
              `${(png.byteLength / 1024).toFixed(0)}KB in ${((Date.now() - started) / 1000).toFixed(1)}s`,
          )
        })
        .catch((e: Error) => {
          console.error(`preview ${req.url} failed:`, e.message)
          send(500, e.message)
        })
    })
  })

  // Best-effort. A second worker on this machine cannot have the port, and
  // that must not stop it draining the queue — serving preview is a role, not
  // a precondition.
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`preview port ${PREVIEW_PORT} already served by another worker — rendering only`)
    } else {
      console.error(`preview server error: ${e.message}`)
    }
  })
  server.listen(PREVIEW_PORT, () => console.log(`serving preview on :${PREVIEW_PORT}`))
}

if (process.env.PREVIEW_DISABLE !== '1') servePreview()

let running = true
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log('\nstopping after the current job…')
    running = false
    void capturer.close()
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
await capturer.close()
console.log('render worker stopped')
