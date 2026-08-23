import type { Vec2 } from './document'

/**
 * Circles, ellipses, arcs and regular polygons, as points.
 *
 * The same shape `samplePlot` has, for the same reason: **sugar compiles to
 * dumb points and the document never holds the formula.** A generated circle is
 * a `path` like any other, so it writes on, morphs, moves and can be ridden by
 * `flow_along` with no special case anywhere downstream.
 *
 * It exists because typing one is expensive in the one currency a shell-less
 * agent actually spends. Milestone run 8 hand-sampled circle points twice, and
 * run 9 did it again — an orbit ring at 72 points, then a second ellipse at 72
 * more. The cost is not in *calls* (`add_path` takes them all at once) but in
 * output tokens: 144 coordinate pairs the model had to compute and type, none
 * of which it could check without a picture.
 *
 * Pure: same spec, same points, no clock and no randomness.
 */
export interface ArcSpec {
  /** Radii in px. Equal radii are a circle; that is the only difference. */
  rx: number
  ry: number
  /**
   * Radians, measured from the positive x axis (3 o'clock) and increasing
   * **clockwise on screen**, because canvas y points down. This is the same
   * sense a node's `rotation` turns in, so the two agree.
   */
  startAngle: number
  endAngle: number
  /** Tilt of the ellipse's own x axis, radians. Meaningless when rx === ry. */
  rotation?: number
  /**
   * How many points to place along the sweep. On a closed full turn this *is*
   * the number of sides: 3 is a triangle, 6 a hexagon, 64 reads as a circle.
   */
  samples?: number
}

export interface ArcResult {
  /** Points relative to the centre, ready for a `path` node placed there. */
  points: Vec2[]
  /** endAngle - startAngle, signed: negative sweeps run the other way. */
  sweep: number
  /** Whether the sweep closes on itself, so the last point would repeat the first. */
  fullTurn: boolean
}

export class ArcError extends Error {}

const DEFAULT_SAMPLES = 64
const MAX_SAMPLES = 2000
const TAU = Math.PI * 2

export function sampleArc(spec: ArcSpec): ArcResult {
  const { rx, ry, startAngle, endAngle } = spec
  if (!(rx > 0) || !(ry > 0) || !Number.isFinite(rx) || !Number.isFinite(ry)) {
    throw new ArcError(`rx and ry must be positive numbers, got ${rx} and ${ry}`)
  }
  if (!Number.isFinite(startAngle) || !Number.isFinite(endAngle)) {
    throw new ArcError('startAngle and endAngle must be finite numbers of radians')
  }
  const sweep = endAngle - startAngle
  if (sweep === 0) {
    throw new ArcError(
      'startAngle and endAngle are the same, which sweeps nothing. Leave both out for a ' +
        'whole circle, or give an endAngle a turn away from the start.',
    )
  }

  // A full turn's last point lands exactly on its first, so sampling the range
  // inclusively would place a duplicate — invisible on a stroke, and a
  // zero-length final side on a polygon. Geometry decides this, not `closed`:
  // the endpoint coincides whether or not the caller joins the ends.
  const fullTurn = Math.abs(sweep) >= TAU - 1e-9
  const samples = Math.max(2, Math.min(Math.floor(spec.samples ?? DEFAULT_SAMPLES), MAX_SAMPLES))
  const steps = fullTurn ? samples : samples - 1

  const tilt = spec.rotation ?? 0
  const cosT = Math.cos(tilt)
  const sinT = Math.sin(tilt)

  const points: Vec2[] = []
  for (let i = 0; i < samples; i++) {
    const a = startAngle + (sweep * i) / steps
    // The ellipse in its own frame, then rotated into the scene's. Doing it in
    // this order is what makes `rotation` tilt the ellipse rather than sweep
    // the angle, which are the same thing only on a circle.
    const ex = rx * Math.cos(a)
    const ey = ry * Math.sin(a)
    points.push({ x: ex * cosT - ey * sinT, y: ex * sinT + ey * cosT })
  }

  return { points, sweep, fullTurn }
}
