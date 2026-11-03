import './load-env'
import { spawn } from 'node:child_process'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import {
  audibleAudio,
  docDuration,
  type AudioPlacement,
  type EuclidDoc,
} from '@euclid/dsl'
import { ivfFrame, ivfHeader } from './ivf'
import { preloadImages } from './preload'
import { buildFfmpegArgs } from './mux'

/**
 * Headless export worker. Replays the scene document frame-by-frame in
 * Chromium (the same EuclidStage code the browser preview runs) and pipes the
 * result into ffmpeg.
 *
 * Two capture paths. **WebCodecs** is preferred: the page encodes VP9 and
 * hands back ~1.7KB a frame, wrapped in IVF for ffmpeg. **Screenshots** are the
 * fallback, at ~75KB of PNG a frame. Measured at 1.6x apart (plans/003), the
 * difference being that both spend most of a frame reading pixels out of the
 * canvas and only one of them then compresses and ships a PNG. The fallback is
 * not vestigial: `VideoEncoder` is a secure-context API, so a render page
 * served over plain http has none.
 *
 * Deployment target: Cloudflare Containers, fed by a Queue the API's
 * /render endpoint pushes to. Runs identically on a laptop:
 *   pnpm --filter @euclid/renderer exec tsx src/render.ts --project <id> --out out.mp4
 * (Not `render -- --project`: pnpm forwards the `--` itself, and parseArgs
 * refuses it as an unexpected positional.)
 *
 * With --job it drives the job lifecycle: marks the job `rendering`, uploads
 * the MP4 to R2 through the API, marks it `done` — or marks it `failed`,
 * which refunds the user's credits. Without --job it just writes a local file.
 *
 * Narration audio (written into the document by generate_narration) is fetched
 * per scene and laid onto an audio timeline in the same ffmpeg invocation.
 *
 * Env: API_URL (default http://localhost:8787), INTERNAL_API_KEY,
 *      RENDER_PAGE_URL (default http://localhost:5173/render.html)
 */

const { values: args } = parseArgs({
  options: {
    project: { type: 'string' },
    out: { type: 'string', default: 'out.mp4' },
    job: { type: 'string' },
  },
})
if (!args.project) {
  console.error('usage: render --project <id> [--out out.mp4] [--job <jobId>]')
  process.exit(1)
}

const API_URL = process.env.API_URL ?? 'http://localhost:8787'
const RENDER_PAGE_URL = process.env.RENDER_PAGE_URL ?? 'http://localhost:5173/render.html'
const INTERNAL_HEADERS = {
  'x-internal-key': process.env.INTERNAL_API_KEY ?? 'dev-internal-key',
  'x-user-id': 'internal',
}

async function setJobStatus(status: 'rendering' | 'done' | 'failed', error?: string): Promise<void> {
  if (!args.job) return
  const res = await fetch(`${API_URL}/api/jobs/${args.job}`, {
    method: 'PATCH',
    headers: { ...INTERNAL_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ status, error }),
  })
  if (!res.ok) console.error(`warn: job status → ${status} failed: ${res.status} ${await res.text()}`)
}

