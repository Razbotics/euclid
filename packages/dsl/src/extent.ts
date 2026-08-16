import type { EuclidNode, KeyValue, Vec2 } from './document'
import { gridOf, gridSize } from './grid'

/**
 * How big a node is, as a half-width and half-height about its centre.
 *
 * Used to stop an arrow at the *edge* of what it points at rather than at its
 * centre, which is the difference between a diagram and a pile of overlapping
 * lines.
 *
 * Deliberately **estimated, not measured**, for the same reason the matrix grid
 * is: the real width of a rendered equation is only knowable after MathJax has
 * rasterized it, which is asynchronous, so measuring would make an arrow's
 * geometry differ between a cold frame and a warm one and break the purity
 * invariant. Shapes and grids are exact; text and LaTeX are approximated from
 * their font size and length, and `gap` is the caller's escape hatch when the
 * approximation looks tight.
 */
export interface Extent {
  halfWidth: number
  halfHeight: number
  /**
   * How the boundary is shaped. A circle's bounding *box* is 41% further away
   * than its rim on the diagonal, which leaves an arrow visibly short of what
   * it points at — the most common case there is, so it is worth the one extra
   * field.
   */
  shape?: 'box' | 'ellipse'
}

/** Rough advance width of a glyph as a fraction of font size. */
const TEXT_ASPECT = 0.52
/** LaTeX is denser than prose per character, and markup does not render. */
const TEX_ASPECT = 0.42

export function nodeExtent(node: EuclidNode, props: Record<string, KeyValue> = {}): Extent {
  const num = (key: string, fallback: number): number => {
    const v = props[key]
    return typeof v === 'number' ? v : fallback
  }
  const scale = num('scale', node.scale)

  const grow = (e: Extent): Extent => ({
    halfWidth: e.halfWidth * scale,
    halfHeight: e.halfHeight * scale,
    shape: e.shape,
  })

  switch (node.type) {
    case 'rect':
      return grow({ halfWidth: num('width', node.width) / 2, halfHeight: num('height', node.height) / 2 })
    case 'circle': {
      const r = num('radius', node.radius)
      return grow({ halfWidth: r, halfHeight: r, shape: 'ellipse' })
    }
    case 'text': {
      const size = num('fontSize', node.fontSize)
      return grow({
        halfWidth: (node.text.length * size * TEXT_ASPECT) / 2,
        halfHeight: size * 0.6,
      })
    }
    case 'latex': {
      const size = num('fontSize', node.fontSize)
      return grow({
        halfWidth: (node.tex.length * size * TEX_ASPECT) / 2,
        halfHeight: size * 0.7,
      })
    }
    case 'matrix':
    case 'tokens': {
      const size = gridSize(gridOf(node))
      return grow({ halfWidth: size.width / 2, halfHeight: size.height / 2 })
    }
    case 'line':
      return grow(boundsOf([node.from, node.to]))
    case 'path':
      return grow(boundsOf(node.points))
    case 'group': {
      // The union of the children, in the group's own coordinates. A group is
      // one of the most useful things to point at, and treating it as a point
      // would run every arrow into the middle of it.
      let e: Extent = { halfWidth: 0, halfHeight: 0 }
      for (const child of node.children) {
        const c = nodeExtent(child)
        e = {
          halfWidth: Math.max(e.halfWidth, Math.abs(child.position.x) + c.halfWidth),
          halfHeight: Math.max(e.halfHeight, Math.abs(child.position.y) + c.halfHeight),
        }
      }
      return grow(e)
    }
    default:
      // arrow, and the spatial types: their geometry is defined by endpoints
      // rather than by an extent about a centre.
      return { halfWidth: 0, halfHeight: 0 }
  }
}

function boundsOf(points: Vec2[]): Extent {
  let halfWidth = 0
  let halfHeight = 0
  for (const p of points) {
    halfWidth = Math.max(halfWidth, Math.abs(p.x))
    halfHeight = Math.max(halfHeight, Math.abs(p.y))
  }
  return { halfWidth, halfHeight }
}

/**
 * Where a ray leaving `centre` in direction `dir` crosses the node's box, plus
 * `gap` of clearance. Returns the centre itself for an extentless node, so an
 * arrow to a bare point still lands on it.
 */
export function edgePoint(centre: Vec2, extent: Extent, dir: Vec2, gap: number): Vec2 {
  const len = Math.hypot(dir.x, dir.y)
  if (len < 1e-9) return centre
  const ux = dir.x / len
  const uy = dir.y / len
  let t: number
  if (extent.shape === 'ellipse' && extent.halfWidth > 0 && extent.halfHeight > 0) {
    // Where the ray meets the ellipse itself, not its bounding box.
    t = 1 / Math.hypot(ux / extent.halfWidth, uy / extent.halfHeight)
  } else {
    const tx = extent.halfWidth > 0 && Math.abs(ux) > 1e-9 ? extent.halfWidth / Math.abs(ux) : Infinity
    const ty = extent.halfHeight > 0 && Math.abs(uy) > 1e-9 ? extent.halfHeight / Math.abs(uy) : Infinity
    t = Math.min(tx, ty)
  }
  const reach = (Number.isFinite(t) ? t : 0) + gap
  return { x: centre.x + ux * reach, y: centre.y + uy * reach }
}
