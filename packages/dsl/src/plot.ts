import { compileExpression, ExprError } from './expr'
import type { Vec2 } from './document'

/**
 * Sampling `y = f(x)` onto the canvas.
 *
 * The drawing was never the hard part — run 4 hand-sampled a parabola in about
 * eight calls. What cost it fifteen re-lays was the *mapping*: it chose a
 * uniform 150 px per unit, and over x∈[1,2] the curve rises three units for
 * one across, so the secant visually hugged the curve and destroyed the one
 * contrast the video existed to teach. Only a picture caught it.
 *
 * So this owns the mapping and reports it back. `originScreen` and `scale` are
 * what let a caller place anything else in the same coordinate system — a point
 * on the curve, a tangent line, an axis label — without re-deriving the
 * transform and getting a different answer.
 *
 * Pure: same spec, same points, no clock and no randomness.
 */
export interface PlotSpec {
  /** e.g. `x^2`, `sin(x)/x`. The variable is `x`. */
  expression: string
  /** Function-space x range, [min, max]. */
  domain: [number, number]
  /** Canvas rectangle the plot is drawn into: top-left corner and size in px. */
  rect: { x: number; y: number; width: number; height: number }
  /** How many points to sample. More is smoother and costs the same to render. */
  samples?: number
  /**
   * Function-space y range. Omitted, it is fitted to what the function actually
   * does over the domain — which is usually right, and is reported back so the
   * caller knows what it got.
   */
  range?: [number, number]
  /**
   * Force equal px-per-unit on both axes. Off by default: a fitted range fills
   * the rectangle, which is what makes a shape legible, and true geometric
   * fidelity is rarely what a teaching frame wants (see above).
   */
  uniform?: boolean
}

export interface PlotResult {
  /** Absolute canvas points, ready for a `path` node positioned at (0, 0). */
  points: Vec2[]
  /** The y range used, fitted or given. */
  range: [number, number]
  /** Pixels per function unit, per axis. */
  scale: { x: number; y: number }
  /** Where function-space (0, 0) lands on the canvas — may be outside `rect`. */
  originScreen: Vec2
  /** Samples skipped because the function was undefined there (1/0, sqrt(-1)). */
  dropped: number
}

export class PlotError extends Error {}

const DEFAULT_SAMPLES = 120
const MAX_SAMPLES = 2000

export function samplePlot(spec: PlotSpec): PlotResult {
  const [x0, x1] = spec.domain
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x0 === x1) {
    throw new PlotError(`domain must be two different finite numbers, got [${x0}, ${x1}]`)
  }
  if (spec.rect.width <= 0 || spec.rect.height <= 0) {
    throw new PlotError('rect width and height must be positive')
  }
  const samples = Math.max(2, Math.min(spec.samples ?? DEFAULT_SAMPLES, MAX_SAMPLES))

  let f: (x: number) => number
  try {
    f = compileExpression(spec.expression)
  } catch (e) {
    throw new PlotError(e instanceof ExprError ? e.message : String(e))
  }

  // Sample first, then map: the fitted range depends on what the function did.
  const raw: { u: number; v: number }[] = []
  let dropped = 0
  for (let i = 0; i < samples; i++) {
    const u = x0 + ((x1 - x0) * i) / (samples - 1)
    const v = f(u)
    if (Number.isFinite(v)) raw.push({ u, v })
    else dropped++
  }
  if (raw.length < 2) {
    throw new PlotError(
      `"${spec.expression}" is undefined almost everywhere on [${x0}, ${x1}] — ` +
        `${dropped} of ${samples} samples were not finite. Check the domain.`,
    )
  }

  let [y0, y1] = spec.range ?? fitRange(raw.map((p) => p.v))
  if (y0 === y1) {
    // A constant function has no extent to fit; give it a unit of room so it
    // lands mid-rectangle rather than dividing by zero.
    y0 -= 0.5
    y1 += 0.5
  }

  const { scale, originScreen } = plotMapping(spec.rect, [x0, x1], [y0, y1], spec.uniform)
  const points = raw.map((p) => ({
    x: originScreen.x + p.u * scale.x,
    y: originScreen.y - p.v * scale.y,
  }))

  return { points, range: [y0, y1], scale, originScreen, dropped }
}

/**
 * Function space → canvas, as one function.
 *
 * Extracted so a curve and its axes cannot disagree: an `axes` node computes
 * its ticks through this, `samplePlot` places its points through this, and
 * `plot_function` can hand a plot the mapping an axes node already decided.
 * Deriving the transform twice is exactly how run 4 ended up with a secant that
 * hugged its curve.
 *
 * Canvas y grows downward, so the mapping flips it — the single most common
 * thing to get wrong by hand, and the reason run 4's points were all negative.
 */
export function plotMapping(
  rect: { x: number; y: number; width: number; height: number },
  domain: [number, number],
  range: [number, number],
  uniform = false,
): { scale: Vec2; originScreen: Vec2 } {
  const [x0, x1] = domain
  const [y0, y1] = range
  let sx = rect.width / (x1 - x0)
  let sy = rect.height / (y1 - y0)
  if (uniform) {
    const s = Math.min(sx, sy)
    sx = s
    sy = s
  }
  return {
    scale: { x: sx, y: sy },
    originScreen: { x: rect.x - x0 * sx, y: rect.y + y1 * sy },
  }
}

/**
 * A step that lands on round numbers — 1, 2 or 5 times a power of ten.
 *
 * Ticks at 0.7142857 are worse than no ticks: the point of a tick is that a
 * viewer can read a value off it. An agent should not have to work this out,
 * and the arithmetic to do it by hand is exactly the kind that goes unchecked.
 */
export function niceStep(span: number, target = 6): number {
  const raw = Math.abs(span) / Math.max(1, target)
  if (!Number.isFinite(raw) || raw <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return step * mag
}

/**
 * Tick values inside [min, max], on multiples of `step`.
 *
 * Values are snapped to the step's own precision: accumulating a float step
 * produces 0.30000000000000004, and a tick labelled that is worse than a tick
 * that is one pixel out.
 */
export function axisTicks(min: number, max: number, step: number): number[] {
  if (!Number.isFinite(step) || step <= 0) return []
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1)
  const out: number[] = []
  const first = Math.ceil(lo / step - 1e-9)
  for (let i = first; i * step <= hi + 1e-9; i++) {
    const v = Number((i * step).toFixed(decimals))
    if (v >= lo - 1e-9 && v <= hi + 1e-9) out.push(v)
    if (out.length > 200) break
  }
  return out
}

/** A tick's label: no trailing zeros, and `0` rather than `-0`. */
export function formatTick(v: number, step: number): string {
  const decimals = Math.max(0, Math.min(6, -Math.floor(Math.log10(step))))
  const text = v.toFixed(decimals)
  const trimmed = decimals > 0 ? text.replace(/\.?0+$/, '') : text
  return trimmed === '-0' ? '0' : trimmed
}

/** Pad the observed extent slightly so the curve does not graze the edges. */
function fitRange(values: number[]): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const pad = (hi - lo) * 0.05
  return [lo - pad, hi + pad]
}
