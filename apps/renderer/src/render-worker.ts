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
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

/**
 * Measure one uploaded file, if any is waiting.
 *
 * This lives in the render worker because it is the only process with ffprobe:
 * the API is a Cloudflare Worker, which has no subprocesses at all. So an
 * upload lands unmeasured and is measured shortly after, which is why
 * `list_assets` says "not measured yet" rather than showing a blank.
 *
 * Returns whether it did anything, so the loop can keep working through a
 * backlog instead of sleeping between files.
 */
async function probeOne(): Promise<boolean> {
  const res = await fetch(`${API_URL}/api/assets/probe/next`, { headers })
  if (!res.ok) return false
  const { asset } = (await res.json()) as {
    asset: { id: string; mime: string; kind: string } | null
  }
  if (!asset) return false

  const tmp = join(tmpdir(), `euclid-probe-${asset.id}`)
  const measured: { durationSec?: number; width?: number; height?: number; fps?: number } = {}
  try {
    // Downloaded whole rather than streamed: an mp4's moov atom can sit at the
    // end of the file, so a prefix is not enough to measure one that was not
    // written with faststart — which an uploaded file usually was not.
    const bytes = await fetch(`${API_URL}/api/assets/${asset.id}`, { headers })
    if (!bytes.ok) throw new Error(`fetch ${bytes.status}`)
    await writeFile(tmp, Buffer.from(await bytes.arrayBuffer()))

    const out = await new Promise<string>((resolve, reject) => {
      const ff = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration:stream=width,height,avg_frame_rate,codec_type',
        '-of', 'json',
        tmp,
      ])
      let stdout = ''
      ff.stdout.on('data', (d) => (stdout += d))
      ff.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`ffprobe ${code}`))))
      ff.on('error', reject)
    })

    const info = JSON.parse(out) as {
      format?: { duration?: string }
      streams?: { width?: number; height?: number; avg_frame_rate?: string; codec_type?: string }[]
    }
    const duration = Number(info.format?.duration)
    if (Number.isFinite(duration) && duration > 0) measured.durationSec = duration

    const video = info.streams?.find((st) => st.codec_type === 'video')
    if (video?.width && video.height) {
      measured.width = video.width
      measured.height = video.height
      // Only a video has a frame rate. ffprobe models a still as a 25fps video
      // stream and duly reports "25/1", so believing it files every PNG in the
      // project as 25fps — measured data that is simply untrue. The rational
      // also needs guarding: "0/0" must not become NaN.
      if (asset.kind === 'video') {
        const [num, den] = (video.avg_frame_rate ?? '').split('/').map(Number)
        if (num && den) measured.fps = num / den
      }
    }
  } catch (e) {
    // Marked probed anyway, below: a file ffprobe cannot read is a fact about
    // the file, and retrying it on every poll forever helps nobody.
    console.error(`  probe ${asset.id.slice(0, 8)} failed: ${(e as Error).message}`)
  } finally {
    await unlink(tmp).catch(() => {})
  }

  await fetch(`${API_URL}/api/assets/${asset.id}/probe`, {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(measured),
  })
  const said = [
    measured.width && measured.height ? `${measured.width}x${measured.height}` : null,
    measured.durationSec ? `${measured.durationSec.toFixed(2)}s` : null,
    measured.fps ? `${Math.round(measured.fps)}fps` : null,
  ]
    .filter(Boolean)
    .join(' ')
  console.log(`  probed ${asset.id.slice(0, 8)} (${asset.kind}) ${said || 'nothing measurable'}`)
  return true
}

/**
 * Find where the picture cuts in one video, if any is waiting.
 *
 * ffmpeg's `scenechange` score is a normalised measure of how different a frame
 * is from the one before it; a hard cut spikes it toward 1 while a pan or a
 * fade does not. 0.3 is the usual working threshold — low enough to catch a cut
 * between similar shots, high enough not to fire on a camera move.
 *
 * This is what makes "segments" mean anything: an agent choosing a clip needs
 * somewhere sensible to cut, and the alternative is guessing at round numbers.
 *
 * Deliberately a separate step from probing. Probing reads a header and takes
 * milliseconds; this decodes every frame, so a ten-minute upload must not hold
 * up the measurement of everything queued behind it.
 */
async function detectShotsOne(): Promise<boolean> {
  const res = await fetch(`${API_URL}/api/assets/shots/next`, { headers })
  if (!res.ok) return false
  const { asset } = (await res.json()) as {
    asset: { id: string; duration_sec: number | null } | null
  }
  if (!asset) return false

  const tmp = join(tmpdir(), `euclid-shots-${asset.id}`)
  let shots: number[] = []
  try {
    const bytes = await fetch(`${API_URL}/api/assets/${asset.id}`, { headers })
    if (!bytes.ok) throw new Error(`fetch ${bytes.status}`)
    await writeFile(tmp, Buffer.from(await bytes.arrayBuffer()))

    // `showinfo` prints one line per frame that survived the select, each
    // carrying its pts_time — the timestamps are the whole output, so the
    // encoded frames go to /dev/null.
    const log = await new Promise<string>((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-v', 'info',
        '-i', tmp,
        '-filter:v', "select='gt(scene,0.3)',showinfo",
        '-f', 'null', '-',
      ])
      let stderr = ''
      ff.stderr.on('data', (d) => (stderr += d))
      ff.on('close', (code) => (code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg ${code}`))))
      ff.on('error', reject)
    })

    shots = [...log.matchAll(/pts_time:([0-9.]+)/g)]
      .map((m) => Number(m[1]))
      .filter((t) => Number.isFinite(t))
      // A cut in the first fraction of a second is the opening frame, not a
      // cut — every video "changes" from nothing at its start.
      .filter((t) => t > 0.25)
      .sort((a, b) => a - b)
  } catch (e) {
    console.error(`  shots ${asset.id.slice(0, 8)} failed: ${(e as Error).message}`)
  } finally {
    await unlink(tmp).catch(() => {})
  }

  await fetch(`${API_URL}/api/assets/${asset.id}/shots`, {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ shots }),
  })
  console.log(
    `  shots ${asset.id.slice(0, 8)}: ${shots.length} cut(s)` +
      (shots.length ? ` at ${shots.map((t) => t.toFixed(2)).join(', ')}s` : ''),
  )
  return true
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
    // Idle time is when uploaded files get measured. Renders come first —
    // someone is waiting on those — and probing only fills the gaps.
    // Cheap work first: measuring everything waiting beats watching one long
    // video while three uploads sit unmeasured.
    let did = await probeOne().catch((e) => {
      console.error(`probe error: ${(e as Error).message}`)
      return false
    })
    if (!did) {
      did = await detectShotsOne().catch((e) => {
        console.error(`shots error: ${(e as Error).message}`)
        return false
      })
    }
    if (!did) await new Promise((r) => setTimeout(r, POLL_MS))
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