async function uploadOutput(file: string): Promise<void> {
  if (!args.job) return
  const body = await readFile(file)
  const res = await fetch(`${API_URL}/api/jobs/${args.job}/output`, {
    method: 'PUT',
    headers: { ...INTERNAL_HEADERS, 'content-type': 'video/mp4' },
    body,
  })
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`)
  console.log(`uploaded ${(body.byteLength / 1024).toFixed(0)}KiB → ${(await res.json() as {key:string}).key}`)
}

/**
 * Download everything the document will play — narration and audio tracks
 * alike — to temp files ffmpeg can read. Muted lanes are never fetched: the
 * mix is decided by `audibleAudio`, not here.
 */
async function downloadAudio(doc: EuclidDoc): Promise<(AudioPlacement & { path: string })[]> {
  const clips: (AudioPlacement & { path: string })[] = []
  const byAsset = new Map<string, string>()
  for (const placement of audibleAudio(doc)) {
    // One asset used by several clips (a sting reused three times) is fetched
    // once and handed to ffmpeg as three inputs against the same file.
    let path = byAsset.get(placement.assetId)
    if (!path) {
      const res = await fetch(`${API_URL}/api/assets/${placement.assetId}`, {
        headers: INTERNAL_HEADERS,
      })
      if (!res.ok) {
        throw new Error(`audio asset ${placement.assetId} (${placement.label}): ${res.status}`)
      }
      path = join(tmpdir(), `euclid-audio-${placement.assetId}`)
      await writeFile(path, Buffer.from(await res.arrayBuffer()))
      byAsset.set(placement.assetId, path)
    }
    clips.push({ ...placement, path })
  }
  return clips
}

/** Frames encoded per round-trip into the page. */
const FRAME_BATCH = 30

async function main() {
  const docRes = await fetch(`${API_URL}/api/projects/${args.project}/doc`, {
    headers: INTERNAL_HEADERS,
  })
  if (!docRes.ok) throw new Error(`doc fetch failed: ${docRes.status} ${await docRes.text()}`)
  const { doc } = (await docRes.json()) as { doc: EuclidDoc }

  const fps = doc.canvas.fps
  const totalFrames = Math.ceil(docDuration(doc) * fps)
  console.log(`rendering "${doc.name}": ${totalFrames} frames @ ${fps}fps (${doc.canvas.width}x${doc.canvas.height})`)

  // With a job the artifact belongs in R2, so --out is bypassed for a temp file.
  const outPath = args.job ? join(tmpdir(), `euclid-${args.job}.mp4`) : args.out!
  await setJobStatus('rendering')

  const clips = await downloadAudio(doc)
  if (clips.length === 0) {
    console.log('no audio in this document — rendering silent')
  } else {
    for (const c of clips) {
      const cut = c.playSec < c.durationSec - 0.001 ? ` (cut from ${c.durationSec.toFixed(2)}s)` : ''
      const level = c.gain !== 1 ? ` @${c.gain.toFixed(2)}` : ''
      console.log(
        `  ${c.trackId}/${c.label}: ${c.startSec.toFixed(2)}s → ` +
          `${(c.startSec + c.playSec).toFixed(2)}s${cut}${level}`,
      )
    }
  }

  const browser = await chromium.launch({
    args: ['--force-color-profile=srgb', '--disable-lcd-text'],
  })
  try {
    const page = await browser.newPage({
      viewport: { width: doc.canvas.width, height: doc.canvas.height },
      deviceScaleFactor: 1,
    })
    await page.goto(RENDER_PAGE_URL, { waitUntil: 'networkidle' })
    await page.evaluate((d) => window.__euclid.load(d), doc as unknown)

    await preloadImages(page, doc, {
      apiUrl: API_URL,
      headers: INTERNAL_HEADERS,
      log: (m) => console.log(m),
    })

    // Ask the page rather than the environment: WebCodecs needs a secure
    // context, so whether it exists depends on how the render page is served,
    // not on which Chromium this is.
    let capture: 'ivf' | 'png' = 'png'
    // CAPTURE=png forces the fallback. Worth having: it is the only way to
    // exercise the path that production takes whenever the render page is not
    // a secure context, and the only way to compare the two on one document.
    const forced = process.env.CAPTURE
    try {
      if (forced === 'png') {
        console.log('capture: screenshots (CAPTURE=png)')
      } else if (await page.evaluate(() => typeof VideoEncoder !== 'undefined')) {
        const { codec } = await page.evaluate(() => window.__euclid.startEncode())
        capture = 'ivf'
        console.log(`capture: WebCodecs (${codec})`)
      } else {
        console.log('capture: screenshots — WebCodecs needs a secure context (https or localhost)')
      }
    } catch (e) {
      console.log(`capture: screenshots — WebCodecs unavailable (${(e as Error).message})`)
    }

    const ffmpeg = spawn('ffmpeg', buildFfmpegArgs(fps, clips, outPath, capture), {
      stdio: ['pipe', 'inherit', 'inherit'],
    })

    const write = (b: Buffer) =>
      new Promise<void>((resolve, reject) =>
        ffmpeg.stdin.write(b, (err) => (err ? reject(err) : resolve())),
      )

    if (capture === 'ivf') {
      await write(ivfHeader(doc.canvas.width, doc.canvas.height, fps, totalFrames))
      let pts = 0
      const drain = async () => {
        for (const chunk of await page.evaluate(() => window.__euclid.takeChunks())) {
          await write(ivfFrame(Buffer.from(chunk.data, 'base64'), pts++))
        }
      }
      // A batch is one round-trip for many frames, and the point at which
      // chunks come back — holding them all in the page would grow unbounded
      // over a long render.
      for (let f = 0; f < totalFrames; f += FRAME_BATCH) {
        const n = Math.min(FRAME_BATCH, totalFrames - f)
        await page.evaluate(
          ([from, count, keyEvery]) => window.__euclid.encodeRange(from, count, keyEvery),
          [f, n, fps] as [number, number, number],
        )
        await drain()
        console.log(`  frame ${Math.min(f + n, totalFrames)}/${totalFrames}`)
      }
      await page.evaluate(() => window.__euclid.finishEncode())
      await drain()
    } else {
      const canvas = page.locator('#euclid-canvas')
      for (let f = 0; f < totalFrames; f++) {
        const t = f / fps
        await page.evaluate((tt) => window.__euclid.renderFrame(tt), t)
        const png = await canvas.screenshot({ type: 'png' })
        await write(png)
        if (f % (fps * 5) === 0) console.log(`  frame ${f}/${totalFrames}`)
      }
    }

    ffmpeg.stdin.end()
    await new Promise<void>((resolve, reject) => {
      ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))))
    })
  } finally {
    await browser.close()
    await Promise.all(clips.map((c) => unlink(c.path).catch(() => {})))
  }

  if (args.job) {
    await uploadOutput(outPath)
    await setJobStatus('done')
    await unlink(outPath).catch(() => {})
    console.log(`done → job ${args.job}`)
  } else {
    console.log(`done → ${outPath}`)
  }
}

main().catch(async (e) => {
  console.error(e)
  // Marking failed refunds the user's credits; never leave a paid job stuck.
  await setJobStatus('failed', e instanceof Error ? e.message : String(e)).catch(() => {})
  process.exit(1)
})
