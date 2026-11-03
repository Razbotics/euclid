import { Application } from 'pixi.js'
import { EuclidDocSchema, type EuclidDoc } from '@euclid/dsl'
import { Assets, Texture } from 'pixi.js'
import { EuclidStage, type ImageProvider, type VideoProvider } from '@euclid/engine/pixi'
import { MathJaxTexProvider } from './tex'

/**
 * Headless export surface. apps/renderer drives this page in Chromium:
 *   await window.__euclid.load(docJson)
 *   for each frame: await window.__euclid.renderFrame(t)  → screenshot canvas
 * renderFrame awaits pending LaTeX textures before returning, so every
 * captured frame is complete — determinism over latency.
 */

let app: Application | null = null
let stage: EuclidStage | null = null
let doc: EuclidDoc | null = null
let encoder: VideoEncoder | null = null
/** assetId → data URL, filled by preloadAsset before the first frame. */
const assetUrls = new Map<string, string>()
/**
 * One <video> per asset, seeked to the second the document asked for and
 * snapshotted into a texture.
 *
 * A snapshot rather than a live video texture: a texture backed by a playing
 * element shows whatever the element happens to be showing when the frame
 * composites, which is a race, and export is not played back in real time
 * anyway. Seeking and copying is slower and is the only version that can be a
 * function of `t`.
 *
 * `seeked` is awaited before the copy — Chromium fires it once the frame for
 * that time is actually presented, and copying before it lands would silently
 * duplicate the previous frame.
 */
const videoEls = new Map<string, HTMLVideoElement>()

async function videoFor(assetId: string): Promise<HTMLVideoElement> {
  const existing = videoEls.get(assetId)
  if (existing) return existing
  const url = assetUrls.get(assetId)
  if (!url) throw new Error(`asset ${assetId} was not preloaded`)
  const el = document.createElement('video')
  el.src = url
  el.muted = true
  el.playsInline = true
  el.preload = 'auto'
  await new Promise<void>((resolve, reject) => {
    el.onloadeddata = () => resolve()
    el.onerror = () => reject(new Error(`asset ${assetId} is not decodable video`))
  })
  videoEls.set(assetId, el)
  return el
}

const snapshotCanvas = document.createElement('canvas')
/** Per asset, the tail of its seek queue. */
const videoQueue = new Map<string, Promise<unknown>>()

const preloadedVideo: VideoProvider = {
  /**
   * Seeks on one element run one at a time, each followed by its own copy.
   *
   * Two nodes can play the same asset on the same frame — a cut between two
   * slices of one clip whose times round across the boundary (a slice ending
   * at 7.5002s, the next starting at 7.50s). Both requests used to seek the one
   * <video> at once; the second assignment of `onseeked` replaced the first,
   * so the first promise never settled, `whenIdle()` never resolved, and the
   * export hung forever on that frame. Queued, every request still gets its
   * exact frame — unlike the editor, nothing here may be skipped.
   */
  async getFrame(assetId: string, sourceSec: number) {
    const el = await videoFor(assetId)
    // Clamp rather than fail: a document may ask past the end of a clip whose
    // real duration differs from what was recorded when it was placed.
    const want = Math.max(0, Math.min(sourceSec, Math.max(0, el.duration - 1e-3)))
    const run = async (): Promise<Texture> => {
      if (Math.abs(el.currentTime - want) > 1e-4) {
        await new Promise<void>((resolve, reject) => {
          el.onseeked = () => resolve()
          el.onerror = () => reject(new Error(`seek failed on ${assetId}`))
          el.currentTime = want
        })
      }
      snapshotCanvas.width = el.videoWidth
      snapshotCanvas.height = el.videoHeight
      const g = snapshotCanvas.getContext('2d')!
      g.drawImage(el, 0, 0)
      // A fresh bitmap per frame: a texture sharing the canvas would change
      // under the renderer the moment the next frame is drawn into it.
      const bitmap = await createImageBitmap(snapshotCanvas)
      return Texture.from(bitmap)
    }
    const tail = videoQueue.get(assetId) ?? Promise.resolve()
    const next = tail.then(run, run)
    videoQueue.set(assetId, next.catch(() => undefined))
    return next
  },
}

