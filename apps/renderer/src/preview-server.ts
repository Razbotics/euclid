/**
 * Capture backend for the `preview_frames` capability.
 *   pnpm --filter @euclid/renderer exec tsx src/preview-server.ts
 *
 * The API worker cannot run Chromium — it is a Cloudflare Worker — so the
 * capability posts a document and a time list here and gets a PNG back. This
 * is the "local path" of plans/007: it does not by itself serve a shell-less
 * client in production, but it is the same capture the render backend will run,
 * behind the same request shape, so binding it to Browser Rendering or the
 * render Container later changes the origin and nothing else.
 *
 * It holds one warm browser. Chromium launch plus document parse costs more
 * than the frames do, and a preview that pays that per call is a preview
 * nobody calls twice — which would defeat the point of making it free.
 */
import './load-env'
import { createServer } from 'node:http'
import type { EuclidDoc } from '@euclid/dsl'
import { PreviewCapturer } from './sheet'

const PORT = Number(process.env.PREVIEW_PORT ?? 8790)
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'

const capturer = new PreviewCapturer()

/** Serialised: one browser, one page — concurrent captures would interleave frames. */
let queue: Promise<unknown> = Promise.resolve()
function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.catch(() => {})
  return next
}

const server = createServer((req, res) => {
  const send = (status: number, body: string, type = 'text/plain') => {
    res.writeHead(status, { 'content-type': type })
    res.end(body)
  }

  if (req.method === 'GET' && req.url === '/health') return send(200, 'ok')

  // Same shared secret as every other service-to-service hop here.
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
          `${req.url} ${body.tiles?.length ?? 1} frame(s) → ${(png.byteLength / 1024).toFixed(0)}KB ` +
            `in ${((Date.now() - started) / 1000).toFixed(1)}s` +
            (ink.length ? ` ink=[${ink.map((v) => (v * 100).toFixed(1)).join(' ')}]%` : ''),
        )
      })
      .catch((e: Error) => {
        console.error(`${req.url} failed:`, e.message)
        send(500, e.message)
      })
  })
})

server.listen(PORT, () => console.log(`preview server on http://localhost:${PORT}`))

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void capturer.close().then(() => process.exit(0))
  })
}
