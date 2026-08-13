/**
 * Does WebCodecs work in our headless Chromium, and how fast does it encode
 * 1080p compared with the current screenshot-per-frame path?
 *   pnpm exec tsx src/bench-webcodecs.ts        (vite must be running)
 *
 * The browser half is a string, not a function: tsx/esbuild injects a __name
 * helper into transpiled functions that doesn't exist in the page context.
 */
import './load-env'
import { chromium } from 'playwright'

const PAGE = process.env.RENDER_PAGE_URL ?? 'http://localhost:5173/render.html'
const FRAMES = 180

const script = /* js */ `(async () => {
  if (typeof VideoEncoder === 'undefined') return { supported: false }

  const codecs = ['avc1.42001f', 'avc1.4d0028', 'vp09.00.10.08', 'av01.0.04M.08']
  const support = {}
  for (const codec of codecs) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: 1920, height: 1080, bitrate: 8e6 })
      support[codec] = r.supported ? (r.config && r.config.hardwareAcceleration || 'supported') : 'no'
    } catch (e) { support[codec] = 'error: ' + String(e.message).slice(0, 40) }
  }

  const entry = Object.entries(support).find(([, v]) => v !== 'no' && !String(v).startsWith('error'))
  if (!entry) return { supported: true, support, encoded: 0, ms: 0, codec: null }
  const codec = entry[0]

  // 1920x1080 canvas that changes every frame, so the encoder can't cheat
  // by emitting near-empty P-frames.
  const canvas = new OffscreenCanvas(1920, 1080)
  const ctx = canvas.getContext('2d')
  let encoded = 0, bytes = 0
  const encoder = new VideoEncoder({
    output: (chunk) => { encoded++; bytes += chunk.byteLength },
    error: (e) => console.error('encoder error', e),
  })
  encoder.configure({ codec, width: 1920, height: 1080, bitrate: 8e6, framerate: 60 })

  const t0 = performance.now()
  for (let i = 0; i < ${FRAMES}; i++) {
    ctx.fillStyle = 'hsl(' + ((i * 7) % 360) + ' 60% 20%)'
    ctx.fillRect(0, 0, 1920, 1080)
    ctx.fillStyle = '#fff'
    ctx.font = '120px serif'
    ctx.fillText('frame ' + i, 100 + (i % 200), 500)

    const frame = new VideoFrame(canvas, { timestamp: (i * 1e6) / 60 })
    encoder.encode(frame, { keyFrame: i % 120 === 0 })
    frame.close() // MUST close, or GPU-backed frames leak immediately
  }
  await encoder.flush()
  const ms = performance.now() - t0
  encoder.close()
  return { supported: true, support, encoded, bytes, ms, codec }
})()`

const browser = await chromium.launch({ args: ['--force-color-profile=srgb'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => console.error('[pageerror]', e.message))
await page.goto(PAGE, { waitUntil: 'domcontentloaded' })

const r = (await page.evaluate(script)) as {
  supported: boolean
  support?: Record<string, string>
  encoded?: number
  bytes?: number
  ms?: number
  codec?: string | null
}
await browser.close()

if (!r.supported) {
  console.log('WebCodecs NOT available in this Chromium')
} else {
  console.log('codec support (1080p @ 8Mbps):')
  for (const [k, v] of Object.entries(r.support ?? {})) console.log(`  ${k.padEnd(16)} ${v}`)
  if (r.codec && r.ms) {
    const fps = ((r.encoded ?? 0) / r.ms) * 1000
    console.log(`\nencoded ${r.encoded} frames via ${r.codec} in ${r.ms.toFixed(0)}ms`)
    console.log(`  → ${fps.toFixed(1)} fps encode   (screenshot path measured ~16.5 fps end-to-end)`)
    console.log(`  → ${(fps / 60).toFixed(2)}× realtime at 60fps`)
    console.log(`  → ${(((r.bytes ?? 0) / (r.encoded ?? 1)) / 1024).toFixed(1)} KiB/frame average`)
  }
}
