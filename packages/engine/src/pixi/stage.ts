import { Container, Graphics, Sprite, Text, Texture, type Renderer } from 'pixi.js'
import {
  cellCenter,
  cellsInRange,
  globalToScene,
  gridOf,
  gridSize,
  rangeBounds,
  type Canvas,
  type CellRange,
  type Color,
  type EuclidDoc,
  type GridSpec,
  type LatexNode,
  type Axes3dNode,
  type MatrixNode,
  type Points3Node,
  type TokensNode,
  type Vec2,
  type Vec3,
  type Vector3Node,
} from '@euclid/dsl'
import { pathAtProgress } from '../path'
import { staggerAlphas } from '../stagger'
import {
  lerpColor,
  resolveScene,
  type ResolvedCamera,
  type ResolvedNode,
} from '../sampler'
import { project3, type Camera3, type Projected } from '../project'
import {
  findGlyphRun,
  glyphBounds,
  matchByKey,
  matchGlyphs,
  morphGlyphs,
  writeGlyphAlphas,
  type GlyphBounds,
  type GlyphMatch,
  type TexGlyph,
} from '../texmorph'

/**
 * Renders LaTeX source to a Pixi Texture. Implementations:
 *  - web/render page: MathJax tex→svg→texture (see apps/web/src/tex.ts)
 *  - fallback: monospace source text (below), so the engine works with zero setup
 * Must be deterministic for a given (tex, color, fontSize).
 */
export interface TexProvider {
  getTexture(tex: string, color: Color, fontSize: number): Promise<Texture>
  /**
   * Optional: the same equation broken into positioned glyphs, which enables
   * matched-glyph morphing. Providers that can't do it are still correct —
   * the stage falls back to cross-fading whole equations.
   */
  getGlyphs?(tex: string, color: Color, fontSize: number): Promise<TexGlyphRender[]>
}

/** How far `spotlight` fades the glyphs it is not emphasising. */
const SPOTLIGHT_DIM = 0.78

/** A glyph with the texture to draw it with. Geometry is centre-relative px. */
export interface TexGlyphRender extends TexGlyph {
  texture: Texture
}

/** One pooled sprite to draw this frame — a glyph, or a matrix cell. */
interface SpriteEntry {
  texture: Texture
  x: number
  y: number
  scale: number
  alpha: number
}

/**
 * A matrix cell as the glyph machinery sees it: `code` is its contents, so
 * `matchByKey` pairs cells that say the same thing and `morphGlyphs` moves them
 * to their new places. Empty cells are dropped — an empty cell has no identity
 * to match on — but `index` keeps the row-major position, which is what
 * addressing and the reveal order are expressed in.
 */
interface CellItem extends TexGlyph {
  index: number
}

function cellItems(cells: string[][], cellWidth: number, cellHeight: number): CellItem[] {
  const spec: GridSpec = {
    rows: cells.length,
    cols: cells[0]?.length ?? 0,
    cellWidth,
    cellHeight,
  }
  const out: CellItem[] = []
  for (let i = 0; i < spec.rows; i++) {
    for (let j = 0; j < spec.cols; j++) {
      const content = cells[i]![j]!
      if (content === '') continue
      const at = cellCenter(spec, i, j)
      out.push({
        code: content,
        index: i * spec.cols + j,
        x: at.x,
        y: at.y,
        width: cellWidth,
        height: cellHeight,
      })
    }
  }
  return out
}

/** Cache key for a grid's contents — matching is O(n·m) and the pair is stable. */
function cellKey(cells: string[][]): string {
  return cells.map((r) => r.join('')).join('')
}

const lerp = (a: number, b: number, u: number): number => a + (b - a) * u

const add3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
const lerp3 = (a: Vec3, b: Vec3, u: number): Vec3 => ({
  x: lerp(a.x, b.x, u),
  y: lerp(a.y, b.y, u),
  z: lerp(a.z, b.z, u),
})

/** Node types whose geometry spans depth and is projected vertex by vertex. */
function isSpatialType(type: string): boolean {
  return type === 'vector3' || type === 'axes3d' || type === 'points3'
}

/**
 * One arrow between two points in space.
 *
 * Both ends are projected independently — that is the whole point — and the
 * cues ride the result: stroke width and head size follow the mean perspective
 * scale, and the alpha follows the mean dim, so an arrow pointing away from
 * the camera is visibly thinner and fainter at its far end.
 */
function drawArrow(
  g: Graphics,
  cam: Camera3,
  from: Vec3,
  to: Vec3,
  color: string,
  width: number,
  head: number,
  alphaMul: number,
): void {
  const a = project3(from, cam)
  const b = project3(to, cam)
  if (!a || !b) return
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  const alpha = ((a.dim + b.dim) / 2) * alphaMul
  const w = Math.max(0.5, width * ((a.scale + b.scale) / 2))

  // Pointing (almost) straight at the camera. The shaft has no length to draw
  // and the head has no direction to point, but the arrow is still there — an
  // axis that silently vanishes at one angle reads as a bug, and a cone seen
  // end-on is a disc.
  if (len < Math.max(1, w)) {
    if (head > 0) g.circle(b.x, b.y, Math.max(w, head * b.scale * 0.35)).fill({ color, alpha })
    return
  }

  const headLen = Math.min(head * b.scale, len * 0.9)
  const ux = dx / len
  const uy = dy / len
  // The shaft stops short of the tip so it does not show through the head.
  const endX = b.x - ux * headLen
  const endY = b.y - uy * headLen
  g.moveTo(a.x, a.y).lineTo(endX, endY).stroke({ width: w, color, alpha })
  if (headLen > 0) {
    const halfW = headLen * 0.45
    g.moveTo(b.x, b.y)
      .lineTo(endX - uy * halfW, endY + ux * halfW)
      .lineTo(endX + uy * halfW, endY - ux * halfW)
      .closePath()
      .fill({ color, alpha })
  }
}

