import type { MatrixNode, TokensNode, Vec2 } from './document'

/**
 * Grid geometry for the structured primitives — `matrix` and `tokens`.
 *
 * Pure, and deliberately **not measured**. Cells sit on a fixed pitch and their
 * contents are centred in the box, rather than the columns sizing themselves to
 * what is in them. Measuring would mean asking MathJax how wide `\alpha` renders,
 * which is asynchronous and only knowable after rasterization — layout would
 * then differ between a cold frame and a warm one, and the purity invariant
 * says a frame is a function of (document, time) and nothing else. It is also
 * what a matrix wants visually: columns that line up.
 *
 * Everything here is relative to the node's `position`, which is its centre —
 * the same convention as every other node.
 */

export interface GridSpec {
  rows: number
  cols: number
  cellWidth: number
  cellHeight: number
}

/**
 * The grid a structured node lays out on. A token strip is a 1xN grid (or Nx1
 * when vertical), which is what lets one set of range, bounds and stagger code
 * serve both.
 */
export function gridOf(node: MatrixNode | TokensNode): GridSpec {
  const { cellWidth, cellHeight } = node
  if (node.type === 'matrix') {
    return { rows: node.cells.length, cols: node.cells[0]?.length ?? 0, cellWidth, cellHeight }
  }
  const n = node.labels.length
  return node.orientation === 'row'
    ? { rows: 1, cols: n, cellWidth, cellHeight }
    : { rows: n, cols: 1, cellWidth, cellHeight }
}

/** Cell contents in row-major order — LaTeX for a matrix, labels for tokens. */
export function cellContents(node: MatrixNode | TokensNode): string[] {
  return node.type === 'matrix' ? node.cells.flat() : node.labels
}

/** Total extent of the grid in px, before the node's `scale`. */
export function gridSize(g: GridSpec): { width: number; height: number } {
  return { width: g.cols * g.cellWidth, height: g.rows * g.cellHeight }
}

/** Centre of cell (row `i`, column `j`), relative to the node's position. */
export function cellCenter(g: GridSpec, i: number, j: number): Vec2 {
  return {
    x: (j - (g.cols - 1) / 2) * g.cellWidth,
    y: (i - (g.rows - 1) / 2) * g.cellHeight,
  }
}

/**
 * Which cells a highlight or a reveal is talking about.
 *
 * Both bounds are **inclusive**, and an omitted axis means "all of it" — so
 * `{}` is the whole grid, `{rows: [1,1]}` is one row, `{cols: [0,2]}` is the
 * first three columns, and `{rows:[1,1], cols:[2,2]}` is a single cell. That is
 * the `row(i)` / `col(j)` / `cell(i,j)` / `range(...)` vocabulary from
 * plans/006, expressed as one shape rather than four.
 */
export interface CellRange {
  rows?: [number, number]
  cols?: [number, number]
}

export interface ResolvedRange {
  r0: number
  r1: number
  c0: number
  c1: number
}

/**
 * Clamp a range to the grid. Returns null when it selects nothing at all,
 * which callers treat as "draw no marker" rather than "mark everything" — a
 * highlight of a row that does not exist must not silently become a highlight
 * of the whole matrix.
 */
export function resolveRange(g: GridSpec, range: CellRange | undefined): ResolvedRange | null {
  if (g.rows <= 0 || g.cols <= 0) return null
  const [ra, rb] = range?.rows ?? [0, g.rows - 1]
  const [ca, cb] = range?.cols ?? [0, g.cols - 1]
  const r0 = Math.max(0, Math.min(ra, rb))
  const r1 = Math.min(g.rows - 1, Math.max(ra, rb))
  const c0 = Math.max(0, Math.min(ca, cb))
  const c1 = Math.min(g.cols - 1, Math.max(ca, cb))
  if (r1 < r0 || c1 < c0) return null
  return { r0, r1, c0, c1 }
}

/** Row-major index of cell (i, j) — the order cells are stored and revealed in. */
export function cellIndex(g: GridSpec, i: number, j: number): number {
  return i * g.cols + j
}

/** Every row-major index inside a range, in reading order. */
export function cellsInRange(g: GridSpec, range: CellRange | undefined): number[] {
  const r = resolveRange(g, range)
  if (!r) return []
  const out: number[] = []
  for (let i = r.r0; i <= r.r1; i++) {
    for (let j = r.c0; j <= r.c1; j++) out.push(cellIndex(g, i, j))
  }
  return out
}

/** Bounding box of a range, relative to the node's position. */
export function rangeBounds(
  g: GridSpec,
  range: CellRange | undefined,
): { x: number; y: number; width: number; height: number } | null {
  const r = resolveRange(g, range)
  if (!r) return null
  const topLeft = cellCenter(g, r.r0, r.c0)
  const bottomRight = cellCenter(g, r.r1, r.c1)
  return {
    x: (topLeft.x + bottomRight.x) / 2,
    y: (topLeft.y + bottomRight.y) / 2,
    width: (r.c1 - r.c0 + 1) * g.cellWidth,
    height: (r.r1 - r.r0 + 1) * g.cellHeight,
  }
}

/** Human-readable range, for tool responses: `row 1`, `cell (0,2)`, `all cells`. */
export function describeRange(range: CellRange | undefined): string {
  const rows = range?.rows
  const cols = range?.cols
  const one = (r: [number, number]) => (r[0] === r[1] ? `${r[0]}` : `${r[0]}–${r[1]}`)
  if (!rows && !cols) return 'all cells'
  if (rows && cols) {
    return rows[0] === rows[1] && cols[0] === cols[1]
      ? `cell (${rows[0]},${cols[0]})`
      : `rows ${one(rows)} × cols ${one(cols)}`
  }
  return rows ? `row${rows[0] === rows[1] ? '' : 's'} ${one(rows)}` : `col${cols![0] === cols![1] ? '' : 's'} ${one(cols!)}`
}
