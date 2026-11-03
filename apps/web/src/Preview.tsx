import { useEffect, useRef } from 'react'
import { Application, Texture } from 'pixi.js'
import { EuclidStage } from '@euclid/engine/pixi'
import type { EuclidDoc } from '@euclid/dsl'
import { MathJaxTexProvider } from './tex'
import { assetUrl } from './useAssets'

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'

/**
 * The editor's half of the image seam: fetch the asset through the API with
 * the user's own session. The export worker cannot do this — it has no session
 * — which is exactly why this is a provider and not a URL the stage builds.
 */
/**
 * The editor seeks a blob URL of the whole asset rather than re-fetching per
 * frame — scrubbing asks for a new second constantly, and a request each time
 * would be both slow and a different kind of answer than the export gives.
 *
 * **And it asks for the proxy.** Downloading the file whole is what makes the
 * source's size the wait before anything appears, and seeking inside it is what
 * makes the source's keyframe spacing the wait on every scrub after that; a
 * proxy is built to bound both. This is the only surface that does ask — the
 * export and `preview_frames` go through `preload.ts`, which reads the
 * original, so what an agent checks and what ships stay the same pixels.
 */
const videoEls = new Map<string, Promise<HTMLVideoElement>>()
/** Per asset: the newest request, and the tail of the seek queue. */
const videoLatest = new Map<string, number>()
const videoQueue = new Map<string, Promise<unknown>>()
let videoRequestSeq = 0

function seek(el: HTMLVideoElement, assetId: string, want: number): Promise<void> {
  if (Math.abs(el.currentTime - want) <= 1e-4) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    el.onseeked = () => resolve()
    el.onerror = () => reject(new Error(`seek failed on ${assetId}`))
    el.currentTime = want
  })
}

const sessionVideoProvider = {
  /**
   * One seek at a time per element, and only the newest request gets one.
   *
   * Playback asks for a new frame every tick, faster than a seek completes.
   * This used to start a seek per request on the same <video>, each assigning
   * `onseeked` over the last — so every earlier request's promise never
   * settled, and a playing clip drew nothing. Now requests queue behind each
   * other, and one superseded before its turn is refused instead of seeking.
   * The stage treats a refusal as "not ready" and shows the frame it has.
   */
  async getFrame(assetId: string, sourceSec: number): Promise<Texture> {
    let elp = videoEls.get(assetId)
    if (!elp) {
      elp = (async () => {
        const res = await fetch(assetUrl(assetId, 'proxy'), { credentials: 'include' })
        if (!res.ok) throw new Error(`asset ${assetId}: ${res.status}`)
        const el = document.createElement('video')
        el.src = URL.createObjectURL(await res.blob())
        el.muted = true
        el.playsInline = true
        await new Promise<void>((resolve, reject) => {
          el.onloadeddata = () => resolve()
          el.onerror = () => reject(new Error(`asset ${assetId} is not decodable video`))
        })
        return el
      })()
      videoEls.set(assetId, elp)
    }
    const el = await elp
    const want = Math.max(0, Math.min(sourceSec, Math.max(0, el.duration - 1e-3)))
    const token = ++videoRequestSeq
    videoLatest.set(assetId, token)

    const run = async (): Promise<Texture> => {
      if (videoLatest.get(assetId) !== token) throw new Error('superseded')
      await seek(el, assetId, want)
      // Straight from the element: a shared scratch canvas raced when two
      // clips decoded at once.
      return Texture.from(await createImageBitmap(el))
    }
    const tail = videoQueue.get(assetId) ?? Promise.resolve()
    const next = tail.then(run, run)
    videoQueue.set(assetId, next.catch(() => undefined))
    return next
  },
}

const sessionImageProvider = {
  async getTexture(assetId: string): Promise<Texture> {
    const res = await fetch(`${API}/api/assets/${assetId}`, { credentials: 'include' })
    if (!res.ok) throw new Error(`asset ${assetId}: ${res.status}`)
    // Decode here and hand Pixi pixels, the way the video provider does.
    // `Assets.load` picks its parser from the URL's file extension, and a
    // blob: URL has none — it warned "we don't know how to parse it" and the
    // canvas silently drew nothing (found by milestone run 8, the first time
    // a real image reached the *editor* canvas rather than the export).
    return Texture.from(await createImageBitmap(await res.blob()))
  },
}

interface Props {
  doc: EuclidDoc
  time: number
}

/**
 * The sync-head canvas. The Pixi app runs its own ticker; every tick it
 * projects (doc, time) through EuclidStage — the same code path the export
 * worker uses, so what you scrub is what ships.
 */
export function Preview({ doc, time }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const docRef = useRef(doc)
  const timeRef = useRef(time)
  docRef.current = doc
  timeRef.current = time

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let destroyed = false
    const app = new Application()

    // destroy() must never run before init() resolves (Pixi v8 requires a
    // fully-initialized app), and React StrictMode unmounts immediately in
    // dev — so cleanup chains off the init promise instead of firing directly.
    const ready = app
      .init({
        width: docRef.current.canvas.width,
        height: docRef.current.canvas.height,
        background: '#000000',
        antialias: true,
      })
      .then(() => {
        if (destroyed) return
        host.appendChild(app.canvas)
        app.canvas.style.width = '100%'
        app.canvas.style.height = 'auto'
        const stage = new EuclidStage(app.stage, {
          texProvider: new MathJaxTexProvider(),
          imageProvider: sessionImageProvider,
          videoProvider: sessionVideoProvider,
          // Editor only — see the option's doc. Export never sets it.
          holdVideoFrames: true,
        })
        app.ticker.add(() => {
          stage.update(docRef.current, timeRef.current)
        })
      })

    return () => {
      destroyed = true
      void ready.then(() => app.destroy(true))
    }
  }, [])

  return <div ref={hostRef} className="preview" />
}
