import { z } from 'zod'
import {
  describeRange,
  gridOf,
  gridSize,
  newId,
  op,
  resolveRange,
  type CellRange,
  type Easing,
  type MatrixNode,
  type Transition,
} from '@euclid/dsl'
import { COLOR, EASING, NODE_ID, PROJECT_ID, SCENE_ID, SECONDS } from './schemas'
import { baseNode } from './tools-node'
import { capability, said, CapabilityError } from './types'

const PARENT_ID = z
  .string()
  .optional()
  .describe('id of a group to add this into; omitted = the scene root')

/**
 * One index or an inclusive span, so `1` and `[0,2]` both work.
 *
 * The nested-tuple form alone would be the `{"position":{...}}` trap again: an
 * agent asking for row 1 writes `rows: 1`, which is the obvious guess and would
 * otherwise be an argument error at best.
 */
const INDEX_OR_SPAN = z
  .union([z.number().int().min(0), z.tuple([z.number().int().min(0), z.number().int().min(0)])])
  .transform((v): [number, number] => (typeof v === 'number' ? [v, v] : v))

export const CELLS_ARG = z
  .object({ rows: INDEX_OR_SPAN.optional(), cols: INDEX_OR_SPAN.optional() })
  .describe('cells to target: {"rows":1} a row, {"cols":2} a column, {"rows":1,"cols":2} one cell, {"rows":[0,1]} a band')

/** Row-major grid of LaTeX strings. */
const CELLS = z
  .array(z.array(z.string()).min(1))
  .min(1)
  .describe('row-major, e.g. [["a","b"],["c","d"]]; "" is an empty cell')

/**
 * A range that names cells the node does not have is rejected rather than
 * clamped. Clamping would mark *something*, which looks like it worked — the
 * same class of failure as a patch whose keys get stripped.
 */
export function checkRange(
  node: { type: string },
  grid: { rows: number; cols: number },
  cells: CellRange | undefined,
  nodeId: string,
): void {
  if (!cells) return
  const bad = (axis: 'rows' | 'cols', span: [number, number], limit: number) => {
    if (span[0] >= limit || span[1] >= limit) {
      throw new CapabilityError(
        `${axis === 'rows' ? 'row' : 'column'} ${span[0] === span[1] ? span[0] : span.join('–')} ` +
          `is outside ${nodeId}, which is ${grid.rows}x${grid.cols} — indices are 0-based, ` +
          `so the last ${axis === 'rows' ? 'row' : 'column'} is ${limit - 1}.`,
      )
    }
  }
  if (cells.rows) bad('rows', cells.rows, grid.rows)
  if (cells.cols) bad('cols', cells.cols, grid.cols)
  if (!resolveRange({ ...grid, cellWidth: 1, cellHeight: 1 }, cells)) {
    throw new CapabilityError(`that range selects no cells of ${nodeId}`)
  }
}