/** Renders the raw TeX source as monospace text — placeholder until a real provider is wired. */
export class FallbackTexProvider implements TexProvider {
  constructor(private renderer: Renderer) {}
  async getTexture(tex: string, color: Color, fontSize: number): Promise<Texture> {
    const text = new Text({
      text: tex,
      style: { fontFamily: 'monospace', fontSize, fill: color },
    })
    const texture = this.renderer.generateTexture(text)
    text.destroy()
    return texture
  }
}

interface Item {
  /** JSON of the node minus animation data — when it changes, the item is rebuilt. */
  staticKey: string
  view: Container
  content: Container
  mask: Graphics | null
  /** latex only: crossfade pair, used when glyph data isn't available */
  fromSprite?: Sprite
  toSprite?: Sprite
  /** latex/matrix: sprite pool for glyphs or cells, reused across frames */
  glyphSprites?: Sprite[]
  glyphLayer?: Container
  /** matrix only: the delimiters, sized to the grid */
  brackets?: Graphics
  /** tokens only: the boxes, and one pooled Text per label */
  boxes?: Graphics
  labelTexts?: Text[]
  /** emphasis marker, drawn behind the node's content */
  highlight?: Graphics
  /** true when a write is being drawn per-glyph, so applyWrite skips its mask */
  glyphWrite?: boolean
  /** true when color/spotlight emphasis was drawn per-glyph this frame */
  glyphEmphasis?: boolean
}

/**
 * Stateless with respect to time: update(doc, t) is a pure projection of the
 * document at t onto the Pixi scene graph. Display objects are cached per node
 * id and rebuilt only when a node's static shape changes.
 */
export class EuclidStage {
  private bg = new Graphics()
  private layer = new Container()
  private items = new Map<string, Item>()
  private texCache = new Map<string, Texture | 'pending'>()
  private glyphCache = new Map<string, TexGlyphRender[] | 'pending'>()
  /** Matching is O(n·m); the pair is stable for a morph, so compute it once. */
  private matchCache = new Map<string, GlyphMatch>()
  private pendingTex = new Set<Promise<unknown>>()
  private currentSceneId: string | null = null
  /** The 3D half of the camera while a spatial scene is being drawn; null when flat. */
  private cam3: Camera3 | null = null
  private texProvider: TexProvider | null

  constructor(
    private root: Container,
    opts?: { texProvider?: TexProvider },
  ) {
    this.texProvider = opts?.texProvider ?? null
    root.addChild(this.bg)
    root.addChild(this.layer)
  }

  setTexProvider(p: TexProvider): void {
    this.texProvider = p
    this.texCache.clear()
    this.glyphCache.clear()
    this.matchCache.clear()
    this.teardown()
  }

  update(doc: EuclidDoc, tGlobal: number): void {
    const at = globalToScene(doc, tGlobal)
    if (!at) {
      this.teardown()
      this.bg.clear()
      return
    }
    if (at.scene.id !== this.currentSceneId) {
      this.teardown()
      this.currentSceneId = at.scene.id
    }

    // The background is drawn outside the camera layer on purpose: it fills the
    // frame rather than sitting in the scene, so zooming out reveals more
    // diagram rather than the edge of the backdrop.
    this.bg.clear()
    this.bg.rect(0, 0, doc.canvas.width, doc.canvas.height).fill(at.scene.background)

    const resolved = resolveScene(at.scene, at.localT, doc.canvas)
    this.applyCamera(resolved.camera, doc.canvas)
    this.cam3 = resolved.cam3
    const seen = new Set<string>()
    this.syncChildren(resolved.nodes, this.layer, seen, resolved.spatial)

    for (const [id, item] of this.items) {
      if (!seen.has(id)) {
        item.view.destroy({ children: true })
        this.items.delete(id)
      }
    }
  }

  /**
   * The camera is one transform on the whole node layer, not a projection step:
   * Pixi composes `position ∘ rotate ∘ scale ∘ (−pivot)`, which is exactly
   * `centre + R(−roll)·zoom·(p − camera.position)`. Nothing downstream knows a
   * camera exists — node coordinates, glyph geometry and highlight bounds are
   * all still scene-local, so preview and export cannot disagree about framing
   * any more than they can about anything else.
   */
  private applyCamera(camera: ResolvedCamera | null, canvas: Canvas): void {
    if (!camera) {
      // Reset rather than skip: scenes are switched inside one stage, and a
      // camera-less scene after a zoomed one must not inherit the zoom.
      this.layer.position.set(0, 0)
      this.layer.pivot.set(0, 0)
      this.layer.scale.set(1)
      this.layer.rotation = 0
      return
    }
    this.layer.pivot.set(camera.position.x, camera.position.y)
    this.layer.position.set(canvas.width / 2, canvas.height / 2)
    this.layer.scale.set(camera.zoom)
    // Negated: rolling the camera one way turns the scene the other.
    this.layer.rotation = -camera.rotation
  }

  private teardown(): void {
    for (const item of this.items.values()) item.view.destroy({ children: true })
    this.items.clear()
    this.layer.removeChildren()
    this.currentSceneId = null
  }

  private syncChildren(
    resolved: ResolvedNode[],
    parent: Container,
    seen: Set<string>,
    projected = false,
  ): void {
    // Painter's algorithm: furthest first, so nearer things cover them. The
    // sort is stable and a node without a depth counts as sitting on the z=0
    // plane, so a flat label keeps its document order among its peers instead
    // of jumping to one end.
    const order = projected
      ? resolved
          .map((res, i) => ({ res, i }))
          .sort((a, b) => (a.res.projection?.depth ?? 0) - (b.res.projection?.depth ?? 0) || a.i - b.i)
          .map((x) => x.res)
      : resolved
    order.forEach((res, zIndex) => {
      const item = this.syncNode(res, parent, seen, projected)
      parent.setChildIndex(item.view, Math.min(zIndex, parent.children.length - 1))
      if (res.source.type === 'group') {
        // Groups are drawn flat: their children inherit the group's 2D
        // transform, and projecting inside one would apply the camera twice.
        // Spatial nodes belong at the scene root.
        this.syncChildren(res.children, item.content, seen)
        this.applyGroupStagger(res)
      }
    })
  }

