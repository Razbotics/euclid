/**
 * Contact sheets and full-res stills, captured through the real export surface.
 *
 * Deliberately **not** a second renderer. It drives the same
 * `window.__euclid.renderFrame` that `render.ts` drives, on the same page, so a
 * preview frame is not an approximation of the export — it *is* the export, one
 * frame of it. That property is the only reason a preview is worth trusting,
 * and it is worth more than any speed-up that would trade it away.
 *
 * Frames are composed into the grid **inside the page**, so a twelve-tile sheet
 * costs one image transfer instead of twelve. `render.ts`'s per-frame
 * `screenshot()` round-trip is the slow part of the existing capture path (and
 * what plans/003's WebCodecs move is meant to remove); a contact sheet does not
 * need it at all, because the browser can draw the canvas into a grid itself.
 */
import { chromium, type Browser, type Page } from 'playwright'
import type { EuclidDoc } from '@euclid/dsl'

export interface SheetTile {
  t: number
  label: string
}

export interface SheetOptions {
  columns?: number
  /** Width of one tile in the sheet. Height follows the canvas aspect. */
  tileWidth?: number
}

const RENDER_PAGE_URL = process.env.RENDER_PAGE_URL ?? 'http://localhost:5173/render.html'
const LABEL_H = 26

/**
 * Holds a warm browser across captures.
 *
 * Launching Chromium and re-parsing the document costs more than the frames do,
 * so a preview that pays it per call is a preview nobody calls twice.
 */
export class PreviewCapturer {
  private browser?: Browser
  private page?: Page
  private loadedDocId?: string
  private loadedVersion?: string

  async open(): Promise<void> {
    if (this.browser) return
    this.browser = await chromium.launch()
    this.page = await this.browser.newPage({ viewport: { width: 1920, height: 1080 } })
    this.page.on('pageerror', (e) => console.error('[preview:pageerror]', e.message))
    await this.page.goto(RENDER_PAGE_URL, { waitUntil: 'networkidle' })
  }

  async close(): Promise<void> {
    await this.browser?.close()
    this.browser = undefined
    this.page = undefined
    this.loadedDocId = undefined
  }

  /**
   * Load a document, unless the page already holds this exact one.
   *
   * Keyed on a content hash rather than the id alone: an agent previews the
   * *same* project repeatedly while editing it, and reloading a document that
   * has not changed is the difference between a preview that feels free and
   * one that does not.
   *
   * It must be a hash and not the JSON *length*, which is what this was. Any
   * edit that preserves the length was then invisible to the preview and the
   * agent got the previous frame back: moving a node from (960,540) to
   * (200,200), recolouring #ffffff to #000000, swapping a tex string for one
   * the same size, changing a duration from 6 to 8. Serving a stale frame is
   * the worst thing this path can do — it is the one surface an agent trusts
   * over its own reasoning.
   */
  private async load(doc: EuclidDoc): Promise<{ width: number; height: number }> {
    const page = this.page!
    const version = fingerprint(JSON.stringify(doc))
    if (this.loadedDocId !== doc.id || this.loadedVersion !== version) {
      await page.setViewportSize({ width: doc.canvas.width, height: doc.canvas.height })
      await page.evaluate((d) => window.__euclid.load(d), doc as unknown)
      this.loadedDocId = doc.id
      this.loadedVersion = version
    }
    return { width: doc.canvas.width, height: doc.canvas.height }
  }

