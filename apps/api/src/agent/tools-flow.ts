import { z } from 'zod'
import {
  newId,
  op,
  type ArrowEnd,
  type ArrowNode,
  type Easing,
  type EuclidNode,
  type Transition,
} from '@euclid/dsl'
import { pathLength } from '@euclid/engine'
import { COLOR, EASING, NODE_ID, NUMBERISH, PROJECT_ID, SCENE_ID, SECONDS } from './schemas'
import { baseNode } from './tools-node'
import { capability, said, CapabilityError } from './types'

/** Either end: a node id to track, or a fixed point. */
const END = z.union([
  z.string().min(1),
  z.object({ x: NUMBERISH, y: NUMBERISH }),
])

function toEnd(v: string | { x: number; y: number }): ArrowEnd {
  return typeof v === 'string' ? { node: v } : { at: v }
}

/** Nodes an arrow or a follower names must actually be there. */
function requireNode(find: (id: string) => EuclidNode | null, id: string, role: string): EuclidNode {
  const node = find(id)
  if (!node) {
    throw new CapabilityError(
      `${role} node ${id} does not exist in this scene. Arrows and flows are resolved every ` +
        `frame from the nodes they name, so the id has to be one that is really there.`,
    )
  }
  return node
}

export const flowTools = [
  capability({
    name: 'connect',
    summary: 'Draw an arrow between two nodes. It tracks them as they move.',
    doc: [
      '**Anchored, not positioned.** Give it two node ids and the arrow recomputes its own endpoints every frame from where those nodes actually are — animate either one and the connection follows instead of being left behind. That is the whole difference between this and drawing a line.',
      '',
      'It stops at the **edge** of what it points at, not the centre, with `gap` px of clearance. Extents are exact for shapes, matrices and token strips, and estimated from font size for text and LaTeX — if a head crowds an equation, raise `gap`.',
      '',
      'Either end also takes a fixed point as `{"x":…,"y":…}` when there is nothing to anchor to.',
      '',
      '`curve` bows it sideways as a fraction of the distance: 0 is straight, ±0.2 is a gentle arc, and two arrows between the same pair with opposite curves separate instead of overlapping. The head follows the curve\'s own tangent, so it meets its target square.',
      '',
      'The arrow ignores its own rotation — the endpoints define it — and `write_on` grows it out of its source. If either node is deleted the arrow simply stops drawing rather than pointing at the origin.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      from: END.describe('node id to start from, or {"x":…,"y":…}'),
      to: END.describe('node id to point at, or {"x":…,"y":…}'),
      stroke: COLOR.default('#c9ced4'),
      strokeWidth: z.number().positive().default(5),
      headSize: z.number().min(0).default(26),
      curve: z.number().default(0).describe('sideways bow as a fraction of the distance; 0 is straight'),
      gap: z.number().min(0).default(14).describe('clearance from the edge of an anchored node'),
    }),
    async handler(ctx, { projectId, sceneId, from, to, stroke, strokeWidth, headSize, curve, gap }) {
      const { doc } = await ctx.getDoc(projectId)
      const scene = ctx.sceneOrThrow(doc, sceneId)
      const find = (id: string) => findIn(scene.nodes, id)
      if (typeof from === 'string') requireNode(find, from, 'from')
      if (typeof to === 'string') requireNode(find, to, 'to')
      if (typeof from === 'string' && from === to) {
        throw new CapabilityError('an arrow from a node to itself has no direction to point in')
      }

      const id = newId('arw')
      const node: ArrowNode = {
        ...baseNode({ x: 0, y: 0 }),
        id,
        type: 'arrow',
        from: toEnd(from),
        to: toEnd(to),
        stroke,
        strokeWidth,
        headSize,
        curve,
        gap,
      }
      await ctx.submit(projectId, [op.addNode(sceneId, node)])
      const name = (v: string | { x: number; y: number }) =>
        typeof v === 'string' ? v : `(${v.x},${v.y})`
      return said(
        `connected ${name(from)} → ${name(to)} as ${id}` +
          (curve ? ` (curve ${curve})` : '') +
          (typeof from === 'string' || typeof to === 'string'
            ? ' — it will follow them if they move'
            : ''),
        { nodeId: id },
      )
    },
  }),

  capability({
    name: 'flow_along',
    summary: 'Send a node travelling along a path node, by arc length.',
    doc: [
      'The flow half of a diagram: a token, a dot, a label riding a curve from one place to another. One call instead of a keyframe per bend.',
      '',
      'Travel is by **arc length**, so it moves at a steady speed along the curve rather than lurching between sample points. `orient: true` turns the node to face the direction of travel — right for an arrowhead or a label following a wire, wrong for a number you still want to read.',
      '',
      '**It overrides the node\'s position from `start` onward.** Before `start` the node is wherever it normally would be, so put it at the head of the path (or start the flow there) unless you want it to jump. A `position` track on the same node loses to this, which is the opposite of the usual rule and the reason the response says so.',
      '',
      'The path is an ordinary `path` node — from add_path or plot_function — and can be invisible: give it `strokeWidth` and a colour that matches the background if you only want the trajectory, not the line.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      nodeId: NODE_ID.describe('the node that travels'),
      pathId: NODE_ID.describe('a path node to travel along'),
      start: SECONDS,
      duration: z.number().positive().default(2),
      easing: EASING,
      orient: z.boolean().default(false).describe('turn to face the direction of travel'),
    }),
    async handler(ctx, { projectId, sceneId, nodeId, pathId, start, duration, easing, orient }) {
      const { doc } = await ctx.getDoc(projectId)
      const scene = ctx.sceneOrThrow(doc, sceneId)
      const node = ctx.nodeOrThrow(doc, sceneId, nodeId)
      const path = findIn(scene.nodes, pathId)
      if (!path) {
        throw new CapabilityError(
          `path node ${pathId} does not exist in this scene — add one with add_path or plot_function`,
        )
      }
      if (path.type !== 'path') {
        throw new CapabilityError(
          `${pathId} is a ${path.type}, not a path. A flow needs a path node to travel along; ` +
            `add_path takes the points and plot_function produces them from a formula.`,
        )
      }
      if (nodeId === pathId) throw new CapabilityError('a path cannot travel along itself')

      const transitions: Transition[] = [
        ...node.transitions.filter((t) => t.type !== 'follow'),
        { type: 'follow', start, duration, pathId, easing: easing as Easing, orient },
      ]
      await ctx.submit(projectId, [op.updateNode(sceneId, nodeId, { transitions })])
      const tracked = node.tracks.some((t) => t.property === 'position')
      const length = pathLength(path.points, path.closed)
      return said(
        `${nodeId} flows along ${pathId} (${Math.round(length)}px) over ` +
          `[${start}s, ${start + duration}s]${orient ? ', facing the way it travels' : ''}` +
          (tracked
            ? ` — NOTE ${nodeId} also has a position track, and the flow wins from ${start}s onward`
            : ''),
        { nodeId, pathId, start, duration, length },
      )
    },
  }),
]

function findIn(nodes: EuclidNode[], id: string): EuclidNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    if (n.type === 'group') {
      const hit = findIn(n.children, id)
      if (hit) return hit
    }
  }
  return null
}
