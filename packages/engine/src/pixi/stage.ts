import { Container, Graphics, Sprite, Text, Texture, type Renderer } from 'pixi.js'
import {
  axisTicks,
  buildMesh,
  cellCenter,
  cellsInRange,
  formatTick,
  niceStep,
  plotMapping,
  videoSourceTime,
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
  type ArrowNode,
  type Axes3dNode,
  type AxesNode,
  type ImageNode,
  type VideoNode,
  type MatrixNode,
  type MeshData,
  type MeshNode,
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
/**
 * Turns a project `assetId` into a texture.
 *
 * A seam rather than a URL builder because the two surfaces answer it
 * differently: the editor fetches through the API with the user's session,
 * while the export worker has already downloaded the bytes with the internal
 * key and hands them over directly. The stage only needs "give me pixels for
 * this id", and neither surface has to know about the other.
 */
export interface ImageProvider {
  getTexture(assetId: string): Promise<Texture>
}

/**
 * A single frame of a video asset, at an exact second of the source.
 *
 * Separate from ImageProvider because the answer depends on *when*, and
 * because the implementations differ in kind: a still is fetched once, a frame
 * has to be sought. The stage asks the same question either way — give me
 * pixels — and `videoSourceTime` has already decided which second to ask for,
 * so the decision stays in the document and only the decoding is out here.
 */
export interface VideoProvider {
  getFrame(assetId: string, sourceSec: number): Promise<Texture>
}

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

/**
 * The light a flat-shaded mesh is lit by: fixed in scene space, from above,
 * ahead and to the left. Fixed rather than authorable on purpose — it is a
 * depth *cue*, and a scene where every solid agrees about where the light is
 * reads as one space. `y` is negative because y grows downward.
 */
const MESH_LIGHT = (() => {
  const l = { x: -0.4, y: -0.7, z: 0.6 }
  const m = Math.hypot(l.x, l.y, l.z)
  return { x: l.x / m, y: l.y / m, z: l.z / m }
})()

/** Scale a '#rrggbb' toward black by `k`, returning what Pixi wants. */
function shadeColor(hex: string, k: number): number {
  const n = parseInt(hex.slice(1), 16)
  const f = Math.max(0, Math.min(1, k))
  const r = Math.round(((n >> 16) & 0xff) * f)
  const g = Math.round(((n >> 8) & 0xff) * f)
  const b = Math.round((n & 0xff) * f)
  return (r << 16) | (g << 8) | b
}

/** Unit normal of a triangle in scene space, for Lambert shading. */
function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ux = b.x - a.x
  const uy = b.y - a.y
  const uz = b.z - a.z
  const vx = c.x - a.x
  const vy = c.y - a.y
  const vz = c.z - a.z
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  const m = Math.hypot(nx, ny, nz) || 1
  return { x: nx / m, y: ny / m, z: nz / m }
}

