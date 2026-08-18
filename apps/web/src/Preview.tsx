import { useEffect, useRef } from 'react'
import { Application, Assets, Texture } from 'pixi.js'
import { EuclidStage } from '@euclid/engine/pixi'
import type { EuclidDoc } from '@euclid/dsl'
import { MathJaxTexProvider } from './tex'

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'

/**
 * The editor's half of the image seam: fetch the asset through the API with
 * the user's own session. The export worker cannot do this — it has no session
 * — which is exactly why this is a provider and not a URL the stage builds.
 */
const sessionImageProvider = {
  async getTexture(assetId: string): Promise<Texture> {
    const res = await fetch(`${API}/api/assets/${assetId}`, { credentials: 'include' })
    if (!res.ok) throw new Error(`asset ${assetId}: ${res.status}`)
    const url = URL.createObjectURL(await res.blob())
    try {
      return (await Assets.load(url)) as Texture
    } finally {
      // Pixi has decoded it by now; holding the object URL only leaks it.
      URL.revokeObjectURL(url)
    }
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