  /**
   * One labeled contact sheet.
   *
   * `ink` is the lit fraction of each tile, in tile order. It exists because a
   * capture failure and a correct render of a dark frame produce the same
   * thing — a valid PNG of the right size — and the difference has to be
   * reportable rather than left for someone to notice by eye.
   */
  async sheet(
    doc: EuclidDoc,
    tiles: SheetTile[],
    options: SheetOptions = {},
  ): Promise<{ png: Buffer; ink: number[] }> {
    if (tiles.length === 0) throw new Error('no times to capture')
    await this.open()
    const page = this.page!
    const { width, height } = await this.load(doc)

    const columns = Math.max(1, Math.min(options.columns ?? 4, tiles.length))
    const tileW = options.tileWidth ?? 480
    const tileH = Math.round((tileW * height) / width)
    const rows = Math.ceil(tiles.length / columns)

    await page.evaluate(
      ({ columns, tileW, tileH, rows, labelH }) => {
        const c = document.createElement('canvas')
        c.id = 'euclid-sheet'
        c.width = columns * tileW
        c.height = rows * (tileH + labelH)
        document.body.appendChild(c)
        const g = c.getContext('2d')!
        g.fillStyle = '#000000'
        g.fillRect(0, 0, c.width, c.height)
        ;(window as any).__sheet = { canvas: c, g, columns, tileW, tileH, labelH, ink: [] }
      },
      { columns, tileW, tileH, rows, labelH: LABEL_H },
    )

    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]!
      await page.evaluate(
        // Rendering and copying MUST happen in one call.
        //
        // Pixi creates its WebGL context without `preserveDrawingBuffer`, so
        // the drawing buffer is cleared as soon as the frame composites.
        // Copying from a *second* evaluate is a later task, by which time the
        // buffer may be empty — which produced silently black tiles, several
        // per sheet, apparently at random. `page.screenshot()` never hits this
        // because it captures through the compositor rather than reading the
        // canvas. Here the copy runs in the microtask continuation of
        // renderFrame's own promise, before any paint can intervene.
        async ({ index, label, t }) => {
          // The same call the exporter makes; it awaits pending LaTeX textures
          // internally, so a tile can never catch a half-loaded equation.
          await window.__euclid.renderFrame(t)
          const s = (window as any).__sheet
          const src = document.getElementById('euclid-canvas') as HTMLCanvasElement
          const col = index % s.columns
          const row = Math.floor(index / s.columns)
          const x = col * s.tileW
          const y = row * (s.tileH + s.labelH)
          s.g.drawImage(src, x, y, s.tileW, s.tileH)

          // How much of this tile is actually lit, measured here because this
          // is the only place the pixels exist — a PNG cannot be asked the
          // question cheaply, since row filtering turns flat regions into zero
          // bytes and makes a busy frame look emptier than a blank one.
          //
          // Measured BEFORE the tile is decorated. The hairline below is drawn
          // inside the tile rect and is far brighter than the threshold, so
          // measuring afterwards added a constant ~1.2% to every tile — enough
          // that a genuinely blank frame scored 1.15% against a 0.02% blank
          // threshold, and the capture-fault guard in preview_frames could
          // never fire. The guard was there to catch exactly the black-tile
          // bug the comment above describes.
          const px = s.g.getImageData(x, y, s.tileW, s.tileH).data
          let lit = 0
          for (let p = 0; p < px.length; p += 4) {
            // Rec. 601 luma, cheap integer form. The canvas background sits
            // around 20, so the threshold counts marks rather than backdrop.
            if ((px[p] * 299 + px[p + 1] * 587 + px[p + 2] * 114) / 1000 > 24) lit++
          }
          s.ink.push(lit / (s.tileW * s.tileH))

          // A hairline keeps adjacent dark tiles from reading as one image.
          s.g.strokeStyle = '#2a3038'
          s.g.lineWidth = 1
          s.g.strokeRect(x + 0.5, y + 0.5, s.tileW - 1, s.tileH - 1)
          s.g.fillStyle = '#12161b'
          s.g.fillRect(x, y + s.tileH, s.tileW, s.labelH)
          s.g.fillStyle = '#e6edf3'
          s.g.font = '15px ui-monospace, Menlo, monospace'
          s.g.textBaseline = 'middle'
          let text = label
          while (s.g.measureText(text).width > s.tileW - 16 && text.length > 4) {
            text = text.slice(0, -2) + '…'
          }
          s.g.fillText(text, x + 8, y + s.tileH + s.labelH / 2)
        },
        { index: i, label: `[${i}] ${tile.t.toFixed(2)}s  ${tile.label}`, t: tile.t },
      )
    }

    const { dataUrl, ink } = await page.evaluate(() => {
      const s = (window as any).__sheet
      return { dataUrl: (s.canvas as HTMLCanvasElement).toDataURL('image/png'), ink: s.ink as number[] }
    })
    await page.evaluate(() => {
      document.getElementById('euclid-sheet')?.remove()
      delete (window as any).__sheet
    })
    return { png: Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'), ink }
  }

  /** One frame at full canvas resolution, for drilling into a suspicious tile. */
  async frame(doc: EuclidDoc, t: number): Promise<Buffer> {
    await this.open()
    const page = this.page!
    await this.load(doc)
    await page.evaluate((tt) => window.__euclid.renderFrame(tt), t)
    return page.locator('#euclid-canvas').screenshot({ type: 'png' })
  }
}

/**
 * djb2 over the serialized document, paired with its length. Cheap next to the
 * `JSON.stringify` that produced the string — which was being paid anyway, and
 * then thrown away in favour of one number off it.
 */
function fingerprint(json: string): string {
  let h = 5381
  for (let i = 0; i < json.length; i++) h = ((h << 5) + h + json.charCodeAt(i)) | 0
  return `${json.length}:${(h >>> 0).toString(36)}`
}
