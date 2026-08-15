import { mathjax } from 'mathjax-full/js/mathjax.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { SVG } from 'mathjax-full/js/output/svg.js'
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js'
import { Rectangle, Texture } from 'pixi.js'
import type { TexGlyphRender, TexProvider } from '@euclid/engine/pixi'

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

  /**
   * The same equation as one texture per glyph, which is what lets the stage
   * morph matched glyphs instead of cross-fading whole equations.
   *
   * The SVG is rasterized **once** and each glyph becomes a sub-texture frame
   * of that one bitmap — far cheaper than rasterizing a glyph at a time, and
   * it guarantees the pieces are pixel-identical to the whole.
   *
   * Positions come from measuring the live SVG in a hidden element, because
   * MathJax nests `translate()`/`scale()` transforms and the browser already
   * knows how to compose them. Both the preview and the headless export page
   * are Chromium, so the measurements agree and preview/export stay identical.
   */
  async getGlyphs(tex: string, color: string, fontSize: number): Promise<TexGlyphRender[]> {
    const { svg, widthPx, heightPx } = this.buildSvg(tex, color, fontSize)

    const host = this.measureHost()
    host.innerHTML = svg
    const root = host.querySelector('svg')
    if (!root) return []

    const box = root.getBoundingClientRect()
    // `use` is a glyph; `rect` is a rule — a fraction bar or \overline. Both
    // are drawn, so both must be carried across or the morph loses them.
    const drawn = Array.from(root.querySelectorAll('use, rect'))
    const measured: { code: string; rect: DOMRect }[] = []
    for (const el of drawn) {
      const rect = el.getBoundingClientRect()
      if (rect.width < 0.5 || rect.height < 0.5) continue // invisible spacers
      const code = el.tagName === 'rect' ? 'rule' : (el.getAttribute('data-c') ?? 'glyph')
      measured.push({ code, rect })
    }
    host.innerHTML = ''
    if (measured.length === 0) return []

    const canvas = await this.rasterize(svg, widthPx, heightPx)
    const base = Texture.from(canvas)

    return measured.map(({ code, rect }) => {
      // Whole pixels, expanded outward, so no glyph is clipped at its edge.
      const x = Math.max(0, Math.floor(rect.left - box.left))
      const y = Math.max(0, Math.floor(rect.top - box.top))
      const w = Math.min(widthPx - x, Math.ceil(rect.width) + 1)
      const h = Math.min(heightPx - y, Math.ceil(rect.height) + 1)
      return {
        code,
        // Centre-relative, matching the sprite anchor the stage uses.
        x: x + w / 2 - widthPx / 2,
        y: y + h / 2 - heightPx / 2,
        width: w,
        height: h,
        texture: new Texture({ source: base.source, frame: new Rectangle(x, y, w, h) }),
      }
    })
  }

  /** Offscreen element used only for measuring; never visible. */
  private measureHost(): HTMLDivElement {
    if (!this.host) {
      this.host = document.createElement('div')
      this.host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden'
      document.body.appendChild(this.host)
    }
    return this.host
  }
  private host: HTMLDivElement | null = null

  async getTexture(tex: string, color: string, fontSize: number): Promise<Texture> {
    const { svg, widthPx, heightPx } = this.buildSvg(tex, color, fontSize)
    return Texture.from(await this.rasterize(svg, widthPx, heightPx))
  }

  private buildSvg(
    tex: string,
    color: string,
    fontSize: number,
  ): { svg: string; widthPx: number; heightPx: number } {
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
    return { svg, widthPx, heightPx }
  }

  private async rasterize(svg: string, widthPx: number, heightPx: number): Promise<HTMLCanvasElement> {
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
      return canvas
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}
