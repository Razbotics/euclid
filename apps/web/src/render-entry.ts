import { Application } from 'pixi.js'
import { EuclidDocSchema, type EuclidDoc } from '@euclid/dsl'
import { EuclidStage } from '@euclid/engine/pixi'
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

declare global {
  interface Window {
    __euclid: {
      load(docJson: unknown): Promise<{ width: number; height: number; fps: number }>
      renderFrame(t: number): Promise<void>
    }
  }
}

window.__euclid = {
  async load(docJson: unknown) {
    doc = EuclidDocSchema.parse(docJson)
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
    stage = new EuclidStage(app.stage, { texProvider: new MathJaxTexProvider() })
    return { width: doc.canvas.width, height: doc.canvas.height, fps: doc.canvas.fps }
  },

  async renderFrame(t: number) {
    if (!app || !stage || !doc) throw new Error('call load() first')
    stage.update(doc, t)
    await stage.whenIdle()
    stage.update(doc, t) // re-project now that all textures exist
    app.renderer.render(app.stage)
  },
}
