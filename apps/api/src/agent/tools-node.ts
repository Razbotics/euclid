import { z } from 'zod'
import {
  newId,
  op,
  samplePlot,
  type EuclidNode,
  type Track,
  type Transition,
  type Vec2,
} from '@euclid/dsl'
import { COLOR, NODE_ID, NUMBERISH, PROJECT_ID, SCENE_ID } from './schemas'
import { capability, said, CapabilityError } from './types'

/**
 * Attach a new node to a group instead of the scene root.
 *
 * The hierarchy has always existed in the document and the renderer — groups
 * compose transforms like any scene graph — but nothing exposed it, so a dot
 * riding a rotating radius had to be keyframed chord by chord. Run 5 spent
 * roughly 60% of its calls on exactly that.
 */
const PARENT_ID = z
  .string()
  .optional()
  .describe('id of a group to add this into; omitted = the scene root')

/** A colour, or `none` for an unfilled outline. */
const FILLABLE = z.union([COLOR, z.literal('none')])

/** Defaults every node carries, so a caller only supplies what it cares about. */
export const baseNode = (position: Vec2) => ({
  position,
  scale: 1,
  rotation: 0,
  opacity: 1,
  tracks: [] as Track[],
  transitions: [] as Transition[],
})

export const nodeTools = [
  capability({
    name: 'add_latex',
    summary: 'Add a LaTeX equation node, anchored at its centre.',
    doc: 'Rendered as real typeset maths. Anchored at its centre, so (960, 540) centres it on a 1920x1080 canvas. The returned node id is what morph_latex, highlight and animate take. Escape backslashes as your transport requires — the equation must arrive as e.g. \\frac{b}{a}.',
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      tex: z.string().min(1),
      x: z.number(),
      y: z.number(),
      fontSize: z.number().positive().default(64),
      color: COLOR.default('#ffffff'),
      parentId: PARENT_ID,
    }),
    async handler(ctx, { projectId, sceneId, tex, x, y, fontSize, color, parentId }) {
      const id = newId('eq')
      await ctx.submit(projectId, [
        op.addNode(sceneId, { ...baseNode({ x, y }), id, type: 'latex', tex, color, fontSize }, parentId),
      ])
      return said(`created latex node ${id}`, { nodeId: id })
    },
  }),

  capability({
    name: 'add_text',
    summary: 'Add a text node, anchored at its centre.',
    doc: 'Plain prose — titles, labels, captions burned into the frame. For anything mathematical prefer add_latex, which typesets properly. Anchored at its centre.',
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      textContent: z.string(),
      x: z.number(),
      y: z.number(),
      fontSize: z.number().positive().default(48),
      fill: COLOR.default('#ffffff'),
      fontFamily: z.string().default('Georgia, serif'),
      parentId: PARENT_ID,
    }),
    async handler(ctx, { projectId, sceneId, textContent, x, y, fontSize, fill, fontFamily, parentId }) {
      const id = newId('txt')
      await ctx.submit(projectId, [
        op.addNode(sceneId, {
          ...baseNode({ x, y }),
          id,
          type: 'text',
          text: textContent,
          fontSize,
          fill,
          fontFamily,
        }, parentId),
      ])
      return said(`created text node ${id}`, { nodeId: id })
    },
  }),

  capability({
    name: 'add_shape',
    summary: 'Add a rect, circle or line.',
    doc: [
      'Rect and circle anchor at their centre; a line\'s `x2`/`y2` are relative to its position, so a line at (100, 100) with x2=200 ends at (300, 100).',
      '',
      'Pass `fill: "none"` with a `stroke` for an outline or a ring. Do **not** fill with the background colour to fake it — that paints an opaque disc which hides whatever is behind it and breaks the moment the background is not flat.',
      '',
      'Note a line stores `from`/`to`, not the `x2`/`y2` you create it with, so `update_node` on a line takes `{"to":{"x":…,"y":…}}`. A line has no `width` either — animating its length means animating `to`.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      shape: z.enum(['rect', 'circle', 'line']),
      x: z.number(),
      y: z.number(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      radius: z.number().positive().optional(),
      x2: z.number().optional().describe('line end x, relative to position'),
      y2: z.number().optional().describe('line end y, relative to position'),
      fill: FILLABLE.default('#58c4dd').describe('"none" for an outline/ring'),
      stroke: COLOR.optional(),
      strokeWidth: z.number().min(0).default(4),
      parentId: PARENT_ID,
    }),
    async handler(ctx, a) {
      const id = newId(a.shape)
      let node: EuclidNode
      if (a.shape === 'rect') {
        node = {
          ...baseNode({ x: a.x, y: a.y }),
          id,
          type: 'rect',
          width: a.width ?? 200,
          height: a.height ?? 120,
          ...(a.fill === 'none' ? {} : { fill: a.fill }),
          cornerRadius: 0,
          stroke: a.stroke,
          strokeWidth: a.strokeWidth,
        }
      } else if (a.shape === 'circle') {
        node = {
          ...baseNode({ x: a.x, y: a.y }),
          id,
          type: 'circle',
          radius: a.radius ?? 80,
          ...(a.fill === 'none' ? {} : { fill: a.fill }),
          stroke: a.stroke,
          strokeWidth: a.strokeWidth,
        }
      } else {
        node = {
          ...baseNode({ x: a.x, y: a.y }),
          id,
          type: 'line',
          from: { x: 0, y: 0 },
          to: { x: a.x2 ?? 100, y: a.y2 ?? 0 },
          // A line has no fill, so `none` must not become its colour.
          stroke: a.stroke ?? (a.fill === 'none' ? '#58c4dd' : a.fill),
          strokeWidth: Math.max(1, a.strokeWidth),
        }
      }
      await ctx.submit(a.projectId, [op.addNode(a.sceneId, node, a.parentId)])
      return said(
        `created ${a.shape} node ${id}${a.parentId ? ` inside ${a.parentId}` : ''}`,
        { nodeId: id },
      )
    },
  }),

  capability({
    name: 'add_group',
    summary: 'Create a group; children move, rotate and scale with it.',
    doc: [
      'A container with its own position, rotation, scale and opacity. Anything created with `parentId` set to this group inherits that transform.',
      '',
      '**This is how you make one thing carry another.** A dot riding the end of a spinning radius is a group at the circle\'s centre, with the radius line and the dot inside it, and a single `animate` on the group\'s `rotation`. Without it the same motion is a keyframe per step with hand-computed cos/sin — a real run spent roughly 60% of its tool calls that way.',
      '',
      'Children\'s coordinates are **relative to the group\'s position**, so a dot at radius 200 sits at (200, 0) inside a group centred on the circle, whatever the group later does.',
      '',
      'Rotation is in radians and turns about the group\'s own position, so put the group where the pivot is. Groups nest.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      x: z.number().describe('the pivot: children rotate about this point'),
      y: z.number(),
      parentId: PARENT_ID,
    }),
    async handler(ctx, { projectId, sceneId, x, y, parentId }) {
      const id = newId('grp')
      await ctx.submit(projectId, [
        op.addNode(sceneId, { ...baseNode({ x, y }), id, type: 'group', children: [] }, parentId),
      ])
      return said(
        `created group ${id} at (${x}, ${y})${parentId ? ` inside ${parentId}` : ''} — ` +
          `add children with parentId: "${id}", then animate ${id}.rotation to carry them`,
        { nodeId: id },
      )
    },
  }),

  capability({
    name: 'add_path',
    summary: 'Add a curve through a list of points — one node, not one line per segment.',
    doc: [
      'A polyline through `points`, which are **relative to** `x`/`y`. Use it for anything a straight `line` cannot express: a plotted function, an arc, an outline.',
      '',
      'Sample the curve as finely as you like — 40 points costs the same to render as 4 and reads as smooth. This is one node, so it moves, fades and reveals as a single thing; the previous alternative was one `line` node per segment, which in a real run made a parabola 9 of a scene\'s 22 nodes and had to be re-laid nine times when the scale changed.',
      '',
      '`write_on` a path draws it **along its length**, like drawing the curve by hand, rather than sweeping a mask across it — so a steep section does not appear all at once. That is the usual way to bring a curve on.',
      '',
      'Set `closed` to join the last point to the first, and `fill` to fill it (a plotted curve normally wants neither). A partially drawn path is never filled — the fill appears once it is whole.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      points: z
        .array(z.object({ x: NUMBERISH, y: NUMBERISH }))
        .min(2)
        .max(2000)
        .describe('points relative to x/y, in order'),
      x: z.number().default(0).describe('origin the points are relative to'),
      y: z.number().default(0),
      stroke: COLOR.default('#58c4dd'),
      strokeWidth: z.number().positive().default(4),
      closed: z.boolean().default(false),
      fill: COLOR.optional(),
      parentId: PARENT_ID,
    }),
    async handler(ctx, { projectId, sceneId, points, x, y, stroke, strokeWidth, closed, fill, parentId }) {
      const id = newId('path')
      await ctx.submit(projectId, [
        op.addNode(sceneId, {
          ...baseNode({ x, y }),
          id,
          type: 'path',
          points,
          stroke,
          strokeWidth,
          closed,
          ...(fill ? { fill } : {}),
        }, parentId),
      ])
      return said(`created path node ${id} (${points.length} points)`, {
        nodeId: id,
        points: points.length,
      })
    },
  }),

  capability({
    name: 'plot_function',
    summary: 'Plot y = f(x) into a rectangle — one path node, and it tells you the mapping.',
    doc: [
      'Samples an expression over a domain and draws it as a single `path` node. Free.',
      '',
      '`expression` uses `x` as the variable: `x^2`, `sin(x)/x`, `exp(-x^2)`. Write multiplication explicitly (`2*x`, not `2x`). Functions available: sin cos tan asin acos atan sinh cosh tanh exp ln log sqrt abs sign floor ceil round; constants `pi` and `e`.',
      '',
      '**It returns the mapping, and you should use it.** `originScreen` is where function-space (0,0) lands on the canvas, and `scale` is pixels per unit on each axis. To put anything else in the same coordinate system — a point on the curve, a tangent, an axis label — compute `screenX = originScreen.x + u * scale.x` and `screenY = originScreen.y - v * scale.y` (canvas y grows *downward*, which is the usual thing to get wrong). Deriving your own transform instead is how a curve and the point that is supposed to sit on it end up disagreeing.',
      '',
      'By default the y range is **fitted** to what the function does over the domain, so the curve fills the rectangle. That is usually what you want: a real run plotted x² with equal scales on both axes and the secant line visually hugged the curve, destroying the contrast the video existed to teach. Pass `uniform: true` when true geometric proportion matters (a circle should look round), or `range` to fix it yourself. The range actually used is always reported back.',
      '',
      'Points where the function is undefined (`1/x` at 0, `sqrt` of a negative) are skipped and counted, rather than breaking the curve.',
      '',
      'Combine with `write_on` to draw the curve along its length.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      expression: z.string().min(1).describe('in terms of x, e.g. "x^2"'),
      xMin: NUMBERISH,
      xMax: NUMBERISH,
      /** The canvas rectangle to draw into: top-left plus size. */
      x: z.number().describe('left edge of the plot area, canvas px'),
      y: z.number().describe('top edge of the plot area, canvas px'),
      width: z.number().positive(),
      height: z.number().positive(),
      samples: z.number().int().min(2).max(2000).default(120),
      yMin: NUMBERISH.optional().describe('fitted to the function when omitted'),
      yMax: NUMBERISH.optional(),
      uniform: z.boolean().default(false).describe('equal px per unit on both axes'),
      stroke: COLOR.default('#58c4dd'),
      strokeWidth: z.number().positive().default(4),
      parentId: PARENT_ID,
    }),
    async handler(ctx, a) {
      const hasRange = a.yMin !== undefined && a.yMax !== undefined
      if ((a.yMin === undefined) !== (a.yMax === undefined)) {
        throw new CapabilityError('give both yMin and yMax, or neither (the range is fitted)')
      }
      let plot
      try {
        plot = samplePlot({
          expression: a.expression,
          domain: [a.xMin, a.xMax],
          rect: { x: a.x, y: a.y, width: a.width, height: a.height },
          samples: a.samples,
          range: hasRange ? [a.yMin!, a.yMax!] : undefined,
          uniform: a.uniform,
        })
      } catch (e) {
        // The parser's messages already name the fix (unknown function, implicit
        // multiplication), so they are surfaced rather than replaced.
        throw new CapabilityError(`could not plot "${a.expression}": ${(e as Error).message}`)
      }

      const id = newId('plot')
      await ctx.submit(a.projectId, [
        op.addNode(a.sceneId, {
          // Points are absolute canvas coordinates, so the node sits at the
          // origin — which also makes `originScreen` directly usable for
          // placing anything else, with no second transform to keep in step.
          ...baseNode({ x: 0, y: 0 }),
          id,
          type: 'path',
          points: plot.points,
          stroke: a.stroke,
          strokeWidth: a.strokeWidth,
          closed: false,
        }, a.parentId),
      ])

      const [lo, hi] = plot.range
      return said(
        `plotted "${a.expression}" as ${id} — ${plot.points.length} points over ` +
          `x ∈ [${a.xMin}, ${a.xMax}], y ∈ [${lo.toFixed(3)}, ${hi.toFixed(3)}]` +
          `${hasRange ? '' : ' (fitted)'}.\n` +
          `Mapping: function (0,0) is at canvas (${plot.originScreen.x.toFixed(1)}, ` +
          `${plot.originScreen.y.toFixed(1)}); ${plot.scale.x.toFixed(2)} px per x-unit, ` +
          `${plot.scale.y.toFixed(2)} px per y-unit.\n` +
          `Place anything else on this curve with screenX = ${plot.originScreen.x.toFixed(1)} ` +
          `+ u * ${plot.scale.x.toFixed(2)}, screenY = ${plot.originScreen.y.toFixed(1)} ` +
          `− v * ${plot.scale.y.toFixed(2)}.` +
          (plot.dropped
            ? `\n${plot.dropped} sample(s) skipped where the function is undefined.`
            : ''),
        { nodeId: id, ...plot },
      )
    },
  }),

  capability({
    name: 'update_node',
    summary: 'Shallow-patch node properties (id/type immutable).',
    doc: [
      'Two traps, both of which have cost a milestone run, and both of which this now reports rather than swallowing:',
      '',
      '1. **Position is nested.** `{"position":{"x":100,"y":200}}` — not the top-level `x`/`y` that add_text/add_latex accept. A patch naming a property the node does not have is now REJECTED, not silently stripped.',
      '2. **A keyframed property ignores you.** If an animation keyframes the property you patch, the document changes but the render does not — the track wins. The result says so. Use `animate` instead, or clear the track first.',
      '',
      'Invalid patches are rejected atomically: nothing is applied.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      nodeId: NODE_ID,
      patch: z
        .record(z.string(), z.any())
        .describe('properties to set, e.g. {"position":{"x":960,"y":540}}'),
    }),
    async handler(ctx, { projectId, sceneId, nodeId, patch }) {
      if (Object.keys(patch).length === 0) throw new CapabilityError('patch is empty')
      // Read before the write, so the warning describes the node as the caller
      // found it.
      const { doc } = await ctx.getDoc(projectId)
      const node = ctx.nodeOrThrow(doc, sceneId, nodeId)

      if ('id' in patch || 'type' in patch) {
        // The reducer skips these silently; saying so is more useful than
        // letting the caller believe a rename happened.
        throw new CapabilityError('id and type are immutable; remove them from the patch')
      }
      // A patch naming a property the node type does not have is rejected by
      // the reducer, which compares what it assigned against what survived the
      // schema — that check belongs there, next to NodeSchema, rather than
      // being reimplemented here against the instance (where an unset optional
      // like `stroke` would look nonexistent).

      const shadowed = Object.keys(patch).filter((k) => node.tracks.some((t) => t.property === k))
      await ctx.submit(projectId, [op.updateNode(sceneId, nodeId, patch)])
      if (shadowed.length === 0) {
        return said(`updated ${nodeId}: ${Object.keys(patch).join(', ')}`, { nodeId, patch })
      }
      // The document really did change — which is why this is easy to miss:
      // get_scene confirms the new value while the render ignores it.
      return said(
        `updated ${nodeId}, but ${shadowed.join(', ')} ${shadowed.length > 1 ? 'are' : 'is'} ` +
          `animated on this node, so the keyframes override the value you just set and nothing ` +
          `will look different. get_scene will show your value; the render will not use it. ` +
          `Animate ${shadowed.join('/')} instead, or clear the track first.`,
        { nodeId, patch, shadowed },
      )
    },
  }),

  capability({
    name: 'remove_node',
    summary: 'Delete a node from a scene.',
    doc: 'Removes the node and everything attached to it — tracks and transitions go with it. Not undoable through this surface (the event log keeps the history, but there is no revert capability).',
    args: z.object({ projectId: PROJECT_ID, sceneId: SCENE_ID, nodeId: NODE_ID }),
    async handler(ctx, { projectId, sceneId, nodeId }) {
      const { doc } = await ctx.getDoc(projectId)
      ctx.nodeOrThrow(doc, sceneId, nodeId)
      await ctx.submit(projectId, [op.removeNode(sceneId, nodeId)])
      return said(`removed ${nodeId}`, { nodeId })
    },
  }),
]
