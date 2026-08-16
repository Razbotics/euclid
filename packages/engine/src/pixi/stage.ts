import { Container, Graphics, Sprite, Text, Texture, type Renderer } from 'pixi.js'
import { globalToScene, type Color, type EuclidDoc, type LatexNode, type Vec2 } from '@euclid/dsl'
import { pathAtProgress } from '../path'
import { resolveScene, type ResolvedNode } from '../sampler'
import {
  findGlyphRun,
  glyphBounds,
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
  /** latex only: sprite pool for matched-glyph morphing, reused across frames */
  glyphSprites?: Sprite[]
  glyphLayer?: Container
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

    this.bg.clear()
    this.bg.rect(0, 0, doc.canvas.width, doc.canvas.height).fill(at.scene.background)

    const resolved = resolveScene(at.scene, at.localT)
    const seen = new Set<string>()
    this.syncChildren(resolved, this.layer, seen)

    for (const [id, item] of this.items) {
      if (!seen.has(id)) {
        item.view.destroy({ children: true })
        this.items.delete(id)
      }
    }
  }

  private teardown(): void {
    for (const item of this.items.values()) item.view.destroy({ children: true })
    this.items.clear()
    this.layer.removeChildren()
    this.currentSceneId = null
  }

  private syncChildren(resolved: ResolvedNode[], parent: Container, seen: Set<string>): void {
    resolved.forEach((res, zIndex) => {
      const item = this.syncNode(res, parent, seen)
      parent.setChildIndex(item.view, Math.min(zIndex, parent.children.length - 1))
      if (res.source.type === 'group') {
        this.syncChildren(res.children, item.content, seen)
      }
    })
  }

  private syncNode(res: ResolvedNode, parent: Container, seen: Set<string>): Item {
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
    item.view.position.set(pos.x, pos.y)
    item.view.scale.set(p.scale as number)
    item.view.rotation = p.rotation as number
    item.view.alpha = p.opacity as number

    this.updateContent(item, res)
    this.updateHighlight(item, res)
    this.applyWrite(item, res)
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

    const bounds = this.highlightBounds(item, res, hl.tex)
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

  /** Glyph-run bounds for a targeted term, else the node's own bounds. */
  private highlightBounds(item: Item, res: ResolvedNode, tex?: string): GlyphBounds | null {
    const node = res.source
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
        content = new Container()
        break
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
      case 'group':
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

  private assignTexTexture(sprite: Sprite, tex: string, color: string, fontSize: number): void {
    const key = `${tex} ${color} ${fontSize}`
    const cached = this.texCache.get(key)
    if (cached instanceof Texture) {
      if (sprite.texture !== cached) sprite.texture = cached
      return
    }
    if (cached === 'pending' || !this.texProvider) return
    this.texCache.set(key, 'pending')
    const p = this.texProvider
      .getTexture(tex, color, fontSize)
      .then((texture) => this.texCache.set(key, texture))
      .catch(() => this.texCache.delete(key))
      .finally(() => this.pendingTex.delete(p))
    this.pendingTex.add(p)
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
