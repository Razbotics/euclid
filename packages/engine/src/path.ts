import type { Vec2 } from '@euclid/dsl'

/**
 * The prefix of a polyline drawn up to `progress`, measured by **arc length**.
 *
 * This is what "writing on" a curve means. The generic write-on sweeps a
 * rectangular mask across the node's bounds, which is right for a line of text
 * and wrong for a curve: a mask edge reveals by *x position*, so a steep
 * section appears all at once and a curve that doubles back reveals its later
 * half first. Advancing along the path instead makes the reveal look drawn.
 *
 * Pure and Pixi-free, so it is tested in `smoke.ts` without a browser — the
 * same discipline as the glyph matcher.
 *
 * The final segment is cut proportionally rather than snapped to a vertex, or
 * a nine-point curve would reveal in nine visible steps.
 */
export function pathAtProgress(points: Vec2[], closed: boolean, progress: number): Vec2[] {
  if (points.length < 2) return []
  const pts = closed ? [...points, points[0]!] : points
  if (progress <= 0) return []
  if (progress >= 1) return [...pts]

  const segments: number[] = []
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)
    segments.push(d)
    total += d
  }
  // A degenerate path (every point identical) has no length to walk along, so
  // it is either not started or fully drawn — never partially.
  if (total === 0) return [...pts]

  const target = total * progress
  const out: Vec2[] = [pts[0]!]
  let walked = 0
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    if (walked + seg >= target) {
      const f = seg === 0 ? 0 : (target - walked) / seg
      const a = pts[i]!
      const b = pts[i + 1]!
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f })
      return out
    }
    walked += seg
    out.push(pts[i + 1]!)
  }
  return out
}

/** A place on a path: where it is, and which way it is heading. */
export interface PathPoint {
  x: number
  y: number
  /** Direction of travel in radians, for orienting whatever is riding along. */
  angle: number
}

/**
 * The single point at `progress` along a polyline, by **arc length** — what a
 * token flowing along a path sits on.
 *
 * Arc length rather than segment index for the same reason `pathAtProgress`
 * uses it: on a curve sampled unevenly, stepping per segment would speed up
 * and slow down for no visible reason. The angle comes from the segment being
 * travelled, so a follower can face the way it is going.
 */
export function pointAtProgress(points: Vec2[], closed: boolean, progress: number): PathPoint | null {
  if (points.length === 0) return null
  const pts = closed && points.length > 1 ? [...points, points[0]!] : points
  const first = pts[0]!
  if (pts.length < 2) return { x: first.x, y: first.y, angle: 0 }

  const u = progress < 0 ? 0 : progress > 1 ? 1 : progress
  const segments: number[] = []
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)
    segments.push(d)
    total += d
  }
  const angleOf = (a: Vec2, b: Vec2) => Math.atan2(b.y - a.y, b.x - a.x)
  // Every point identical: there is nowhere to travel, so the follower sits on
  // it rather than dividing by zero.
  if (total === 0) return { x: first.x, y: first.y, angle: 0 }

  const target = total * u
  let walked = 0
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    if (walked + seg >= target) {
      const f = seg === 0 ? 0 : (target - walked) / seg
      const a = pts[i]!
      const b = pts[i + 1]!
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        angle: angleOf(a, b),
      }
    }
    walked += seg
  }
  const last = pts[pts.length - 1]!
  return { x: last.x, y: last.y, angle: angleOf(pts[pts.length - 2]!, last) }
}

/** Total arc length, for callers that need to pace something against a path. */
export function pathLength(points: Vec2[], closed: boolean): number {
  const pts = closed && points.length > 1 ? [...points, points[0]!] : points
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)
  }
  return total
}
