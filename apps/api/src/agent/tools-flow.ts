import { z } from 'zod'
import {
  LIMITS,
  newId,
  op,
  type ArrowEnd,
  type ArrowNode,
  type Easing,
  type EuclidNode,
  type Transition,
} from '@euclid/dsl'
import { describeRange } from '@euclid/dsl'
import { pathLength } from '@euclid/engine'
import { COLOR, EASING, NODE_ID, NUMBERISH, PROJECT_ID, SCENE_ID, SECONDS } from './schemas'
import { CELLS_ARG, checkRange, gridOrThrow } from './tools-grid'
import { baseNode } from './tools-node'
import { capability, said, CapabilityError } from './types'

/** Either end: a node id, one part of a grid, or a fixed point. */
const END = z.union([
  z.string().min(1),
  z.object({ node: z.string().min(1), cells: CELLS_ARG }),
  z.object({ x: NUMBERISH, y: NUMBERISH }),
])
type EndArg = z.infer<typeof END>

function toEnd(v: EndArg): ArrowEnd {
  if (typeof v === 'string') return { node: v }
  return 'node' in v ? { node: v.node, cells: v.cells } : { at: v }
}

/** Name for a response line: the id, the cell, or the point. */
function endName(v: EndArg): string {
  if (typeof v === 'string') return v
  return 'node' in v ? `${describeRange(v.cells)} of ${v.node}` : `(${v.x},${v.y})`
}