export const gridTools = [
  capability({
    name: 'add_matrix',
    summary: 'Add a matrix: a grid of LaTeX cells, addressable by row and column.',
    doc: [
      'One node, not a grid of hand-placed equations. That is the point: `highlight` can mark row 1 or cell (0,2) without anyone working out where they landed, `morph_matrix` can restate the grid and move the cells that stayed the same, and `write_on` fills it in cell by cell.',
      '',
      'Cells sit on a **fixed pitch** and are centred in their boxes — nothing is measured, so columns line up and layout does not depend on how wide `\\alpha` happens to render. The flip side is that a wide entry can overflow its cell: the response reports the resulting size, and preview_frames shows the overlap. Raise `cellWidth` if it collides.',
      '',
      'Indices are **0-based**: the top-left cell is (0,0). Anchored at its centre, like every node, so (960, 540) centres it on a 1920x1080 canvas.',
      '',
      'Change contents later with update_node `{"cells": [[...]]}` — instant, no animation — or with morph_matrix, which moves what stayed.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      cells: CELLS,
      x: z.number(),
      y: z.number(),
      fontSize: z.number().positive().default(48),
      cellWidth: z.number().positive().optional().describe('column pitch in px; default fontSize x 2.4'),
      cellHeight: z.number().positive().optional().describe('row pitch in px; default fontSize x 1.8'),
      color: COLOR.default('#ffffff'),
      brackets: z.enum(['square', 'paren', 'none']).default('square'),
      parentId: PARENT_ID,
    }),
    async handler(ctx, args) {
      const { projectId, sceneId, cells, x, y, fontSize, color, brackets, parentId } = args
      const width = cells[0]!.length
      if (cells.some((r) => r.length !== width)) {
        throw new CapabilityError(
          `every row must have the same number of cells; got ${cells.map((r) => r.length).join(', ')}`,
        )
      }
      const cellWidth = args.cellWidth ?? fontSize * 2.4
      const cellHeight = args.cellHeight ?? fontSize * 1.8
      const id = newId('mat')
      const node: MatrixNode = {
        ...baseNode({ x, y }),
        id,
        type: 'matrix',
        cells,
        cellWidth,
        cellHeight,
        fontSize,
        color,
        brackets,
      }
      await ctx.submit(projectId, [op.addNode(sceneId, node, parentId)])
      const size = gridSize(gridOf(node))
      return said(
        `created matrix ${id}: ${cells.length}x${width}, ${size.width}x${size.height}px ` +
          `centred at (${x}, ${y}) — rows 0..${cells.length - 1}, cols 0..${width - 1}`,
        { nodeId: id, rows: cells.length, cols: width, ...size },
      )
    },
  }),

  capability({
    name: 'add_tokens',
    summary: 'Add a labelled strip — words or indices in a row or column, optionally boxed.',
    doc: [
      'The thing a sequence is made of: words of a sentence, layer names, indices. Labels render as **text**, not typeset maths, so a token reads as `cat` rather than as italic mathematical variables.',
      '',
      'Addressed the same way a matrix is, with the strip as a 1xN grid (or Nx1 when vertical): `highlight` with `{"cols":2}` marks the third token of a row, `{"rows":2}` the third of a column. `write_on` reveals them one at a time.',
      '',
      'Boxes are optional: give `boxStroke` for outlines, `boxFill` for filled chips, neither for bare labels.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      labels: z.array(z.string().min(1)).min(1),
      x: z.number(),
      y: z.number(),
      orientation: z.enum(['row', 'column']).default('row'),
      fontSize: z.number().positive().default(40),
      cellWidth: z.number().positive().optional().describe('pitch along a row; default fontSize x 4'),
      cellHeight: z.number().positive().optional().describe('pitch down a column; default fontSize x 1.8'),
      color: COLOR.default('#ffffff'),
      fontFamily: z.string().default('Georgia, serif'),
      boxStroke: COLOR.optional(),
      boxFill: COLOR.optional(),
      parentId: PARENT_ID,
    }),
    async handler(ctx, args) {
      const { projectId, sceneId, labels, x, y, orientation, fontSize, color, fontFamily, parentId } =
        args
      const cellWidth = args.cellWidth ?? fontSize * 4
      const cellHeight = args.cellHeight ?? fontSize * 1.8
      const id = newId('tok')
      const node = {
        ...baseNode({ x, y }),
        id,
        type: 'tokens' as const,
        labels,
        orientation,
        cellWidth,
        cellHeight,
        fontSize,
        color,
        fontFamily,
        ...(args.boxStroke ? { boxStroke: args.boxStroke } : {}),
        ...(args.boxFill ? { boxFill: args.boxFill } : {}),
      }
      await ctx.submit(projectId, [op.addNode(sceneId, node, parentId)])
      const size = gridSize(gridOf(node))
      const axis = orientation === 'row' ? 'cols' : 'rows'
      return said(
        `created tokens ${id}: ${labels.length} ${orientation === 'row' ? 'across' : 'down'}, ` +
          `${size.width}x${size.height}px centred at (${x}, ${y}) — address them with ` +
          `{"${axis}": 0..${labels.length - 1}}`,
        { nodeId: id, count: labels.length, ...size },
      )
    },
  }),

  capability({
    name: 'morph_matrix',
    summary: 'Restate a matrix: cells that survive move, only new or gone ones fade.',
    doc: [
      'The matrix counterpart of morph_latex, and the same idea underneath — cells are matched by their **contents**, in order, so a grid that gains a column or has one entry replaced keeps everything else visibly still.',
      '',
      'The shape may change. Growing a 2x2 into a 2x3 moves the six surviving cells into their new places and fades the new ones in; the brackets grow with it.',
      '',
      'Sequential morphs on one matrix chain in start-time order, and a call whose window **overlaps** an existing morph replaces it — re-calling revises rather than stacks.',
      '',
      'For an instant change with no motion, patch the node instead: update_node `{"cells": [[...]]}`.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      nodeId: NODE_ID,
      toCells: CELLS,
      start: SECONDS,
      duration: z.number().positive().default(1.5),
      easing: EASING,
    }),
    async handler(ctx, { projectId, sceneId, nodeId, toCells, start, duration, easing }) {
      const { doc } = await ctx.getDoc(projectId)
      const node = ctx.nodeOrThrow(doc, sceneId, nodeId)
      if (node.type !== 'matrix') {
        throw new CapabilityError(
          `${nodeId} is a ${node.type}, not a matrix — only matrix nodes can morph cells` +
            (node.type === 'latex' ? '. For an equation, use morph_latex.' : ''),
        )
      }
      const width = toCells[0]!.length
      if (toCells.some((r) => r.length !== width)) {
        throw new CapabilityError(
          `every row must have the same number of cells; got ${toCells.map((r) => r.length).join(', ')}`,
        )
      }
      const outside = (t: Transition) =>
        t.start + t.duration <= start || start + duration <= t.start
      const replaced = node.transitions.filter(
        (t) => t.type === 'cellMorph' && !outside(t),
      ).length
      const transitions: Transition[] = [
        ...node.transitions.filter((t) => t.type !== 'cellMorph' || outside(t)),
        { type: 'cellMorph', start, duration, toCells, easing: easing as Easing },
      ]
      await ctx.submit(projectId, [op.updateNode(sceneId, nodeId, { transitions })])
      return said(
        `morphing ${nodeId} → ${toCells.length}x${width} over [${start}s, ${start + duration}s]` +
          (replaced ? ` (replaced ${replaced} overlapping morph${replaced > 1 ? 's' : ''})` : ''),
        { nodeId, rows: toCells.length, cols: width, start, duration, replaced },
      )
    },
  }),
]

/** Shared with tools-anim's highlight, which addresses cells the same way. */
export function gridOrThrow(
  node: { type: string },
  nodeId: string,
): { rows: number; cols: number } {
  if (node.type !== 'matrix' && node.type !== 'tokens') {
    throw new CapabilityError(
      `cells targeting only works on matrix and tokens nodes; ${nodeId} is a ${node.type}. ` +
        `Omit cells to highlight the whole node` +
        (node.type === 'latex' ? ', or use tex to name a sub-expression.' : '.'),
    )
  }
  const g = gridOf(node as Parameters<typeof gridOf>[0])
  return { rows: g.rows, cols: g.cols }
}
