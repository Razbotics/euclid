import { useEffect, useRef } from 'react'
import { Application } from 'pixi.js'
import { EuclidStage } from '@euclid/engine/pixi'
import type { EuclidDoc } from '@euclid/dsl'
import { MathJaxTexProvider } from './tex'

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
        const stage = new EuclidStage(app.stage, { texProvider: new MathJaxTexProvider() })
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