/** The node id an end refers to, if it refers to one at all. */
function endNode(v: EndArg): string | null {
  if (typeof v === 'string') return v
  return 'node' in v ? v.node : null
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
      'Either end also takes **one part of a grid** — `{"node":"tok_x","cells":{"cols":2}}` points at the third token of a strip, or one cell of a matrix, and tracks that cell rather than the middle of the whole thing. And a fixed point as `{"x":…,"y":…}` when there is nothing to anchor to.',
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
      const fromId = endNode(from)
      const toId = endNode(to)
      // A cell range that names cells the node does not have is rejected here,
      // not clamped: an arrow to a plausible-but-wrong cell looks right.
      for (const [end, id, role] of [
        [from, fromId, 'from'],
        [to, toId, 'to'],
      ] as const) {
        if (!id) continue
        const node = requireNode(find, id, role)
        if (typeof end !== 'string' && 'cells' in end) {
          checkRange(node, gridOrThrow(node, id), end.cells, id)
        }
      }
      if (fromId && fromId === toId && JSON.stringify(from) === JSON.stringify(to)) {
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
      return said(
        `connected ${endName(from)} → ${endName(to)} as ${id}` +
          (curve ? ` (curve ${curve})` : '') +
          (fromId || toId ? ' — it will follow them if they move' : ''),
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
      '',
      '**Pass `at` when the speed varies along the way.** `[{t, u}, …]` is a speed profile: be `u` of the way along the path at scene-local second `t`, with `u` a fraction of arc length (0 the first point of the path, 1 the last). The path still supplies every coordinate — you are giving the *pacing*, not the geometry, which is the whole reason to ride a path rather than build a position track.',
      '',
      'This is the form for an orbit, a bouncing arc, anything that races and dawdles: a planet fast at perihelion and slow at aphelion is `[{t:0,u:0},{t:0.6,u:0.5},{t:3,u:1}]`, not twenty-four hand-computed coordinate pairs. A real run spent **48 of its 95 calls** on exactly that, because a flow travels at constant speed and `easing` is one monotone curve over the whole trip, so it could not say "fast, slow, fast".',
      '',
      '`start` and `duration` come from the ends of the list, so do not pass them with `at`. Per-point `easing` is optional and inherits the call\'s — it shapes the segment arriving AT that point, exactly as a keyframe\'s does. Times must ascend; `u` need not, so a profile that rises and falls sends the node out along the path and back.',
      '',
      `Up to ${LIMITS.maxKeyframesPerTrack} points. Sample as finely as the motion needs — the sampler interpolates between whatever you give it, and 200 points cost no more to render than 2.`,
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      nodeId: NODE_ID.describe('the node that travels'),
      pathId: NODE_ID.describe('a path node to travel along'),
      start: SECONDS.optional(),
      duration: z.number().positive().optional(),
      easing: EASING,
      orient: z.boolean().default(false).describe('turn to face the direction of travel'),
      at: z
        .array(
          z.object({
            t: SECONDS,
            u: z
              .number()
              .min(0)
              .max(1)
              .describe('fraction of the path travelled: 0 its first point, 1 its last'),
            /** No default: an omitted per-point easing inherits the call's. */
            easing: z
              .enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'smooth'])
              .optional(),
          }),
        )
        .min(2)
        .max(LIMITS.maxKeyframesPerTrack)
        .optional()
        .describe('speed profile, instead of constant speed over start/duration'),
    }),
    async handler(ctx, a) {
      const { projectId, sceneId, nodeId, pathId, easing, orient, at } = a
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

      // `at` carries its own timing, so taking start/duration as well would
      // leave two answers to when the flow runs and no rule for which wins.
      if (at && (a.start !== undefined || a.duration !== undefined)) {
        throw new CapabilityError(
          '`at` already says when the node is where, so it cannot be combined with ' +
            '`start`/`duration` — the flow runs from the first point to the last. ' +
            'Shift the whole motion by moving the times in `at`.',
        )
      }
      if (!at && a.start === undefined) {
        throw new CapabilityError(
          'give `start` (with an optional `duration`) for a constant-speed flow, ' +
            'or `at` for a speed profile — a list of {t, u} saying where along the ' +
            'path the node is at each moment.',
        )
      }
      if (at) {
        // Ascending and distinct, for the same reason animate's keyframes are:
        // two points at one time are ambiguous rather than wrong-looking, and
        // a descending pair would silently run the motion backwards.
        for (let i = 1; i < at.length; i++) {
          if (at[i]!.t <= at[i - 1]!.t) {
            throw new CapabilityError(
              `\`at\` must be in ascending time order: [${i - 1}] is at ${at[i - 1]!.t}s and ` +
                `[${i}] is at ${at[i]!.t}s. To send the node back along the path, lower ` +
                `\`u\` at a LATER time — the times always move forwards, the position need not.`,
            )
          }
        }
      }

      const start = at ? at[0]!.t : a.start!
      const duration = at ? at[at.length - 1]!.t - at[0]!.t : (a.duration ?? 2)
      const transitions: Transition[] = [
        ...node.transitions.filter((t) => t.type !== 'follow'),
        {
          type: 'follow',
          start,
          duration,
          pathId,
          easing: easing as Easing,
          orient,
          ...(at
            ? { at: at.map((p) => ({ t: p.t, u: p.u, easing: (p.easing ?? easing) as Easing })) }
            : {}),
        },
      ]
      await ctx.submit(projectId, [op.updateNode(sceneId, nodeId, { transitions })])
      const tracked = node.tracks.some((t) => t.property === 'position')
      const length = pathLength(path.points, path.closed)
      // Report the speeds the profile actually produces, not the profile back.
      // The whole point of this form is that speed varies, so "does it vary the
      // way I meant" is the question the caller has, and it is arithmetic over
      // numbers they would otherwise have to do by hand.
      const speeds = at
        ? at.slice(1).map((p, i) => (Math.abs(p.u - at[i]!.u) * length) / (p.t - at[i]!.t))
        : []
      const profile = at
        ? `, ${at.length}-point profile — ${Math.round(Math.min(...speeds))}` +
          `–${Math.round(Math.max(...speeds))} px/s across its segments` +
          (at.some((p, i) => i > 0 && p.u < at[i - 1]!.u) ? ', reversing partway' : '')
        : ''
      return said(
        `${nodeId} flows along ${pathId} (${Math.round(length)}px) over ` +
          `[${start}s, ${start + duration}s]${profile}` +
          `${orient ? ', facing the way it travels' : ''}` +
          (tracked
            ? ` — NOTE ${nodeId} also has a position track, and the flow wins from ${start}s onward`
            : ''),
        { nodeId, pathId, start, duration, length, points: at?.length ?? 0 },
      )
    },
  }),
  capability({
    name: 'pin_to_frame',
    summary: 'Pin a node to the frame so the camera cannot move it — for captions and titles.',
    doc: [
      'A pinned node ignores the camera **entirely**: pan, zoom, roll and orbit alike. It draws over the scene at its own coordinates, which is what you want for a caption, a title or a legend.',
      '',
      'Without this, every node at the scene root is part of the world the camera is looking at — correct, and not what anyone wants of a label. In an orbiting scene an unpinned caption swings across the frame and changes size as the space turns behind it.',
      '',
      'Pinned nodes draw **on top** of everything else, and in the order you added them.',
      '',
      'It applies at the scene root only. A child inherits its group\'s transform, so pinning one inside a moving group is a contradiction and the flag is ignored — pin the group, or move the node out of it.',
      '',
      'Pass `fixed: false` to put a node back into the world.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      nodeId: NODE_ID,
      fixed: z.boolean().default(true),
    }),
    async handler(ctx, { projectId, sceneId, nodeId, fixed }) {
      const { doc } = await ctx.getDoc(projectId)
      const scene = ctx.sceneOrThrow(doc, sceneId)
      ctx.nodeOrThrow(doc, sceneId, nodeId)
      const atRoot = scene.nodes.some((n) => n.id === nodeId)
      await ctx.submit(projectId, [
        op.updateNode(sceneId, nodeId, { fixed: fixed ? true : null }),
      ])
      return said(
        fixed
          ? `${nodeId} is pinned to the frame — the camera no longer moves it` +
            (atRoot
              ? ''
              : ` — WARNING: it is inside a group, which still moves it. ` +
                `Pinning applies at the scene root; pin the group instead, or take the node out of it.`)
          : `${nodeId} is back in the world and moves with the camera`,
        { nodeId, fixed },
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
