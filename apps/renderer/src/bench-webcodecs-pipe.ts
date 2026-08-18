/**
 * Spike: does VP9 → IVF → ffmpeg → MP4 actually work, and how fast?
 *   pnpm --filter @euclid/renderer exec tsx src/bench-webcodecs-pipe.ts
 *
 * The point of comparison is bench-capture.ts, which measured the existing
 * screenshot path at 97-99% PNG round-trip. This runs the same document
 * through the encoder instead and reports frames per second end to end.
 */
import './load-env'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { chromium } from 'playwright'
import { SCHEMA_VERSION, type EuclidDoc } from '@euclid/dsl'
import { ivfFrame, ivfHeader } from './ivf'

const PAGE = process.env.RENDER_PAGE_URL ?? 'http://localhost:5173/render.html'
const FRAMES = Number(process.env.FRAMES ?? 120)
const OUT = process.env.OUT ?? '/tmp/webcodecs-spike.mp4'
const DRAIN_EVERY = 30

const node = (extra: Record<string, unknown>) => ({
  scale: 1, rotation: 0, opacity: 1, tracks: [], transitions: [], ...extra,
})
const doc = {
  schema: SCHEMA_VERSION, id: 'spike', name: 'webcodecs spike',
  canvas: { width: 1920, height: 1080, fps: 60 },
  scenes: [
    {
      id: 'sc', name: 'sc', duration: 10, background: '#0d1117',
      camera: { position: { x: 960, y: 540 }, zoom: 1, rotation: 0, yaw: 0.6, pitch: 0.35, distance: 2000, tracks: [] },
      nodes: [
        node({
          id: 'm1', type: 'mesh', position: { x: 960, y: 540 }, z: 0,
          geometry: { kind: 'sphere', radius: 380, segments: 64 },
          fill: '#58c4dd', shading: 'flat', ambient: 0.25, cull: true, strokeWidth: 1,
        }),
        node({ id: 't1', type: 'text', position: { x: 960, y: 140 }, text: 'webcodecs', fontSize: 72, fill: '#e6edf3', fontFamily: 'sans-serif' }),
      ],
    },
  ],
} as unknown as EuclidDoc

/**
 * WebCodecs is a **secure-context** API. `localhost` qualifies; a LAN address
 * over plain http does not, and `VideoEncoder` is then simply `undefined` —
 * which reads as "this browser has no WebCodecs" rather than "this URL is not
 * trusted". `--unsafely-treat-insecure-origin-as-secure` does not flip
 * `isSecureContext`, so the reliable fix is to make the page *be* on localhost.
 *
 * Inside a container the dev server is on the host, so this forwards
 * 127.0.0.1:<port> to it. Production serves the render page over https and none
 * of this applies.
 */
async function localise(pageUrl: string): Promise<string> {
  const url = new URL(pageUrl)
  if (url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return pageUrl
  }
  const upstreamHost = url.hostname
  const upstreamPort = Number(url.port || 80)
  const server = createServer()
  server.on('connection', (down) => {
    const up = connect(upstreamPort, upstreamHost)
    down.pipe(up)
    up.pipe(down)
    const bin = () => {
      down.destroy()
      up.destroy()
    }
    down.on('error', bin)
    up.on('error', bin)
  })
  await new Promise<void>((resolve) => server.listen(upstreamPort, '127.0.0.1', resolve))
  server.unref()
  url.hostname = 'localhost'
  console.log(`note:   forwarding localhost:${upstreamPort} → ${upstreamHost}:${upstreamPort} for a secure context`)
  return url.toString()
}

const pageUrl = await localise(PAGE)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
page.on('pageerror', (e) => console.error('[pageerror]', e.message))
await page.goto(pageUrl, { waitUntil: 'networkidle' })
const meta = await page.evaluate((d) => window.__euclid.load(d), doc as unknown)
const { codec } = await page.evaluate(
  (o) => window.__euclid.startEncode(o),
  {
    ...(process.env.CODEC ? { codec: process.env.CODEC } : {}),
    ...(process.env.REALTIME === '1' ? { realtime: true } : {}),
    ...(process.env.BITRATE ? { bitrate: Number(process.env.BITRATE) } : {}),
  } as { codec?: string; realtime?: boolean; bitrate?: number },
)
console.log(`page:   ${pageUrl}\ncodec:  ${codec}\nframes: ${FRAMES} at ${meta.width}x${meta.height}@${meta.fps}\n`)

const parts: Buffer[] = [ivfHeader(meta.width, meta.height, meta.fps, FRAMES, codec.startsWith('vp8') ? 'VP80' : 'VP90')]
let pts = 0
let encodedBytes = 0
const drain = async () => {
  const chunks = await page.evaluate(() => window.__euclid.takeChunks())
  for (const c of chunks) {
    const payload = Buffer.from(c.data, 'base64')
    encodedBytes += payload.byteLength
    parts.push(ivfFrame(payload, pts++))
  }
}

const t0 = performance.now()
let pageRenderMs = 0
let pageEncodeMs = 0
let pageGrabMs = 0
let pageWaitMs = 0
for (let f = 0; f < FRAMES; f += DRAIN_EVERY) {
  const n = Math.min(DRAIN_EVERY, FRAMES - f)
  const split = await page.evaluate(
    ([from, count, keyEvery]) => window.__euclid.encodeRange(from, count, keyEvery),
    [f, n, 60] as [number, number, number],
  )
  pageRenderMs += split.renderMs
  pageEncodeMs += split.encodeMs
  pageGrabMs += split.grabMs
  pageWaitMs += split.waitMs
  await drain()
}
await page.evaluate(() => window.__euclid.finishEncode())
await drain()
const captureMs = performance.now() - t0
await browser.close()

const ivfPath = '/tmp/webcodecs-spike.ivf'
writeFileSync(ivfPath, Buffer.concat(parts))

const t1 = performance.now()
await new Promise<void>((resolve, reject) => {
  const ff = spawn('ffmpeg', ['-y', '-f', 'ivf', '-i', ivfPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', OUT], { stdio: ['ignore', 'ignore', 'inherit'] })
  ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`))))
})
const transcodeMs = performance.now() - t1

const per = captureMs / FRAMES
console.log(
  `  in-page: render ${(pageRenderMs / FRAMES).toFixed(1)} | VideoFrame ${(pageGrabMs / FRAMES).toFixed(1)} | ` +
    `encode ${(pageEncodeMs / FRAMES).toFixed(1)} | backpressure ${(pageWaitMs / FRAMES).toFixed(1)} ms/frame\n` +
    `capture    ${per.toFixed(1)} ms/frame → ${(1000 / per).toFixed(1)} fps ` +
    `(${((1000 / per) / meta.fps).toFixed(2)}x realtime)\n` +
    `           ${(encodedBytes / FRAMES / 1024).toFixed(1)} KB/frame encoded ` +
    `(a PNG of this frame was ~75KB)\n` +
    `transcode  ${(transcodeMs / 1000).toFixed(1)}s for ${FRAMES} frames ` +
    `(${(FRAMES / (transcodeMs / 1000)).toFixed(0)} fps)\n` +
    `total      ${((captureMs + transcodeMs) / FRAMES).toFixed(1)} ms/frame → ` +
    `${(1000 / ((captureMs + transcodeMs) / FRAMES)).toFixed(1)} fps\n` +
    `out        ${OUT}`,
)