  /**
   * `write` on a group reveals its children one after another — the same
   * stagger an equation uses for its glyphs and a matrix for its cells, with
   * child order as the sequence.
   *
   * Applied after the children are synced, because each child sets its own
   * alpha from its resolved `opacity` when it syncs; this multiplies into that
   * rather than replacing it, so a child that is half-transparent by design
   * stays half-transparent as it arrives.
   */
  private applyGroupStagger(res: ResolvedNode): void {
    const wp = res.writeProgress
    if (wp === null || wp >= 1 || res.children.length === 0) return
    const alphas = staggerAlphas(res.children.length, wp)
    res.children.forEach((child, i) => {
      const item = this.items.get(child.source.id)
      if (item) item.view.alpha *= alphas[i]!
    })
  }

  private syncNode(
    res: ResolvedNode,
    parent: Container,
    seen: Set<string>,
    projected = false,
  ): Item {
    const node = res.source
    seen.add(node.id)
    const staticKey = computeStaticKey(node)

    let item = this.items.get(node.id)
    if (item && item.staticKey !== staticKey) {
      item.view.destroy({ children: true })
      this.items.delete(node.id)
      item = undefined
    }
    if (!item) {
      item = this.createItem(node, staticKey)
      this.items.set(node.id, item)
    }
    if (item.view.parent !== parent) parent.addChild(item.view)

    const p = res.props
    const pos = p.position as Vec2
    const proj = res.projection
    const spatialGeometry = isSpatialType(res.source.type)
    if (spatialGeometry) {
      // Its vertices are already in projected scene space — see updateSpatial —
      // so the view itself must add nothing, or the camera applies twice.
      item.view.position.set(0, 0)
      item.view.scale.set(1)
      item.view.rotation = 0
      item.view.alpha = p.opacity as number
    } else if (projected && proj) {
      // Two of the three depth cues live here: nearer draws larger, further
      // draws dimmer. The third is the sort order above. Without them a
      // projection reads as flat overlapping lines.
      item.view.position.set(proj.x, proj.y)
      item.view.scale.set((p.scale as number) * proj.scale)
      item.view.rotation = p.rotation as number
      item.view.alpha = (p.opacity as number) * proj.dim
    } else {
      item.view.position.set(pos.x, pos.y)
      item.view.scale.set(p.scale as number)
      item.view.rotation = p.rotation as number
      item.view.alpha = p.opacity as number
    }

    this.updateContent(item, res)
    this.updateHighlight(item, res)
    this.applyWrite(item, res)
    // Last word, because applyWrite turns nodes back on: a node at or behind
    // the camera has no projection and must not be drawn at all.
    if (projected && !proj && !spatialGeometry) item.view.visible = false
    return item
  }

  /**
   * Mark a node, or one term inside an equation, while the narration talks
   * about it. The term is found by glyph codes rather than coordinates —
   * see findGlyphRun — because the agent knows it means `\frac{b}{a}` but has
   * no way to know where that lands on screen.
   */
  private updateHighlight(item: Item, res: ResolvedNode): void {
    const hl = res.highlight
    if (!hl || hl.strength <= 0) {
      if (item.highlight) item.highlight.visible = false
      return
    }
    // `color`/`spotlight` are drawn by the glyph path; a marker on top would
    // be saying the same thing twice. They fall through to a box only when
    // the glyph path declined (no tex, not latex, fragment not found).
    if ((hl.style === 'color' || hl.style === 'spotlight') && item.glyphEmphasis) {
      if (item.highlight) item.highlight.visible = false
      return
    }

    if (!item.highlight) {
      item.highlight = new Graphics()
      // Behind the content, so a box reads as a marker rather than a veil.
      item.content.addChildAt(item.highlight, 0)
    }
    const g = item.highlight
    g.visible = true
    g.clear()

    const bounds = this.highlightBounds(item, res, hl.tex, hl.cells)
    if (!bounds) {
      g.visible = false
      return
    }

    const pad = Math.max(6, bounds.height * 0.15)
    if (hl.style === 'underline') {
      const thickness = Math.max(3, bounds.height * 0.07)
      g.rect(
        bounds.x - bounds.width / 2 - pad / 2,
        bounds.y + bounds.height / 2 + pad,
        bounds.width + pad,
        thickness,
      ).fill({ color: hl.color, alpha: hl.strength })
    } else {
      g.roundRect(
        bounds.x - bounds.width / 2 - pad,
        bounds.y - bounds.height / 2 - pad,
        bounds.width + pad * 2,
        bounds.height + pad * 2,
        pad * 0.6,
      ).fill({ color: hl.color, alpha: hl.strength * 0.25 })
      g.stroke({ width: 2, color: hl.color, alpha: hl.strength })
    }
  }