const preloaded: ImageProvider = {
  async getTexture(assetId: string) {
    const url = assetUrls.get(assetId)
    if (!url) throw new Error(`asset ${assetId} was not preloaded`)
    return (await Assets.load(url)) as Texture
  },
}
let pending: EncodedChunkOut[] = []

/**
 * VP9 rather than H.264, everywhere, on purpose.
 *
 * Chromium on Linux has no H.264 *encoder* (measured — see plans/003), so a
 * pipeline that picks the best codec available would silently produce a
 * different file on a developer's Mac than in the render container. One codec
 * on both keeps the export reproducible; ffmpeg transcodes to H.264 at the end,
 * where MP4 is required.
 */
const CAPTURE_CODEC = 'vp09.00.10.08'

function toBase64(bytes: Uint8Array): string {
  let s = ''
  // Chunked: String.fromCharCode(...bytes) overflows the argument limit on a
  // keyframe, which is exactly the frame you cannot afford to lose.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

export interface EncodedChunkOut {
  /** base64 — Playwright's protocol is JSON, and 15KB of VP9 costs less to
   *  base64 than one 1-2MB PNG costs to move at all. */
  data: string
  key: boolean
  timestamp: number
}

declare global {
  interface Window {
    __euclid: {
      load(docJson: unknown): Promise<{ width: number; height: number; fps: number }>
      /**
       * Hand the page an asset's bytes as a data URL. The page has no session
       * and no internal key, so it cannot fetch a project asset itself — the
       * renderer, which can, pushes them in before capture starts.
       */
      preloadAsset(assetId: string, dataUrl: string): Promise<void>
      renderFrame(t: number): Promise<void>
      /** WebCodecs capture. Returns the codec actually configured. */
      startEncode(opts?: { bitrate?: number }): Promise<{ codec: string }>
      /** Render at `t` and hand the frame straight to the encoder — no readback. */
      encodeFrame(t: number, index: number, keyFrame: boolean): Promise<void>
      /**
       * Encode a whole run of frames in one call. The times are derived here
       * from the document's own fps, so the driver never has to round-trip
       * per frame — which is what the round-trip removal was for.
       */
      encodeRange(
        fromIndex: number,
        count: number,
        keyEvery: number,
      ): Promise<{ encodeMs: number; renderMs: number; grabMs: number; waitMs: number }>
      /** Drain whatever the encoder has produced so far. */
      takeChunks(): EncodedChunkOut[]
      /** Flush the encoder; call takeChunks once more afterwards. */
      finishEncode(): Promise<void>
    }
  }
}

window.__euclid = {
  async load(docJson: unknown) {
    doc = EuclidDocSchema.parse(docJson)

    // Tear down any previous document first.
    //
    // Without this, every load appends another canvas carrying the same id, so
    // `getElementById('euclid-canvas')` keeps returning the *first* one — which
    // nothing renders into any more. A one-shot script never notices, because
    // it loads once; a long-lived capture process (the preview server, and the
    // render container that will replace it) gets a correct-looking black frame
    // for every document after the first.
    if (app) {
      app.destroy({ removeView: true }, { children: true, texture: true })
      app = null
      stage = null
    }
    document.getElementById('euclid-canvas')?.remove()

    app = new Application()
    await app.init({
      width: doc.canvas.width,
      height: doc.canvas.height,
      background: '#000000',
      antialias: true,
      autoStart: false,
      preference: 'webgl',
    })
    document.body.appendChild(app.canvas)
    app.canvas.id = 'euclid-canvas'
    stage = new EuclidStage(app.stage, {
      texProvider: new MathJaxTexProvider(),
      imageProvider: preloaded,
      videoProvider: preloadedVideo,
    })
    return { width: doc.canvas.width, height: doc.canvas.height, fps: doc.canvas.fps }
  },

  async preloadAsset(assetId: string, dataUrl: string) {
    assetUrls.set(assetId, dataUrl)
    // Warmed here rather than on first draw, so the first captured frame is
    // never the one that pays for the download.
    await Assets.load(dataUrl)
  },

  async renderFrame(t: number) {
    if (!app || !stage || !doc) throw new Error('call load() first')
    stage.update(doc, t)
    await stage.whenIdle()
    stage.update(doc, t) // re-project now that all textures exist
    app.renderer.render(app.stage)
  },

  async startEncode(opts?: { bitrate?: number; codec?: string; realtime?: boolean }) {
    if (!app || !doc) throw new Error('call load() first')
    if (typeof VideoEncoder === 'undefined') throw new Error('WebCodecs is not available')
    const codec = opts?.codec ?? CAPTURE_CODEC
    const config: VideoEncoderConfig = {
      codec,
      width: doc.canvas.width,
      height: doc.canvas.height,
      bitrate: opts?.bitrate ?? 12_000_000,
      framerate: doc.canvas.fps,
      // 'realtime' asks libvpx for a faster speed setting. This is an
      // *intermediate* — ffmpeg re-encodes it to H.264 — so the trade is
      // encoder time against a generation of loss, and it is worth measuring
      // rather than assuming either way.
      ...(opts?.realtime ? { latencyMode: 'realtime' as const } : {}),
    }
    const support = await VideoEncoder.isConfigSupported(config)
    if (!support.supported) throw new Error(`${codec} is not supported here`)

    pending = []
    encoder = new VideoEncoder({
      output: (chunk) => {
        const buf = new Uint8Array(chunk.byteLength)
        chunk.copyTo(buf)
        pending.push({
          data: toBase64(buf),
          key: chunk.type === 'key',
          timestamp: chunk.timestamp,
        })
      },
      error: (e) => {
        throw e
      },
    })
    encoder.configure(config)
    return { codec }
  },

  async encodeFrame(t: number, index: number, keyFrame: boolean) {
    if (!app || !stage || !doc || !encoder) throw new Error('call startEncode() first')
    stage.update(doc, t)
    await stage.whenIdle()
    stage.update(doc, t)
    app.renderer.render(app.stage)

    // The VideoFrame is constructed in the same task as the render, before any
    // paint can intervene. Pixi's context has no `preserveDrawingBuffer`, so the
    // drawing buffer is cleared once the frame composites — reading it from a
    // later call is how the contact sheet used to get silently black tiles.
    const frame = new VideoFrame(app.canvas, {
      timestamp: Math.round((index * 1_000_000) / doc.canvas.fps),
      duration: Math.round(1_000_000 / doc.canvas.fps),
    })
    encoder.encode(frame, { keyFrame })
    frame.close()

    // Back-pressure: without it the encoder queue grows unbounded and the tab
    // is killed part-way through a long render.
    while (encoder.encodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 1))
    }
  },

  async encodeRange(fromIndex: number, count: number, keyEvery: number) {
    if (!app || !stage || !doc || !encoder) throw new Error('call startEncode() first')
    const fps = doc.canvas.fps
    let renderMs = 0
    let encodeMs = 0
    let grabMs = 0
    let waitMs = 0
    for (let i = 0; i < count; i++) {
      const index = fromIndex + i
      const t = index / fps
      let m = performance.now()
      stage.update(doc, t)
      await stage.whenIdle()
      stage.update(doc, t)
      app.renderer.render(app.stage)
      renderMs += performance.now() - m

      // Timed apart, because they are different costs wearing one name:
      // constructing the VideoFrame reads 1920x1080 back out of the canvas and
      // converts RGBA to YUV, while encode() only queues work.
      m = performance.now()
      const frame = new VideoFrame(app.canvas, {
        timestamp: Math.round((index * 1_000_000) / fps),
        duration: Math.round(1_000_000 / fps),
      })
      grabMs += performance.now() - m

      m = performance.now()
      encoder.encode(frame, { keyFrame: index % keyEvery === 0 })
      frame.close()
      encodeMs += performance.now() - m

      const w = performance.now()
      while (encoder.encodeQueueSize > 8) {
        await new Promise((r) => setTimeout(r, 0))
      }
      waitMs += performance.now() - w
    }
    return { encodeMs, renderMs, grabMs, waitMs }
  },

  takeChunks() {
    const out = pending
    pending = []
    return out
  },

  async finishEncode() {
    if (!encoder) return
    await encoder.flush()
    encoder.close()
    encoder = null
  },
}
