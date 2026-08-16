/**
 * Staggered reveals: N things appearing one after another, overlapping enough
 * to flow rather than tick.
 *
 * Lifted out of `writeGlyphAlphas`, which had this maths with `glyph` welded
 * to it. The same curve serves an equation revealed symbol by symbol, a matrix
 * filling in cell by cell, and a group whose children arrive one at a time —
 * the only difference is what order the caller wants them in.
 *
 * Pure: (count, progress, order) → alphas. No time, no state.
 */

/** Fraction of the whole reveal that a single element spends fading in. */
const ELEMENT_SPAN = 0.3

export interface StaggerOptions {
  /**
   * `rank[i]` is when element `i` arrives, 0-based — a permutation of
   * 0..count-1. Defaults to index order (reading order for glyphs, row-major
   * for a grid). Column-major, outside-in, or "the diagonal first" are all
   * just a different permutation.
   */
  rank?: number[]
  /** Overlap control: 1 fades everything together, 0 is strictly one at a time. */
  span?: number
}

export function staggerAlphas(
  count: number,
  progress: number,
  options: StaggerOptions = {},
): number[] {
  const u = progress < 0 ? 0 : progress > 1 ? 1 : progress
  if (count <= 0) return []
  if (count === 1) return [u]
  const span = Math.min(1, Math.max(0.01, options.span ?? ELEMENT_SPAN))
  const step = (1 - span) / (count - 1)
  const rank = options.rank
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const k = rank?.[i] ?? i
    const a = (u - k * step) / span
    out.push(a < 0 ? 0 : a > 1 ? 1 : a)
  }
  return out
}

/**
 * Rank cells of a row-major grid so they arrive column by column instead of
 * row by row — how a matrix built from column vectors wants to be revealed.
 */
export function columnMajorRank(rows: number, cols: number): number[] {
  const rank = new Array<number>(rows * cols)
  let k = 0
  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < rows; i++) rank[i * cols + j] = k++
  }
  return rank
}
