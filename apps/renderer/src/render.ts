import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import { docDuration, type EuclidDoc } from '@euclid/dsl'

/**
 * Headless export worker. Replays the scene document frame-by-frame in
 * Chromium (the same EuclidStage code the browser preview runs) and pipes
 * PNG frames into ffmpeg.
 *
 * Deployment target: Cloudflare Containers, fed by a Queue the API's
 * /render endpoint pushes to. Runs identically on a laptop:
 *   pnpm --filter @euclid/renderer render -- --project <id> --out out.mp4
 *
 * Env: API_URL (default http://localhost:8787), INTERNAL_API_KEY,
 *      RENDER_PAGE_URL (default http://localhost:5173/render.html)
 *
 * TODO(pipeline): upload result to R2, PATCH render_jobs status, mux TTS
 * narration audio (generated per scene via the TTS adapter) with -i audio.
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

async function main() {
  const docRes = await fetch(`${API_URL}/api/projects/${args.project}/doc`, {
    headers: {
      'x-internal-key': process.env.INTERNAL_API_KEY ?? 'dev-internal-key',
      'x-user-id': 'internal',
    },
  })
  if (!docRes.ok) throw new Error(`doc fetch failed: ${docRes.status} ${await docRes.text()}`)
  const { doc } = (await docRes.json()) as { doc: EuclidDoc }

  const fps = doc.canvas.fps
  const totalFrames = Math.ceil(docDuration(doc) * fps)
  console.log(`rendering "${doc.name}": ${totalFrames} frames @ ${fps}fps (${doc.canvas.width}x${doc.canvas.height})`)

  const browser = await chromium.launch({
    args: ['--force-color-profile=srgb', '--disable-lcd-text'],
  })
  const page = await browser.newPage({
    viewport: { width: doc.canvas.width, height: doc.canvas.height },
    deviceScaleFactor: 1,
  })
  await page.goto(RENDER_PAGE_URL, { waitUntil: 'networkidle' })
  await page.evaluate((d) => window.__euclid.load(d), doc as unknown)

  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-y',
      '-f', 'image2pipe',
      '-framerate', String(fps),
      '-i', '-',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '18',
      args.out!,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  )

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
  await browser.close()
  console.log(`done → ${args.out}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
