import { mathjax } from 'mathjax-full/js/mathjax.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { SVG } from 'mathjax-full/js/output/svg.js'
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js'
import { Texture } from 'pixi.js'
import type { TexProvider } from '@euclid/engine/pixi'

/**
 * TeX → SVG (MathJax, in-memory lite DOM) → rasterized canvas → Pixi texture.
 * Runs identically in the browser preview and the headless export page,
 * which is what keeps preview and final render pixel-identical.
 */
export class MathJaxTexProvider implements TexProvider {
  private adaptor = liteAdaptor()
  private mjDoc: ReturnType<typeof mathjax.document>

  constructor() {
    RegisterHTMLHandler(this.adaptor)
    this.mjDoc = mathjax.document('', {
      InputJax: new TeX({ packages: AllPackages }),
      OutputJax: new SVG({ fontCache: 'local' }),
    })
  }

  async getTexture(tex: string, color: string, fontSize: number): Promise<Texture> {
    const node = this.mjDoc.convert(tex, { display: true })
    let svg = this.adaptor.innerHTML(node)

    // MathJax sizes in ex; scale so the equation's em-height ≈ fontSize px.
    const exToPx = fontSize * 0.5
    let widthPx = 100
    let heightPx = 40
    svg = svg.replace(/width="([\d.]+)ex"/, (_, w: string) => {
      widthPx = Math.max(1, Math.ceil(parseFloat(w) * exToPx))
      return `width="${widthPx}px"`
    })
    svg = svg.replace(/height="([\d.]+)ex"/, (_, h: string) => {
      heightPx = Math.max(1, Math.ceil(parseFloat(h) * exToPx))
      return `height="${heightPx}px"`
    })
    // MathJax paints with currentColor; set it on the root
    svg = svg.replace('<svg ', `<svg color="${color}" `)

    const img = new Image()
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    try {
      img.src = url
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = widthPx
      canvas.height = heightPx
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, widthPx, heightPx)
      return Texture.from(canvas)
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}
