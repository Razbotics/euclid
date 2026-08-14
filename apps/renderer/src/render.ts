import './load-env'
import { spawn } from 'node:child_process'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import {
  docDuration,
  isTrimmed,
  planNarration,
  type EuclidDoc,
  type NarrationPlacement,
} from '@euclid/dsl'
import { buildFfmpegArgs } from './mux'

/**
 * Headless export worker. Replays the scene document frame-by-frame in
 * Chromium (the same EuclidStage code the browser preview runs) and pipes
 * PNG frames into ffmpeg.
 *
 * Deployment target: Cloudflare Containers, fed by a Queue the API's
 * /render endpoint pushes to. Runs identically on a laptop:
 *   pnpm --filter @euclid/renderer render -- --project <id> --out out.mp4
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

/** Download the planned narration clips to temp files ffmpeg can read. */
async function downloadNarration(
  doc: EuclidDoc,
): Promise<(NarrationPlacement & { path: string })[]> {
  const clips: (NarrationPlacement & { path: string })[] = []
  for (const placement of planNarration(doc)) {
    const res = await fetch(`${API_URL}/api/assets/${placement.assetId}`, {
      headers: INTERNAL_HEADERS,
    })
    if (!res.ok) {
      throw new Error(`narration asset ${placement.assetId} (scene ${placement.sceneId}): ${res.status}`)
    }
    const path = join(tmpdir(), `euclid-narr-${placement.sceneId}-${placement.assetId}.mp3`)
    await writeFile(path, Buffer.from(await res.arrayBuffer()))
    clips.push({ ...placement, path })
  }
  return clips
}

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

  const clips = await downloadNarration(doc)
  if (clips.length === 0) {
    console.log('no narration audio in this document — rendering silent')
  } else {
    for (const c of clips) {
      const cut = isTrimmed(c) ? ` (cut from ${c.durationSec.toFixed(2)}s)` : ''
      console.log(`  narration ${c.sceneId}: ${c.startSec}s → ${(c.startSec + c.playSec).toFixed(2)}s${cut}`)
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

    const ffmpeg = spawn('ffmpeg', buildFfmpegArgs(fps, clips, outPath), {
      stdio: ['pipe', 'inherit', 'inherit'],
    })

    const canvas = page.locator('#euclid-canvas')
    for (let f = 0; f < totalFrames; f++) {
      const t = f / fps
      await page.evaluate((tt) => window.__euclid.renderFrame(tt), t)
      const png = await canvas.screenshot({ type: 'png' })
      await new Promise<void>((resolve, reject) =>
        ffmpeg.stdin.write(png, (err) => (err ? reject(err) : resolve())),
      )
      if (f % (fps * 5) === 0) console.log(`  frame ${f}/${totalFrames}`)
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
