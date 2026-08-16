import { z } from 'zod'
import { LIMITS, newId, op, type Axes3dNode, type Points3Node, type Vector3Node } from '@euclid/dsl'
import { COLOR, NUMBERISH, PROJECT_ID, SCENE_ID } from './schemas'
import { baseNode } from './tools-node'
import { capability, said, CapabilityError } from './types'

const VEC3 = z.object({ x: NUMBERISH, y: NUMBERISH, z: NUMBERISH })

/**
 * Shared prose. The depth convention and the "nothing happens until the camera
 * turns" rule are the two things that make a first 3D call confusing.
 */
const SPACE_UNITS = [
  'Coordinates are scene pixels: **x right, y DOWN, z toward the viewer**. A node with a larger z is nearer, so it draws bigger, brighter and on top. y pointing down is the canvas convention the rest of the system uses, and it is why an upward axis is drawn at negative y.',
  '',
  '**A spatial node looks flat until the camera turns.** Projection only runs when the scene camera has a non-zero `yaw` or `pitch` — set one with set_camera or move_camera, or use orbit_camera. Straight on, a cube really is a square, and that is not a bug.',
  '',
  'Spatial nodes live at the scene root, not inside a group: a group applies its own 2D transform to its children, which would be the camera applied twice.',
].join('\n')

export const spatialTools = [
  capability({
    name: 'add_vector3',
    summary: 'Add an arrow in space, from one 3D point to another.',
    doc: [
      'The workhorse of a 3D diagram: a vector with a head, projected end by end so it foreshortens honestly. An arrow pointing away from the camera really is shorter, thinner and fainter at its far end.',
      '',
      SPACE_UNITS,
      '',
      '`from` and `to` are offsets from the anchor (x, y, z), the same convention `add_shape`\'s line uses in 2D. Leave `from` out for a vector starting at the anchor itself.',
      '',
      'write_on grows it from its tail rather than sweeping a mask across the frame.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      x: z.number().describe('anchor x'),
      y: z.number().describe('anchor y'),
      z: z.number().default(0).describe('anchor depth, toward the viewer'),
      from: VEC3.optional().describe('tail offset from the anchor; default the anchor itself'),
      to: VEC3.describe('head offset from the anchor'),
      stroke: COLOR.default('#58c4dd'),
      strokeWidth: z.number().positive().default(6),
      headSize: z.number().min(0).default(36).describe('arrowhead length in px; 0 for a bare segment'),
    }),
    async handler(ctx, { projectId, sceneId, x, y, z, from, to, stroke, strokeWidth, headSize }) {
      const id = newId('vec')
      const node: Vector3Node = {
        ...baseNode({ x, y }),
        z,
        id,
        type: 'vector3',
        from: from ?? { x: 0, y: 0, z: 0 },
        to,
        stroke,
        strokeWidth,
        headSize,
      }
      await ctx.submit(projectId, [op.addNode(sceneId, node)])
      return said(
        `created vector ${id} from (${node.from.x},${node.from.y},${node.from.z}) to ` +
          `(${to.x},${to.y},${to.z}) about anchor (${x},${y},${z})`,
        { nodeId: id },
      )
    },
  }),

  capability({
    name: 'add_axes3d',
    summary: 'Add a 3D coordinate frame — one arrow per axis, projected.',
    doc: [
      'The reference that makes everything else in a spatial scene legible: without axes an orbiting camera reads as objects drifting rather than as a viewpoint moving.',
      '',
      SPACE_UNITS,
      '',
      'The y arrow is drawn **upward** (negative y) because that is what anyone reading a graph expects, even though y grows downward everywhere else. `negative: true` also draws the three back-halves, dimmer, which sells the origin as a point in space rather than a corner.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      x: z.number().describe('origin x'),
      y: z.number().describe('origin y'),
      z: z.number().default(0).describe('origin depth'),
      size: z.number().positive().default(320).describe('length of each positive axis, px'),
      colorX: COLOR.default('#fc6255'),
      colorY: COLOR.default('#7fb069'),
      colorZ: COLOR.default('#58c4dd'),
      strokeWidth: z.number().positive().default(4),
      negative: z.boolean().default(true),
    }),
    async handler(ctx, args) {
      const { projectId, sceneId, x, y, z, size, colorX, colorY, colorZ, strokeWidth, negative } = args
      const id = newId('ax')
      const node: Axes3dNode = {
        ...baseNode({ x, y }),
        z,
        id,
        type: 'axes3d',
        size,
        colorX,
        colorY,
        colorZ,
        strokeWidth,
        negative,
      }
      await ctx.submit(projectId, [op.addNode(sceneId, node)])
      return said(`created axes ${id} at (${x},${y},${z}), size ${size}`, { nodeId: id })
    },
  }),

  capability({
    name: 'add_points3',
    summary: 'Add a cloud of dots in space, each scaled and dimmed by its own depth.',
    doc: [
      'A set of points — samples, embeddings, a lattice — drawn as one node. Every dot is projected separately and the cloud is sorted back to front within itself, so near dots cover far ones and the shape reads as volume instead of as scatter.',
      '',
      SPACE_UNITS,
      '',
      `Up to ${LIMITS.maxPoints} points. Positions are offsets from the anchor, so moving the anchor moves the whole cloud, and write_on reveals the dots in the order you listed them.`,
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      x: z.number().describe('anchor x'),
      y: z.number().describe('anchor y'),
      z: z.number().default(0).describe('anchor depth'),
      points: z.array(VEC3).min(1).max(LIMITS.maxPoints),
      radius: z.number().positive().default(8),
      fill: COLOR.default('#e8c74a'),
    }),
    async handler(ctx, { projectId, sceneId, x, y, z, points, radius, fill }) {
      const id = newId('pts')
      const node: Points3Node = {
        ...baseNode({ x, y }),
        z,
        id,
        type: 'points3',
        points,
        radius,
        fill,
      }
      await ctx.submit(projectId, [op.addNode(sceneId, node)])
      const zs = points.map((p) => p.z)
      return said(
        `created point cloud ${id}: ${points.length} points about (${x},${y},${z}), ` +
          `depth ${Math.min(...zs)}..${Math.max(...zs)}`,
        { nodeId: id, count: points.length },
      )
    },
  }),
]

/** Distance is bounded for the same reason zoom is — see checkDistance's message. */
export function checkDistance(distance: number | undefined): void {
  if (distance === undefined) return
  if (distance < LIMITS.minCameraDistance || distance > LIMITS.maxCameraDistance) {
    throw new CapabilityError(
      `distance ${distance} is outside ${LIMITS.minCameraDistance}–${LIMITS.maxCameraDistance}. ` +
        `It is how far the camera sits from the z=0 plane: smaller is a wider lens with ` +
        `stronger perspective, larger is flatter. Below the floor the camera would be inside ` +
        `the diagram, which turns it inside out.`,
    )
  }
}
