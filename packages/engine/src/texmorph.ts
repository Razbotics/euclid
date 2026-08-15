/**
 * Matched-glyph LaTeX morphing.
 *
 * The v1 morph cross-faded two whole-equation textures: mid-morph both forms
 * sat overlapped at partial opacity, and because each form was centred
 * independently, terms that did not change still drifted — the `=` visibly
 * slid sideways. This replaces that with glyph correspondence: shared glyphs
 * move (usually not at all), and only genuinely new or removed ones fade.
 *
 * Everything here is a pure function of (fromGlyphs, toGlyphs, progress), so
 * the purity invariant holds — no time, no randomness, no accumulated state.
 */

/** One rendered glyph, positioned relative to the equation's centre, in px. */
export interface TexGlyph {
  /**
   * Unicode codepoint hex, from MathJax's `data-c` — the glyph's identity.
   * Two glyphs match iff their codes are equal.
   */
  code: string
  /** centre of the glyph, relative to the equation's centre */
  x: number
  y: number
  width: number
  height: number
}

export interface GlyphPair {
  fromIndex: number
  toIndex: number
}

export interface GlyphMatch {
  pairs: GlyphPair[]
  /** indices of from-glyphs with no counterpart — these fade out */
  removed: number[]
  /** indices of to-glyphs with no counterpart — these fade in */
  added: number[]
}

/**
 * Pair glyphs between two equations by longest common subsequence of codes.
 *
 * LCS rather than greedy nearest-match because it preserves reading order:
 * matched glyphs can never cross over one another, which is what keeps the
 * motion legible. A greedy matcher pairing `c` with a later `c` would drag it
 * across the `=` and read as chaos.
 */
export function matchGlyphs(from: TexGlyph[], to: TexGlyph[]): GlyphMatch {
  const n = from.length
  const m = to.length

  // lengths[i][j] = LCS length of from[i..] and to[j..]
  const lengths: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i]![j] =
        from[i]!.code === to[j]!.code
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }

  const pairs: GlyphPair[] = []
  const removed: number[] = []
  const added: number[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (from[i]!.code === to[j]!.code) {
      pairs.push({ fromIndex: i, toIndex: j })
      i++
      j++
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      removed.push(i++)
    } else {
      added.push(j++)
    }
  }
  while (i < n) removed.push(i++)
  while (j < m) added.push(j++)

  return { pairs, removed, added }
}

/**
 * Fades are staggered rather than simultaneous: what is leaving goes first,
 * what is arriving comes last. A straight cross-fade puts both on screen at
 * half opacity through the middle, which is the muddy look being replaced.
 */
const FADE_OUT_BY = 0.45
const FADE_IN_FROM = 0.55

/** A glyph to draw this frame, with which equation's texture to draw it from. */
export interface MorphedGlyph {
  /** which glyph list `index` refers to */
  source: 'from' | 'to'
  index: number
  x: number
  y: number
  /** 1 unless a matched glyph changes size (e.g. becomes a superscript) */
  scale: number
  alpha: number
}

const lerp = (a: number, b: number, u: number): number => a + (b - a) * u
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * Where every glyph sits at `progress`, given a precomputed match.
 *
 * Matched glyphs are drawn from the *source* texture and moved to the target
 * position: the code is identical so the shape is identical, and reusing one
 * sprite means no cross-fade seam on a glyph that never actually changed.
 */
export function morphGlyphs(
  from: TexGlyph[],
  to: TexGlyph[],
  match: GlyphMatch,
  progress: number,
): MorphedGlyph[] {
  const u = clamp01(progress)
  const out: MorphedGlyph[] = []

  for (const { fromIndex, toIndex } of match.pairs) {
    const a = from[fromIndex]!
    const b = to[toIndex]!
    out.push({
      source: 'from',
      index: fromIndex,
      x: lerp(a.x, b.x, u),
      y: lerp(a.y, b.y, u),
      // Height rather than width: width varies with glyph advance, height
      // tracks the actual type size (a superscript really is smaller).
      scale: a.height > 0 ? lerp(1, b.height / a.height, u) : 1,
      alpha: 1,
    })
  }

  for (const index of match.removed) {
    const alpha = 1 - clamp01(u / FADE_OUT_BY)
    if (alpha > 0) {
      const g = from[index]!
      out.push({ source: 'from', index, x: g.x, y: g.y, scale: 1, alpha })
    }
  }

  for (const index of match.added) {
    const alpha = clamp01((u - FADE_IN_FROM) / (1 - FADE_IN_FROM))
    if (alpha > 0) {
      const g = to[index]!
      out.push({ source: 'to', index, x: g.x, y: g.y, scale: 1, alpha })
    }
  }

  return out
}