/** Node types whose geometry spans depth and is projected vertex by vertex. */
function isSpatialType(type: string): boolean {
  return (
    type === 'vector3' ||
    type === 'axes3d' ||
    type === 'points3' ||
    type === 'mesh' ||
    type === 'arrow'
  )
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
  /** image only: the sprite, and the box it is cropped to when fit is `cover` */
  imageSprite?: Sprite
  /** video only, with `holdVideoFrames`: the last frame drawn, shown while the next decodes */
  heldVideoFrame?: Texture
  cropMask?: Graphics
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
  /**
   * Nodes pinned to the frame. A sibling of `layer` rather than a child, which
   * is the whole mechanism: the camera transform lives on `layer`, so anything
   * in here is untouched by pan, zoom, roll and orbit alike. Added last, so an
   * overlay draws over the scene.
   */
  private overlay = new Container()
  private items = new Map<string, Item>()
  private texCache = new Map<string, Texture | 'pending'>()
  private glyphCache = new Map<string, TexGlyphRender[] | 'pending'>()
  /** Matching is O(n·m); the pair is stable for a morph, so compute it once. */
  private matchCache = new Map<string, GlyphMatch>()
  /**
   * Expanded mesh geometry, keyed by its spec. Geometry is not animatable, so
   * a scene has as many entries as it has distinct solids — rebuilding a
   * 2000-triangle sphere every frame would be the one avoidable cost here.
   */
  private meshCache = new Map<string, MeshData>()
  private imageCache = new Map<string, Texture | 'pending'>()
  /** Keyed by `assetId@second`, so scrubbing back to a time reuses its frame. */
  private videoCache = new Map<string, Texture | 'pending'>()
  /**
   * Decoded frames kept at once. Playback asks for a new millisecond every
   * tick, and an uncapped cache kept every one of them — ~900 bitmaps for a
   * 15s clip. Evicting is safe for export: a missing key is simply fetched
   * again and `whenIdle()` waits for it.
   */
  private static readonly VIDEO_CACHE_MAX = 90
  private holdVideoFrames: boolean
  private pendingTex = new Set<Promise<unknown>>()
  private currentSceneId: string | null = null
  /** The 3D half of the camera while a spatial scene is being drawn; null when flat. */
  private cam3: Camera3 | null = null
  /**
   * Scene-local time of the frame being drawn. Held the way `cam3` is, because
   * a video node needs to know *when* it is and `ResolvedNode` describes a node
   * rather than the moment.
   */
  private localT = 0
  private texProvider: TexProvider | null
  private imageProvider: ImageProvider | null
  private videoProvider: VideoProvider | null

  constructor(
    private root: Container,
    opts?: {
      texProvider?: TexProvider
      imageProvider?: ImageProvider
      videoProvider?: VideoProvider
      /**
       * Editor playback only. While a video frame is still decoding, keep the
       * clip's previous frame on screen instead of drawing nothing.
       *
       * Off by default, and never on for export or `preview_frames`: those wait
       * for `whenIdle()` before capturing, so every frame they keep is the exact
       * frame for its time and this option would change nothing but the risk.
       * In the editor, playback asks for a new frame every tick and decoding
       * cannot keep up, so without it a playing video is a black canvas. The
       * settled picture for a given (document, time) is unchanged either way —
       * this only decides what is shown in the milliseconds before it arrives.
       */
      holdVideoFrames?: boolean
    },
  ) {
    this.texProvider = opts?.texProvider ?? null
    this.imageProvider = opts?.imageProvider ?? null
    this.videoProvider = opts?.videoProvider ?? null
    this.holdVideoFrames = opts?.holdVideoFrames ?? false
    root.addChild(this.bg)
    root.addChild(this.layer)
    root.addChild(this.overlay)
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

    this.localT = at.localT
    const resolved = resolveScene(at.scene, at.localT, doc.canvas)
    this.applyCamera(resolved.camera, doc.canvas)
    this.cam3 = resolved.cam3
    const seen = new Set<string>()
    // Split at the root only: a child inherits its group's transform, so
    // pinning one inside a moving group is a contradiction (see NodeBase.fixed).
    const pinned = resolved.nodes.filter((n) => n.source.fixed)
    const inWorld = resolved.nodes.filter((n) => !n.source.fixed)
    this.syncChildren(inWorld, this.layer, seen, resolved.spatial)
    this.syncChildren(pinned, this.overlay, seen)

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
    this.overlay.removeChildren()
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
      case 'mesh':
      case 'arrow':
      case 'axes':
        content = new Graphics()
        break
      case 'video':
      case 'image': {
        // A container around the sprite so `cover` can crop with its own mask
        // without competing for the one a `write` reveal uses.
        const holder = new Container()
        const sprite = new Sprite()
        sprite.anchor.set(0.5)
        holder.addChild(sprite)
        content = holder
        break
      }
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
      case 'image':
        this.updateImage(item, res, node)
        return
      case 'video':
        this.updateVideo(item, res, node)
        return
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
      case 'mesh':
        // Geometry that spans depth projects its own vertices — see
        // updateSpatial. Nothing to do when the scene is flat, because a
        // spatial node without a camera to project through has no position.
        if (this.cam3) this.updateSpatial(item, res, node, this.cam3)
        else (item.content as Graphics).clear()
        return
      case 'arrow':
        this.updateArrow(item, res, node)
        return
      case 'axes':
        this.updateAxes(item, res, node)
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
  /**
   * Draw an image into its box.
   *
   * The texture arrives asynchronously, so a frame rendered before it lands
   * would be missing the image entirely — the same hazard LaTeX has. It is
   * handled the same way: the request is registered as pending, `whenIdle()`
   * waits for it, and the export re-renders. Nothing here guesses at a size
   * before the pixels exist.
   */
  private updateImage(item: Item, res: ResolvedNode, node: ImageNode): void {
    const holder = item.content as Container
    if (!item.imageSprite) item.imageSprite = holder.children[0] as Sprite
    const sprite = item.imageSprite

    const texture = this.imageTexture(node.assetId)
    if (!texture) {
      sprite.visible = false
      return
    }
    this.fitInto(item, holder, sprite, texture, res.props.width as number, res.props.height as number, node.fit)
  }

  /**
   * Size a sprite into its box and crop the overflow when the fit demands it.
   * Shared by image and video so the two can never disagree about what
   * `cover` means.
   */
  private fitInto(
    item: Item,
    holder: Container,
    sprite: Sprite,
    texture: Texture,
    w: number,
    h: number,
    fit: 'contain' | 'cover' | 'fill',
  ): void {
    sprite.visible = true
    sprite.texture = texture
    const tw = texture.width || 1
    const th = texture.height || 1

    if (fit === 'fill') {
      sprite.width = w
      sprite.height = h
    } else {
      // contain fits inside the box, cover fills it and spills; the spill is
      // what the crop below removes.
      const k = fit === 'cover' ? Math.max(w / tw, h / th) : Math.min(w / tw, h / th)
      sprite.width = tw * k
      sprite.height = th * k
    }

    if (fit === 'cover') {
      if (!item.cropMask) {
        item.cropMask = new Graphics()
        holder.addChild(item.cropMask)
      }
      item.cropMask.clear().rect(-w / 2, -h / 2, w, h).fill(0xffffff)
      holder.mask = item.cropMask
    } else if (item.cropMask) {
      holder.mask = null
      item.cropMask.destroy()
      item.cropMask = undefined
    }
  }

  /**
   * Draw the source frame that belongs at this scene time.
   *
   * `videoSourceTime` decides which second; everything here is about getting
   * it. Outside the clip's range it draws nothing rather than holding the last
   * frame — a clip that has ended should leave the scene, not freeze in it.
   */
  private updateVideo(item: Item, res: ResolvedNode, node: VideoNode): void {
    const holder = item.content as Container
    if (!item.imageSprite) item.imageSprite = holder.children[0] as Sprite
    const sprite = item.imageSprite

    const sourceSec = videoSourceTime(node, this.localT)
    if (sourceSec === null) {
      sprite.visible = false
      item.heldVideoFrame = undefined
      return
    }
    // Under hold, a frame that arrives late still becomes this node's picture.
    // During playback *every* frame arrives late — the playhead has moved on by
    // the time it decodes, so its exact key is never asked for again — and
    // holding only on-time frames left every shot after the first black.
    const fresh = this.videoFrame(
      node.assetId,
      sourceSec,
      this.holdVideoFrames ? (tex) => { item.heldVideoFrame = tex } : undefined,
    )
    if (fresh && this.holdVideoFrames) item.heldVideoFrame = fresh
    const texture = fresh ?? (this.holdVideoFrames ? item.heldVideoFrame : null)
    if (!texture || texture.destroyed) {
      sprite.visible = false
      return
    }
    this.fitInto(item, holder, sprite, texture, res.props.width as number, res.props.height as number, node.fit)
  }

  /**
   * A decoded frame, or null while it is being fetched.
   *
   * Quantised to the millisecond in the cache key: asking for 1.2000001s and
   * 1.2s must not decode twice, and a document evaluated at the same `t` must
   * land on the same key or the frame cache would never hit.
   */
  private videoFrame(assetId: string, sourceSec: number, onReady?: (tex: Texture) => void): Texture | null {
    const key = `${assetId}@${Math.round(sourceSec * 1000)}`
    const cached = this.videoCache.get(key)
    if (cached && cached !== 'pending') return cached
    if (cached === 'pending' || !this.videoProvider) return null
    this.videoCache.set(key, 'pending')
    const p = this.videoProvider
      .getFrame(assetId, sourceSec)
      .then((tex) => {
        this.videoCache.set(key, tex)
        onReady?.(tex)
        this.evictVideoFrames()
      })
      .catch(() => {
        this.videoCache.delete(key)
      })
      .finally(() => this.pendingTex.delete(p))
    this.pendingTex.add(p)
    return null
  }

  /** Drop the oldest decoded frames past the cap, sparing any a node is holding on screen. */
  private evictVideoFrames(): void {
    const held = new Set<Texture>()
    for (const item of this.items.values()) {
      if (item.heldVideoFrame) held.add(item.heldVideoFrame)
      // A sprite may still be showing a frame between updates; destroying the
      // texture under it would crash the next render rather than blank it.
      if (item.imageSprite) held.add(item.imageSprite.texture)
    }
    for (const [key, tex] of this.videoCache) {
      if (this.videoCache.size <= EuclidStage.VIDEO_CACHE_MAX) break
      if (tex === 'pending' || held.has(tex)) continue
      this.videoCache.delete(key)
      tex.destroy(true)
    }
  }

  /**
   * Cached texture for an asset, or null while it is still loading.
   *
   * Mirrors `texTexture`: one request per id, tracked in `pendingTex` so
   * `whenIdle()` covers it, and a failure caches nothing so a transient
   * network error can be retried on the next frame rather than blanking the
   * node for the rest of the render.
   */
  private imageTexture(assetId: string): Texture | null {
    const cached = this.imageCache.get(assetId)
    if (cached && cached !== 'pending') return cached
    if (cached === 'pending' || !this.imageProvider) return null
    this.imageCache.set(assetId, 'pending')
    const p = this.imageProvider
      .getTexture(assetId)
      .then((tex) => {
        this.imageCache.set(assetId, tex)
      })
      .catch(() => {
        this.imageCache.delete(assetId)
      })
      .finally(() => this.pendingTex.delete(p))
    this.pendingTex.add(p)
    return null
  }

  private updateSpatial(
    item: Item,
    res: ResolvedNode,
    node: Vector3Node | Axes3dNode | Points3Node | MeshNode,
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
      case 'mesh':
        this.drawMesh(g, res, node, cam, anchor, scale, wp)
        return
    }
  }

  /**
   * A solid: project every vertex, drop the triangles facing away, sort what
   * is left back to front, and fill.
   *
   * That sort is the whole correctness story, and it is stronger than it looks.
   * Measured against a per-pixel z-buffer over four camera angles (plans/009),
   * this ordering is *exactly* right — zero differing pixels — on a closed
   * surface with `cull` on, including a torus, which occludes itself. Culling
   * is what earns that: it removes the inward-facing half, and what remains of
   * a closed surface can always be depth-ordered. Without it the same torus
   * lands at 0.01% wrong, and two solids that physically intersect are wrong
   * by ~11% no matter what, which is a limit of per-face sorting rather than
   * of this implementation.
   *
   * Depth dims the *shade* rather than the alpha, because a solid fading toward
   * transparent reads as glass — you would see the inside of the far wall.
   */
  private drawMesh(
    g: Graphics,
    res: ResolvedNode,
    node: MeshNode,
    cam: Camera3,
    anchor: Vec3,
    scale: number,
    writeProgress: number | null,
  ): void {
    const key = JSON.stringify(node.geometry)
    let data = this.meshCache.get(key)
    if (!data) {
      data = buildMesh(node.geometry)
      this.meshCache.set(key, data)
    }

    // Scale is a property of the node, so it belongs to the geometry rather
    // than to the view — a spatial node's view must stay untransformed or the
    // camera applies twice.
    const world = data.verts.map((v) => ({
      x: anchor.x + v.x * scale,
      y: anchor.y + v.y * scale,
      z: anchor.z + v.z * scale,
    }))
    const proj = world.map((v) => project3(v, cam))

    const fill = res.props.fill as string
    const faces: { pts: Projected[]; depth: number; color: number }[] = []
    for (const [ia, ib, ic] of data.faces) {
      const pa = proj[ia]
      const pb = proj[ib]
      const pc = proj[ic]
      // A vertex at or behind the camera cannot be projected; dropping the
      // whole triangle is the honest answer, the same one project3 gives.
      if (!pa || !pb || !pc) continue

      if (node.cull) {
        // Screen-space winding, which stays correct under perspective where a
        // scene-space normal test does not.
        const area = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y)
        if (area <= 0) continue
      }

      let k = 1
      if (node.shading === 'flat') {
        const n = faceNormal(world[ia]!, world[ib]!, world[ic]!)
        const lambert = Math.abs(
          n.x * MESH_LIGHT.x + n.y * MESH_LIGHT.y + n.z * MESH_LIGHT.z,
        )
        k = node.ambient + (1 - node.ambient) * lambert
      }
      const dim = (pa.dim + pb.dim + pc.dim) / 3
      faces.push({
        pts: [pa, pb, pc],
        depth: (pa.depth + pb.depth + pc.depth) / 3,
        color: shadeColor(fill, k * dim),
      })
    }

    faces.sort((a, b) => a.depth - b.depth)

    // A write reveals the sorted faces in depth order, so a solid builds up
    // from its far side rather than flickering in document order.
    const alphas =
      writeProgress === null ? null : staggerAlphas(faces.length, writeProgress)
    const strokeWidth = (res.props.strokeWidth as number) * scale

    faces.forEach((f, i) => {
      const a = alphas?.[i] ?? 1
      if (a <= 0) return
      g.poly([f.pts[0]!.x, f.pts[0]!.y, f.pts[1]!.x, f.pts[1]!.y, f.pts[2]!.x, f.pts[2]!.y])
      g.fill({ color: f.color, alpha: a })
      if (node.stroke && strokeWidth > 0) {
        g.stroke({ color: node.stroke, width: strokeWidth, alpha: a })
      }
    })
  }

  /**
   * A connector between two things, drawn in absolute scene coordinates
   * because its endpoints belong to other nodes rather than to itself.
   *
   * The endpoints arrive already resolved (see resolveArrows): stopped at the
   * edge of whatever they point at, and projected when the scene is spatial.
   * All this does is draw — a straight shaft, or a quadratic bowed sideways by
   * `curve`, with the head turned along the curve's own tangent so it meets
   * its target square rather than at the chord angle.
   */
  private updateArrow(item: Item, res: ResolvedNode, node: ArrowNode): void {
    const g = item.content as Graphics
    g.clear()
    const ends = res.arrow
    if (!ends) return

    const p = res.props
    // `position` offsets the whole connector and `scale` thickens it. Neither
    // can place it — the endpoints do that — but a property that silently does
    // nothing is worse than one that does something small.
    const offset = p.position as Vec2
    const scale = p.scale as number
    const a = { x: ends.from.x + offset.x, y: ends.from.y + offset.y }
    const b = { x: ends.to.x + offset.x, y: ends.to.y + offset.y }

    // A write grows the connector out of its source, like the vector does —
    // the mask sweep would reveal by x position, which on a connector running
    // right-to-left uncovers the head first.
    const grow = res.writeProgress === null ? 1 : res.writeProgress
    item.glyphWrite = res.writeProgress !== null
    if (grow <= 0) return
    b.x = a.x + (b.x - a.x) * grow
    b.y = a.y + (b.y - a.y) * grow

    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) return

    const width = Math.max(0.5, (p.strokeWidth as number) * scale)
    const color = p.stroke as string
    const head = Math.min(node.headSize * scale, len * 0.6)
    // The control point sits half way along and `curve` of the distance to the
    // side, so two arrows between the same pair with opposite curves bow apart
    // instead of overlapping.
    const cx = (a.x + b.x) / 2 - dy * node.curve
    const cy = (a.y + b.y) / 2 + dx * node.curve
    // The tangent at the far end of a quadratic is the control-point-to-end
    // direction; on a straight arrow that is just the chord.
    const tx = b.x - cx
    const ty = b.y - cy
    const tLen = Math.hypot(tx, ty) || 1
    const ux = tx / tLen
    const uy = ty / tLen
    const tipX = b.x
    const tipY = b.y
    const stopX = b.x - ux * head
    const stopY = b.y - uy * head

    g.moveTo(a.x, a.y)
    if (node.curve !== 0) g.quadraticCurveTo(cx, cy, stopX, stopY)
    else g.lineTo(stopX, stopY)
    g.stroke({ width, color })

    if (head > 0) {
      const halfW = head * 0.45
      g.moveTo(tipX, tipY)
        .lineTo(stopX - uy * halfW, stopY + ux * halfW)
        .lineTo(stopX + uy * halfW, stopY - ux * halfW)
        .closePath()
        .fill({ color })
    }
  }

  /**
   * A coordinate frame, drawn from the mapping the node owns.
   *
   * Every position here goes through `plotMapping`, the same function
   * `samplePlot` uses — so a curve plotted into these axes lands on these
   * ticks by construction rather than by the caller doing the arithmetic
   * twice and hoping.
   *
   * An axis sits at function-space zero when zero is in range, and at the edge
   * of the rectangle when it is not: a graph over x ∈ [2,5] should show its
   * y axis at the left, not off-screen.
   */
  private updateAxes(item: Item, res: ResolvedNode, node: AxesNode): void {
    const g = item.content as Graphics
    g.clear()
    if (!item.labelTexts) item.labelTexts = []
    const pool = item.labelTexts
    let used = 0

    const p = res.props
    const { rect, xRange, yRange } = node
    const { originScreen } = plotMapping(rect, xRange, yRange)
    const color = p.color as string
    const width = Math.max(0.5, (p.strokeWidth as number) * (p.scale as number))
    const fontSize = (p.fontSize as number) * (p.scale as number)

    const left = rect.x
    const right = rect.x + rect.width
    const top = rect.y
    const bottom = rect.y + rect.height
    // Where each axis line sits: on zero if zero is in view, else on the edge.
    const axisY = Math.min(bottom, Math.max(top, originScreen.y))
    const axisX = Math.min(right, Math.max(left, originScreen.x))

    const xStep = node.xStep ?? niceStep(xRange[1] - xRange[0])
    const yStep = node.yStep ?? niceStep(yRange[1] - yRange[0])
    const xs = axisTicks(xRange[0], xRange[1], xStep)
    const ys = axisTicks(yRange[0], yRange[1], yStep)

    // A write grows the axes out of the origin and brings the ticks in after,
    // which reads as a frame being drawn rather than a rectangle wiping in.
    const wp = res.writeProgress
    item.glyphWrite = wp !== null
    const grow = wp === null ? 1 : Math.min(1, wp / 0.45)
    const tickReveal = wp === null ? 1 : Math.max(0, (wp - 0.35) / 0.65)
    if (grow <= 0) {
      for (const t of pool) t.visible = false
      return
    }

    const tick = Math.min(rect.width, rect.height) * 0.018
    const label = (text: string, x: number, y: number, alpha: number): void => {
      if (!node.labels || alpha <= 0) return
      let t = pool[used]
      if (!t) {
        t = new Text({ text, style: { fontFamily: 'ui-sans-serif, system-ui', fontSize } })
        t.anchor.set(0.5)
        pool.push(t)
        item.content.addChild(t)
      }
      if (t.text !== text) t.text = text
      t.style.fontSize = fontSize
      t.style.fill = color
      t.position.set(x, y)
      t.alpha = alpha
      t.visible = true
      used++
    }

    if (node.grid) {
      for (const v of xs) {
        const x = originScreen.x + v * plotMapping(rect, xRange, yRange).scale.x
        g.moveTo(x, top).lineTo(x, top + (bottom - top) * grow)
      }
      for (const v of ys) {
        const y = originScreen.y - v * plotMapping(rect, xRange, yRange).scale.y
        g.moveTo(left, y).lineTo(left + (right - left) * grow, y)
      }
      g.stroke({ width: Math.max(0.5, width * 0.4), color, alpha: 0.18 })
    }

    // Axis lines, growing outward from where they cross.
    g.moveTo(axisX - (axisX - left) * grow, axisY).lineTo(axisX + (right - axisX) * grow, axisY)
    g.moveTo(axisX, axisY + (bottom - axisY) * grow).lineTo(axisX, axisY - (axisY - top) * grow)
    g.stroke({ width, color })

    const { scale } = plotMapping(rect, xRange, yRange)
    const alphas = staggerAlphas(xs.length + ys.length, tickReveal)
    let i = 0
    for (const v of xs) {
      const x = originScreen.x + v * scale.x
      const a = alphas[i++] ?? 1
      if (a <= 0) continue
      g.moveTo(x, axisY - tick).lineTo(x, axisY + tick).stroke({ width, color, alpha: a })
      // The zero label would sit on top of the other axis; one is enough.
      if (v !== 0 || Math.abs(axisX - originScreen.x) > 0.5) {
        label(formatTick(v, xStep), x, axisY + tick + fontSize * 0.8, a)
      }
    }
    for (const v of ys) {
      const y = originScreen.y - v * scale.y
      const a = alphas[i++] ?? 1
      if (a <= 0) continue
      g.moveTo(axisX - tick, y).lineTo(axisX + tick, y).stroke({ width, color, alpha: a })
      if (v !== 0) label(formatTick(v, yStep), axisX - tick - fontSize * 1.1, y, a)
    }

    if (node.xLabel) label(node.xLabel, right, axisY + tick + fontSize * 2, tickReveal)
    if (node.yLabel) label(node.yLabel, axisX + fontSize * 1.4, top, tickReveal)

    for (let k = used; k < pool.length; k++) pool[k]!.visible = false
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
