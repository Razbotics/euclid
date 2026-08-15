import { z } from 'zod'
import { newId, op, type EuclidNode, type Track, type Transition, type Vec2 } from '@euclid/dsl'
import { COLOR, NODE_ID, NUMBERISH, PROJECT_ID, SCENE_ID } from './schemas'
import { capability, said, CapabilityError } from './types'

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
    }),
    async handler(ctx, { projectId, sceneId, tex, x, y, fontSize, color }) {
      const id = newId('eq')
      await ctx.submit(projectId, [
        op.addNode(sceneId, { ...baseNode({ x, y }), id, type: 'latex', tex, color, fontSize }),
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
    }),
    async handler(ctx, { projectId, sceneId, textContent, x, y, fontSize, fill, fontFamily }) {
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
        }),
      ])
      return said(`created text node ${id}`, { nodeId: id })
    },
  }),

  capability({
    name: 'add_shape',
    summary: 'Add a rect, circle or line.',
    doc: 'Rect and circle anchor at their centre; a line\'s `x2`/`y2` are relative to its position, so a line at (100, 100) with x2=200 ends at (300, 100).',
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
      fill: COLOR.default('#58c4dd'),
      stroke: COLOR.optional(),
      strokeWidth: z.number().min(0).default(4),
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
          fill: a.fill,
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
          fill: a.fill,
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
          stroke: a.stroke ?? a.fill,
          strokeWidth: Math.max(1, a.strokeWidth),
        }
      }
      await ctx.submit(a.projectId, [op.addNode(a.sceneId, node)])
      return said(`created ${a.shape} node ${id}`, { nodeId: id })
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
    }),
    async handler(ctx, { projectId, sceneId, points, x, y, stroke, strokeWidth, closed, fill }) {
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
        }),
      ])
      return said(`created path node ${id} (${points.length} points)`, {
        nodeId: id,
        points: points.length,
      })
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