  /** Glyph-run bounds for a targeted term, cell bounds for a range, else the node's own. */
  private highlightBounds(
    item: Item,
    res: ResolvedNode,
    tex?: string,
    cells?: CellRange,
  ): GlyphBounds | null {
    const node = res.source
    if (cells && (node.type === 'matrix' || node.type === 'tokens')) {
      // Straight from the grid: no measurement, so a box around row 2 is exact
      // whether or not the cells have finished rasterizing. The grid is the
      // *resolved* one — a matrix that has morphed is the shape it morphed to.
      const spec =
        node.type === 'matrix' && res.cellMorph
          ? {
              rows: res.cellMorph.toCells.length,
              cols: res.cellMorph.toCells[0]!.length,
              cellWidth: node.cellWidth,
              cellHeight: node.cellHeight,
            }
          : gridOf(node)
      const b = rangeBounds(spec, cells)
      if (b) return b
    }
    if (tex && node.type === 'latex' && this.texProvider?.getGlyphs) {
      const color = res.props.color as string
      const fontSize = res.props.fontSize as number
      const morph = res.texMorph
      const shown = morph ? (morph.progress >= 1 ? morph.toTex : morph.fromTex) : node.tex
      const glyphs = this.requestGlyphs(shown, color, fontSize)
      const fragment = this.requestGlyphs(tex, color, fontSize)
      if (!glyphs || !fragment) return null // still rasterizing
      const run = findGlyphRun(glyphs, fragment.map((f) => f.code))
      // No match means the fragment isn't in this equation; fall through to
      // the whole node rather than silently drawing nothing.
      if (run) return glyphBounds(glyphs, run[0], run[1])
    }
    const b = item.content.getLocalBounds()
    if (b.width <= 0 || b.height <= 0) return null
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, width: b.width, height: b.height }
  }

  private createItem(node: ResolvedNode['source'], staticKey: string): Item {
    const view = new Container()
    view.label = node.id
    let content: Container
    switch (node.type) {
      case 'rect':
      case 'circle':
      case 'line':
      case 'path':
      case 'vector3':
      case 'axes3d':
      case 'points3':
        content = new Graphics()
        break
      case 'text': {
        const t = new Text({
          text: node.text,
          style: { fontFamily: node.fontFamily, fontSize: node.fontSize, fill: node.fill },
        })
        t.anchor.set(0.5)
        content = t
        break
      }
      case 'latex':
      case 'matrix':
      case 'tokens':
      case 'group':
        content = new Container()
        break
    }
    view.addChild(content)
    return { staticKey, view, content, mask: null }
  }

  private updateContent(item: Item, res: ResolvedNode): void {
    const node = res.source
    const p = res.props
    switch (node.type) {
      case 'rect': {
        const g = item.content as Graphics
        g.clear()
        const w = p.width as number
        const h = p.height as number
        g.roundRect(-w / 2, -h / 2, w, h, node.cornerRadius)
        // No fill means an outline, not a hole: filling with the background
        // colour would occlude anything behind it and break on a non-flat
        // background, which is what callers were forced to do before.
        if (p.fill) g.fill(p.fill as string)
        if (node.stroke) g.stroke({ width: p.strokeWidth as number, color: p.stroke as string })
        return
      }
      case 'circle': {
        const g = item.content as Graphics
        g.clear()
        g.circle(0, 0, p.radius as number)
        if (p.fill) g.fill(p.fill as string)
        if (node.stroke) g.stroke({ width: p.strokeWidth as number, color: p.stroke as string })
        return
      }
      case 'line': {
        const g = item.content as Graphics
        g.clear()
        g.moveTo(node.from.x, node.from.y)
          .lineTo(node.to.x, node.to.y)
          .stroke({ width: p.strokeWidth as number, color: p.stroke as string })
        return
      }
      case 'path': {
        const g = item.content as Graphics
        g.clear()
        // Write-on is expressed as geometry rather than a mask: only the drawn
        // prefix exists, so the reveal follows the curve instead of a sweeping
        // edge. `applyWrite` leaves path nodes alone for exactly this reason.
        const drawn =
          res.writeProgress === null
            ? node.points
            : pathAtProgress(node.points, node.closed, res.writeProgress)
        if (drawn.length < 2) return
        g.moveTo(drawn[0]!.x, drawn[0]!.y)
        for (let i = 1; i < drawn.length; i++) g.lineTo(drawn[i]!.x, drawn[i]!.y)
        // A partially drawn shape is an open curve, so it must not be closed
        // or filled until it is whole — otherwise the fill grows as a wedge.
        const whole = res.writeProgress === null || res.writeProgress >= 1
        if (node.closed && whole) g.closePath()
        if (node.fill && whole) g.fill(node.fill)
        g.stroke({ width: p.strokeWidth as number, color: p.stroke as string })
        return
      }
      case 'text': {
        const t = item.content as Text
        t.style.fill = p.fill as string
        t.style.fontSize = p.fontSize as number
        return
      }
      case 'latex':
        this.updateLatex(item, res, node)
        return
      case 'matrix':
        this.updateMatrix(item, res, node)
        return
      case 'tokens':
        this.updateTokens(item, res, node)
        return
      case 'vector3':
      case 'axes3d':
      case 'points3':
        // Geometry that spans depth projects its own vertices — see
        // updateSpatial. Nothing to do when the scene is flat, because a
        // spatial node without a camera to project through has no position.
        if (this.cam3) this.updateSpatial(item, res, node, this.cam3)
        else (item.content as Graphics).clear()
        return
      case 'group':
        // A write on a group arrives child by child (applied once the children
        // exist, in syncChildren). Flagged here so applyWrite leaves its mask
        // alone — a mask would sweep an edge across the whole group and undo
        // the point of revealing its parts in turn.
        item.glyphWrite = res.writeProgress !== null
        return
    }
  }

  private updateLatex(item: Item, res: ResolvedNode, node: LatexNode): void {
    const color = res.props.color as string
    const fontSize = res.props.fontSize as number
    const morph = res.texMorph

    const fromTex = morph ? morph.fromTex : node.tex
    const toTex = morph ? morph.toTex : node.tex
    const progress = morph ? morph.progress : 0

    if (!item.fromSprite) {
      item.fromSprite = new Sprite()
      item.fromSprite.anchor.set(0.5)
      item.content.addChild(item.fromSprite)
    }
    if (!item.toSprite) {
      item.toSprite = new Sprite()
      item.toSprite.anchor.set(0.5)
      item.content.addChild(item.toSprite)
    }

    // Matched-glyph morphing when the provider can break the equation into
    // glyphs and both sides are already rasterized; otherwise the original
    // cross-fade, which is always correct if less pretty.
    if (toTex !== fromTex && this.texProvider?.getGlyphs) {
      const from = this.requestGlyphs(fromTex, color, fontSize)
      const to = this.requestGlyphs(toTex, color, fontSize)
      if (from && to && from.length > 0 && to.length > 0) {
        this.updateGlyphMorph(item, from, to, progress, `${fromTex}→${toTex} ${color} ${fontSize}`)
        return
      }
    }

    // A write in progress reveals glyph by glyph when glyph data exists.
    // applyWrite skips its mask in that case (see item.glyphWrite).
    const wp = res.writeProgress
    item.glyphWrite = false
    item.glyphEmphasis = false
    if (toTex === fromTex && wp !== null && wp > 0 && wp < 1 && this.texProvider?.getGlyphs) {
      const glyphs = this.requestGlyphs(fromTex, color, fontSize)
      if (glyphs && glyphs.length > 0) {
        item.glyphWrite = true
        this.updateGlyphWrite(item, glyphs, wp)
        return
      }
    }

    // `color` and `spotlight` act on the type itself rather than drawing a
    // marker around it, so the equation has to be rendered per glyph.
    const hl = res.highlight
    if (
      hl &&
      hl.strength > 0 &&
      (hl.style === 'color' || hl.style === 'spotlight') &&
      hl.tex &&
      toTex === fromTex &&
      this.texProvider?.getGlyphs
    ) {
      const glyphs = this.requestGlyphs(fromTex, color, fontSize)
      const fragment = this.requestGlyphs(hl.tex, color, fontSize)
      // The recoloured set is the same equation rasterized in the highlight
      // colour: identical geometry, different ink. Tinting would be cheaper
      // but multiplies, so it can only ever darken a non-white equation.
      const inked = hl.style === 'color' ? this.requestGlyphs(fromTex, hl.color, fontSize) : []
      if (glyphs && fragment && inked && glyphs.length > 0) {
        const run = findGlyphRun(glyphs, fragment.map((f) => f.code))
        if (run) {
          item.glyphEmphasis = true
          this.updateGlyphEmphasis(item, glyphs, inked, run, hl.style, hl.strength)
          return
        }
      }
    }

    if (item.glyphLayer) item.glyphLayer.visible = false
    item.fromSprite.visible = true
    this.assignTexTexture(item.fromSprite, fromTex, color, fontSize)
    if (toTex !== fromTex) {
      this.assignTexTexture(item.toSprite, toTex, color, fontSize)
      item.fromSprite.alpha = 1 - progress
      item.toSprite.alpha = progress
      item.toSprite.visible = true
    } else {
      item.fromSprite.alpha = 1
      item.toSprite.visible = false
    }
  }

  /**
   * Draw one sprite per glyph from `morphGlyphs`. Sprites are pooled per node
   * and reused frame to frame — a matched glyph keeps the same sprite, which
   * is what makes an unchanged term look genuinely still rather than
   * re-drawn.
   */
  private updateGlyphMorph(
    item: Item,
    from: TexGlyphRender[],
    to: TexGlyphRender[],
    progress: number,
    matchKey: string,
  ): void {
    if (item.fromSprite) item.fromSprite.visible = false
    if (item.toSprite) item.toSprite.visible = false

    let match = this.matchCache.get(matchKey)
    if (!match) {
      match = matchGlyphs(from, to)
      this.matchCache.set(matchKey, match)
    }

    const drawn = morphGlyphs(from, to, match, progress)
    this.drawGlyphs(
      item,
      drawn.map((g) => ({
        texture: (g.source === 'from' ? from[g.index]! : to[g.index]!).texture,
        x: g.x,
        y: g.y,
        scale: g.scale,
        alpha: g.alpha,
      })),
    )
  }

  /**
   * Reveal an equation symbol by symbol instead of sweeping one mask edge
   * across it — see writeGlyphAlphas. Only used while a write is in progress;
   * once complete the whole-equation sprite takes over, which draws the same
   * pixels since the glyphs are frames of that same rasterization.
   */
  private updateGlyphWrite(item: Item, glyphs: TexGlyphRender[], progress: number): void {
    if (item.fromSprite) item.fromSprite.visible = false
    if (item.toSprite) item.toSprite.visible = false
    const alphas = writeGlyphAlphas(glyphs.length, progress)
    this.drawGlyphs(
      item,
      glyphs.map((g, i) => ({
        texture: g.texture,
        x: g.x,
        y: g.y,
        scale: 1,
        alpha: alphas[i]!,
      })),
    )
  }

  /**
   * Emphasis that acts on the type rather than around it.
   *
   * `color` cross-fades the targeted glyphs to a recoloured copy, so the term
   * changes ink while everything else holds. `spotlight` fades everything
   * *except* the term, which is the stronger effect on a busy equation
   * because it removes competition instead of adding decoration.
   *
   * Both ride `strength`, so they ramp in and out with the pulse rather than
   * snapping.
   */
  private updateGlyphEmphasis(
    item: Item,
    glyphs: TexGlyphRender[],
    inked: TexGlyphRender[],
    run: [number, number],
    style: 'color' | 'spotlight',
    strength: number,
  ): void {
    if (item.fromSprite) item.fromSprite.visible = false
    if (item.toSprite) item.toSprite.visible = false

    const [start, end] = run
    const entries: { texture: Texture; x: number; y: number; scale: number; alpha: number }[] = []
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i]!
      const targeted = i >= start && i < end
      entries.push({
        texture: g.texture,
        x: g.x,
        y: g.y,
        scale: 1,
        // Dimming the rest never touches the term itself, so the emphasised
        // text stays at full strength rather than the whole thing fading.
        alpha: style === 'spotlight' && !targeted ? 1 - SPOTLIGHT_DIM * strength : 1,
      })
    }
    if (style === 'color') {
      for (let i = start; i < end && i < inked.length; i++) {
        const g = inked[i]!
        entries.push({ texture: g.texture, x: g.x, y: g.y, scale: 1, alpha: strength })
      }
    }
    this.drawGlyphs(item, entries)
  }

  /**
   * A matrix: one sprite per non-empty cell, on a fixed grid.
   *
   * Everything a matrix can do is something the glyph work already does, with
   * cells in place of glyphs — which is why this is short. A reveal is
   * `staggerAlphas` over cells instead of symbols; a restatement is
   * `matchByKey` on cell contents instead of codepoints, fed to the same
   * `morphGlyphs`; emphasis dims or recolours a selected set exactly as
   * `spotlight` and `color` do inside an equation. The generalisations asked
   * for in plans/006 Phase B are those two key functions.
   */
  private updateMatrix(item: Item, res: ResolvedNode, node: MatrixNode): void {
    const color = res.props.color as string
    const fontSize = res.props.fontSize as number
    const morph = res.cellMorph
    const fromCells = morph ? morph.fromCells : node.cells
    const toCells = morph ? morph.toCells : node.cells
    const progress = morph ? morph.progress : 0
    item.glyphEmphasis = false
    item.glyphWrite = false

    const from = cellItems(fromCells, node.cellWidth, node.cellHeight)

    if (fromCells !== toCells) {
      const to = cellItems(toCells, node.cellWidth, node.cellHeight)
      const key = `${cellKey(fromCells)}→${cellKey(toCells)}`
      let match = this.matchCache.get(key)
      if (!match) {
        match = matchByKey(from, to, (c) => c.code)
        this.matchCache.set(key, match)
      }
      // The grid itself grows or shrinks with the morph, so the delimiters
      // travel with it rather than snapping at the end.
      this.drawBrackets(item, node, {
        rows: lerp(fromCells.length, toCells.length, progress),
        cols: lerp(fromCells[0]!.length, toCells[0]!.length, progress),
        cellWidth: node.cellWidth,
        cellHeight: node.cellHeight,
      })
      const entries: SpriteEntry[] = []
      for (const g of morphGlyphs(from, to, match, progress)) {
        const cell = g.source === 'from' ? from[g.index]! : to[g.index]!
        const texture = this.requestTexture(cell.code, color, fontSize)
        if (texture) entries.push({ texture, x: g.x, y: g.y, scale: g.scale, alpha: g.alpha })
      }
      this.drawGlyphs(item, entries)
      return
    }

    // The shape comes from the cells being *drawn*, not from `node.cells`:
    // once a morph has settled, the resolved grid is the morph's target and
    // the node's own cells are the shape it started life with. Reading the
    // node here drew a 2x3 of cells inside 2x2 brackets.
    const spec: GridSpec = {
      rows: fromCells.length,
      cols: fromCells[0]!.length,
      cellWidth: node.cellWidth,
      cellHeight: node.cellHeight,
    }
    this.drawBrackets(item, node, spec)

    // A write reveals cell by cell, in reading order, so `applyWrite` must not
    // also sweep a mask across it — same contract as the glyph reveal.
    const wp = res.writeProgress
    const alphas =
      wp === null || wp >= 1 ? null : staggerAlphas(spec.rows * spec.cols, wp)
    if (alphas) item.glyphWrite = true

    const hl = res.highlight
    const emphasis =
      hl && hl.strength > 0 && hl.cells && (hl.style === 'color' || hl.style === 'spotlight')
        ? hl
        : null
    const targeted = new Set(emphasis ? cellsInRange(spec, emphasis.cells) : [])
    if (emphasis) item.glyphEmphasis = true

    const entries: SpriteEntry[] = []
    for (const cell of from) {
      const texture = this.requestTexture(cell.code, color, fontSize)
      if (!texture) continue
      const dim =
        emphasis?.style === 'spotlight' && !targeted.has(cell.index)
          ? 1 - SPOTLIGHT_DIM * emphasis.strength
          : 1
      entries.push({
        texture,
        x: cell.x,
        y: cell.y,
        scale: 1,
        alpha: (alphas?.[cell.index] ?? 1) * dim,
      })
    }
    if (emphasis?.style === 'color') {
      // The recoloured cell is the same content rasterized in the highlight
      // colour, cross-faded over the original — tinting multiplies, so it
      // could only ever darken.
      for (const cell of from) {
        if (!targeted.has(cell.index)) continue
        const inked = this.requestTexture(cell.code, emphasis.color, fontSize)
        if (!inked) continue
        entries.push({ texture: inked, x: cell.x, y: cell.y, scale: 1, alpha: emphasis.strength })
      }
    }
    this.drawGlyphs(item, entries)
  }

  /** Delimiters sized to the grid, drawn behind the cells. */
  private drawBrackets(item: Item, node: MatrixNode, spec: GridSpec): void {
    if (!item.brackets) {
      item.brackets = new Graphics()
      item.content.addChildAt(item.brackets, 0)
    }
    const g = item.brackets
    g.clear()
    if (node.brackets === 'none') return

    const { width, height } = gridSize(spec)
    const x = width / 2
    const y = height / 2
    const tick = Math.min(node.cellWidth, node.cellHeight) * 0.16
    const w = Math.max(2, node.fontSize * 0.06)
    for (const side of [-1, 1]) {
      const edge = side * x
      if (node.brackets === 'square') {
        // Ticks point INWARD, toward the content: a left bracket is `[`, whose
        // arms reach right. Pointing them outward draws `]` on the left and
        // `[` on the right, which reads as the matrix turned inside out.
        g.moveTo(edge - side * tick, -y)
          .lineTo(edge, -y)
          .lineTo(edge, y)
          .lineTo(edge - side * tick, y)
      } else {
        // A parenthesis bows away from the content; the control point sits
        // outside the edge by the same tick, so both styles read the same size.
        g.moveTo(edge, -y)
          .quadraticCurveTo(edge + side * tick * 2, 0, edge, y)
      }
      g.stroke({ width: w, color: node.color, alpha: 1 })
    }
  }

  /**
   * A token strip: labels in boxes, laid out on the same grid a matrix uses.
   *
   * Text rather than typeset mathematics, so this draws Pixi `Text` instead of
   * rasterized LaTeX — which makes emphasis simpler, not harder: recolouring a
   * token is a fill change, where recolouring a glyph needs a second
   * rasterization to cross-fade against.
   */
  private updateTokens(item: Item, res: ResolvedNode, node: TokensNode): void {
    const color = res.props.color as string
    const fontSize = res.props.fontSize as number
    const spec = gridOf(node)
    item.glyphWrite = false
    item.glyphEmphasis = false

    const wp = res.writeProgress
    const alphas = wp === null || wp >= 1 ? null : staggerAlphas(node.labels.length, wp)
    if (alphas) item.glyphWrite = true

    const hl = res.highlight
    const emphasis =
      hl && hl.strength > 0 && hl.cells && (hl.style === 'color' || hl.style === 'spotlight')
        ? hl
        : null
    const targeted = new Set(emphasis ? cellsInRange(spec, emphasis.cells) : [])
    if (emphasis) item.glyphEmphasis = true

    if (!item.boxes) {
      item.boxes = new Graphics()
      item.content.addChildAt(item.boxes, 0)
    }
    const boxes = item.boxes
    boxes.clear()
    if (!item.labelTexts) item.labelTexts = []
    const pool = item.labelTexts

    const boxW = node.cellWidth * 0.88
    const boxH = node.cellHeight * 0.72
    for (let i = 0; i < node.labels.length; i++) {
      const row = node.orientation === 'row' ? 0 : i
      const col = node.orientation === 'row' ? i : 0
      const at = cellCenter(spec, row, col)
      const dim =
        emphasis?.style === 'spotlight' && !targeted.has(i) ? 1 - SPOTLIGHT_DIM * emphasis.strength : 1
      const alpha = (alphas?.[i] ?? 1) * dim

      if (alpha > 0 && (node.boxFill || node.boxStroke)) {
        boxes.roundRect(at.x - boxW / 2, at.y - boxH / 2, boxW, boxH, Math.min(boxW, boxH) * 0.18)
        if (node.boxFill) boxes.fill({ color: node.boxFill, alpha })
        if (node.boxStroke) {
          boxes.stroke({ width: Math.max(1, fontSize * 0.05), color: node.boxStroke, alpha })
        }
      }

      let text = pool[i]
      if (!text) {
        text = new Text({ text: node.labels[i]!, style: { fontFamily: node.fontFamily, fontSize } })
        text.anchor.set(0.5)
        pool.push(text)
        item.content.addChild(text)
      }
      if (text.text !== node.labels[i]) text.text = node.labels[i]!
      text.style.fontSize = fontSize
      text.style.fill =
        emphasis?.style === 'color' && targeted.has(i)
          ? lerpColor(color, emphasis.color, emphasis.strength)
          : color
      text.position.set(at.x, at.y)
      text.alpha = alpha
      text.visible = alpha > 0
    }
    for (let i = node.labels.length; i < pool.length; i++) pool[i]!.visible = false
  }

  /**
   * Geometry that spans depth: a vector, a coordinate frame, a cloud of points.
   *
   * These project their own **vertices** rather than riding the node-level
   * projection, because an arrow from here to there is not one point with one
   * depth — drawing it that way is exactly the "flat overlapping lines" failure
   * this phase exists to avoid. The view transform is left at identity for
   * them (see syncNode) and everything below is absolute scene space, so the
   * 2D camera still frames it afterwards.
   */
  private updateSpatial(
    item: Item,
    res: ResolvedNode,
    node: Vector3Node | Axes3dNode | Points3Node,
    cam: Camera3,
  ): void {
    const g = item.content as Graphics
    g.clear()
    const p = res.props
    const base = p.position as Vec2
    const anchor: Vec3 = { x: base.x, y: base.y, z: (p.z as number | undefined) ?? 0 }
    const scale = p.scale as number
    // A spatial reveal grows along the geometry rather than sweeping a mask
    // across the frame, the same argument `path` makes for arc length.
    const wp = res.writeProgress
    item.glyphWrite = wp !== null
    const grow = wp === null ? 1 : wp

    switch (node.type) {
      case 'vector3': {
        const from = add3(anchor, node.from)
        const to = add3(anchor, node.to)
        drawArrow(
          g,
          cam,
          from,
          lerp3(from, to, grow),
          p.stroke as string,
          (p.strokeWidth as number) * scale,
          node.headSize * scale * grow,
          1,
        )
        return
      }
      case 'axes3d': {
        const size = node.size * scale
        const width = (p.strokeWidth as number) * scale
        const head = size * 0.12
        const axes: [Vec3, string][] = [
          [{ x: size, y: 0, z: 0 }, node.colorX],
          // `y` grows downward in scene space, so the y axis points *up* the
          // screen when it is drawn negative — which is what anyone reading a
          // graph expects of it.
          [{ x: 0, y: -size, z: 0 }, node.colorY],
          [{ x: 0, y: 0, z: size }, node.colorZ],
        ]
        for (const [dir, color] of axes) {
          if (node.negative) {
            const back = lerp3(anchor, add3(anchor, { x: -dir.x, y: -dir.y, z: -dir.z }), grow)
            drawArrow(g, cam, anchor, back, color, width, 0, 0.35)
          }
          drawArrow(g, cam, anchor, lerp3(anchor, add3(anchor, dir), grow), color, width, head, 1)
        }
        return
      }
      case 'points3': {
        const alphas = wp === null ? null : staggerAlphas(node.points.length, wp)
        const dots = node.points
          .map((pt, i) => ({ at: project3(add3(anchor, pt), cam), a: alphas?.[i] ?? 1 }))
          .filter((d): d is { at: Projected; a: number } => d.at !== null && d.a > 0)
        // Painter's order inside the cloud too, or a near point drawn early
        // sits behind a far one and the whole thing reads as confetti.
        dots.sort((a, b) => a.at.depth - b.at.depth)
        for (const d of dots) {
          g.circle(d.at.x, d.at.y, Math.max(0.5, node.radius * scale * d.at.scale)).fill({
            color: p.fill as string,
            alpha: d.at.dim * d.a,
          })
        }
        return
      }
    }
  }

  /** Shared sprite pool: one sprite per drawn glyph, reused across frames. */
  private drawGlyphs(
    item: Item,
    entries: { texture: Texture; x: number; y: number; scale: number; alpha: number }[],
  ): void {
    if (!item.glyphLayer) {
      item.glyphLayer = new Container()
      item.content.addChild(item.glyphLayer)
      item.glyphSprites = []
    }
    item.glyphLayer.visible = true
    const pool = item.glyphSprites!

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      let sprite = pool[i]
      if (!sprite) {
        sprite = new Sprite()
        sprite.anchor.set(0.5)
        pool.push(sprite)
        item.glyphLayer.addChild(sprite)
      }
      if (sprite.texture !== e.texture) sprite.texture = e.texture
      sprite.position.set(e.x, e.y)
      sprite.scale.set(e.scale)
      sprite.alpha = e.alpha
      sprite.visible = true
    }
    for (let i = entries.length; i < pool.length; i++) pool[i]!.visible = false
  }

  /** Cached glyph breakdown, kicking off rasterization on first request. */
  private requestGlyphs(tex: string, color: string, fontSize: number): TexGlyphRender[] | null {
    const key = `${tex} ${color} ${fontSize}`
    const cached = this.glyphCache.get(key)
    if (Array.isArray(cached)) return cached
    if (cached === 'pending' || !this.texProvider?.getGlyphs) return null
    this.glyphCache.set(key, 'pending')
    const p = this.texProvider
      .getGlyphs(tex, color, fontSize)
      .then((glyphs) => this.glyphCache.set(key, glyphs))
      .catch(() => this.glyphCache.delete(key))
      .finally(() => this.pendingTex.delete(p))
    this.pendingTex.add(p)
    return null
  }

  /**
   * Cached whole-string texture, kicking off rasterization on first request —
   * the sprite-free half of `assignTexTexture`, because a matrix has to know
   * whether a cell's texture exists *before* deciding what to draw.
   */
  private requestTexture(tex: string, color: string, fontSize: number): Texture | null {
    const key = `${tex}\u0000${color}\u0000${fontSize}`
    const cached = this.texCache.get(key)
    if (cached instanceof Texture) return cached
    if (cached === 'pending' || !this.texProvider) return null
    this.texCache.set(key, 'pending')
    const p = this.texProvider
      .getTexture(tex, color, fontSize)
      .then((texture) => this.texCache.set(key, texture))
      .catch(() => this.texCache.delete(key))
      .finally(() => this.pendingTex.delete(p))
    this.pendingTex.add(p)
    return null
  }

  private assignTexTexture(sprite: Sprite, tex: string, color: string, fontSize: number): void {
    const texture = this.requestTexture(tex, color, fontSize)
    if (texture && sprite.texture !== texture) sprite.texture = texture
  }

  /**
   * Resolves when no LaTeX textures are in flight. The export worker calls
   * update(t) → whenIdle() → update(t) again → screenshot, so every frame is
   * captured with all textures present (determinism over latency).
   */
  async whenIdle(): Promise<void> {
    while (this.pendingTex.size > 0) {
      await Promise.all([...this.pendingTex])
    }
  }

  private applyWrite(item: Item, res: ResolvedNode): void {
    // A path draws its own prefix in updateContent, by arc length. Masking it
    // as well would reveal by x-position and undo the point of doing it in
    // geometry — visibility is still handled below by the progress <= 0 case.
    if (res.source.type === 'path' && res.writeProgress !== null) {
      item.view.visible = res.writeProgress > 0
      return
    }
    if (res.writeProgress === null) {
      if (item.mask) {
        item.view.mask = null
        item.mask.destroy()
        item.mask = null
      }
      return
    }
    const progress = res.writeProgress
    if (progress <= 0) {
      item.view.visible = false
      return
    }
    item.view.visible = true
    if (progress >= 1) {
      if (item.mask) {
        item.view.mask = null
        item.mask.destroy()
        item.mask = null
      }
      return
    }
    if (item.glyphWrite) {
      // The per-glyph alphas are the reveal; a mask on top would clip it.
      if (item.mask) {
        item.view.mask = null
        item.mask.destroy()
        item.mask = null
      }
      return
    }
    if (!item.mask) {
      item.mask = new Graphics()
      item.view.addChild(item.mask)
      item.view.mask = item.mask
    }
    // left-to-right reveal across the content's local bounds
    const b = item.content.getLocalBounds()
    item.mask.clear()
    item.mask.rect(b.x, b.y, b.width * progress, b.height).fill(0xffffff)
  }
}

/** Node identity for cache invalidation: everything except animation data and children. */
function computeStaticKey(node: ResolvedNode['source']): string {
  const { tracks: _t, transitions: _tr, ...rest } = node as unknown as Record<string, unknown> & {
    tracks: unknown
    transitions: unknown
  }
  if ('children' in rest) delete (rest as Record<string, unknown>).children
  return JSON.stringify(rest)
}
