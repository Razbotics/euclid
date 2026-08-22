import { z } from 'zod'
import {
  GlbError,
  LIMITS,
  decimateMesh,
  meshTriangleCount,
  newId,
  normalizeMesh,
  op,
  orientOutward,
  parseGlb,
  type Axes3dNode,
  type MeshGeometry,
  type MeshNode,
  type Points3Node,
  type Vector3Node,
} from '@euclid/dsl'
import { loadAsset } from '../services/assets'
import { assertPlacementApproved, ensureLinked } from './review'
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

  capability({
    name: 'add_mesh',
    summary: 'Add a solid — cube, sphere, torus, cylinder, cone or plane.',
    doc: [
      'A real surface rather than an outline: every triangle is projected, the ones facing away are dropped, and the rest are sorted back to front and flat-shaded against a fixed light. A sphere reads as a ball, and a torus correctly hides its own far side behind its near rim.',
      '',
      SPACE_UNITS,
      '',
      '**Pick the shape by name, not by typing vertices.** `shape` plus a size is the whole call; `segments` trades smoothness for frame time. The geometry is expanded from those numbers when drawing, so the document stays small however smooth the solid is.',
      '',
      `Up to ${LIMITS.maxTriangles} triangles, and the error tells you the count if you go over. Rough guide: a sphere or plane costs \`segments × segments/2 × 2\` triangles, a torus the same, a cylinder \`segments × 4\`, a cone \`segments × 2\`.`,
      '',
      '**The one thing this cannot draw correctly is two solids that physically pass through each other.** Sorting whole triangles cannot interleave them, so the nearer-on-average one wins the overlap outright. Solids that merely sit near or behind one another are fine. Turning `cull` off for an open surface also makes ordering approximate rather than exact.',
      '',
      'write_on builds the solid up from its far side, one face at a time.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      shape: z.enum(['cube', 'sphere', 'torus', 'cylinder', 'cone', 'plane']),
      x: z.number().describe('centre x'),
      y: z.number().describe('centre y'),
      z: z.number().default(0).describe('centre depth'),
      size: z
        .number()
        .positive()
        .default(300)
        .describe('cube edge; sphere/torus/cylinder/cone radius; plane width'),
      height: z
        .number()
        .positive()
        .optional()
        .describe('cylinder and cone only; defaults to 2x size'),
      tube: z.number().positive().optional().describe('torus only; ring thickness, default size/3'),
      depth: z.number().positive().optional().describe('plane only; defaults to size'),
      segments: z
        .number()
        .int()
        .min(3)
        .max(96)
        .default(24)
        .describe('smoothness; ignored by cube'),
      fill: COLOR.default('#58c4dd'),
      shading: z.enum(['flat', 'none']).default('flat'),
      ambient: z
        .number()
        .min(0)
        .max(1)
        .default(0.25)
        .describe('brightness of a face turned away from the light'),
      cull: z
        .boolean()
        .default(true)
        .describe('drop faces pointing away; leave on for closed shapes'),
      stroke: COLOR.optional().describe('wireframe over the fill'),
      strokeWidth: z.number().min(0).default(1),
    }),
    async handler(ctx, args) {
      const { projectId, sceneId, shape, x, y, z, size, segments } = args
      const geometry: MeshGeometry =
        shape === 'cube'
          ? { kind: 'cube', size }
          : shape === 'sphere'
            ? { kind: 'sphere', radius: size, segments }
            : shape === 'torus'
              ? { kind: 'torus', radius: size, tube: args.tube ?? size / 3, segments }
              : shape === 'cylinder'
                ? { kind: 'cylinder', radius: size, height: args.height ?? size * 2, segments }
                : shape === 'cone'
                  ? { kind: 'cone', radius: size, height: args.height ?? size * 2, segments }
                  : { kind: 'plane', width: size, depth: args.depth ?? size, segments }

      // Checked before building, so an expensive shape is refused by arithmetic
      // rather than after allocating it.
      const triangles = meshTriangleCount(geometry)
      if (triangles > LIMITS.maxTriangles) {
        throw new CapabilityError(
          `a ${shape} at segments=${segments} is ${triangles} triangles, over the ${LIMITS.maxTriangles} ceiling. ` +
            `Every triangle is projected, sorted and filled on the CPU each frame, so this is a frame-time ` +
            `limit. Lower segments — a sphere at 24 is already smooth at typical sizes.`,
        )
      }

      const id = newId('mesh')
      const node: MeshNode = {
        ...baseNode({ x, y }),
        z,
        id,
        type: 'mesh',
        geometry,
        fill: args.fill,
        shading: args.shading,
        ambient: args.ambient,
        cull: args.cull,
        ...(args.stroke ? { stroke: args.stroke } : {}),
        strokeWidth: args.strokeWidth,
      }
      await ctx.submit(projectId, [op.addNode(sceneId, node)])
      return said(
        `created ${shape} ${id} at (${x},${y},${z}) — ${triangles} triangles` +
          (args.cull ? '' : ', culling off so face ordering is approximate'),
        { nodeId: id, triangles, shape },
      )
    },
  }),

  capability({
    name: 'import_mesh',
    summary: 'Turn a generated 3D model (GLB asset) into a solid you can draw.',
    doc: [
      'Free. Reads a `model` asset — what generate_3d produces — and lands it in the scene as an ordinary mesh node, so the camera, animation and write_on all work on it exactly as they do on a sphere.',
      '',
      SPACE_UNITS,
      '',
      '**The model is simplified on the way in, and the reason is storage rather than drawing.** Imported geometry is kept in the document, and the document has a hard size budget, so a 300,000-triangle generation is reduced to at most ' + LIMITS.maxImportedTriangles + ' triangles by welding nearby vertices. The response says what it started from and what it became. At the size a solid occupies in a frame the difference is hard to see; if it matters, raise `targetTriangles` and the error will tell you when the document cannot afford it.',
      '',
      'It is also **re-oriented and re-scaled**: centred on the anchor, scaled so its longest axis is `size` pixels, and its faces wound outward whichever way the file had them. A model that arrived inside out is fixed rather than drawn as a hollow shell.',
      '',
      'Materials, textures and colours in the file are ignored — the renderer flat-shades from `fill` against one fixed light, which is what makes a solid read as solid.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      assetId: z.string().min(1).describe('a `model` asset — see list_assets'),
      x: z.number().describe('centre x'),
      y: z.number().describe('centre y'),
      z: z.number().default(0).describe('centre depth'),
      size: z.number().positive().default(400).describe('longest axis, in scene pixels'),
      targetTriangles: z
        .number()
        .int()
        .min(50)
        .max(LIMITS.maxImportedTriangles)
        .default(1500),
      fill: COLOR.default('#c9d1d9'),
      shading: z.enum(['flat', 'none']).default('flat'),
      ambient: z.number().min(0).max(1).default(0.25),
      cull: z.boolean().default(true),
      stroke: COLOR.optional(),
      strokeWidth: z.number().min(0).default(1),
    }),
    async handler(ctx, args) {
      const { projectId, sceneId, assetId, x, y, z, size, targetTriangles } = args
      await ctx.requireProject(projectId)

      const asset = await loadAsset(ctx.env, assetId)
      if (!asset) throw new CapabilityError(`asset ${assetId} not found`, 404)
      if (asset.kind !== 'model') {
        throw new CapabilityError(
          `asset ${assetId} is ${asset.kind}, not a 3D model. import_mesh reads the GLB files ` +
            `generate_3d produces; list_assets marks which is which.`,
        )
      }
      // The one placement that *consumes* its asset (geometry is baked into
      // the document), so this gate is the only control an import ever passes.
      await assertPlacementApproved(ctx, projectId, {
        id: asset.id,
        reviewStatus: asset.review_status,
        reviewNote: asset.review_note,
      })
      await ensureLinked(ctx, projectId, assetId)

      const object = await ctx.env.ASSETS.get(asset.r2_key)
      if (!object) throw new CapabilityError(`the bytes for ${assetId} are missing`, 410)

      let geometry
      let sourceTriangles: number
      try {
        const parsed = parseGlb(await object.arrayBuffer())
        sourceTriangles = parsed.faces.length
        // Decimate first, then scale, then fix the winding — the Y flip in
        // normalizeMesh reverses orientation, so orienting before it would be
        // undone by it.
        const mesh = orientOutward(normalizeMesh(decimateMesh(parsed, targetTriangles), size))
        geometry = { kind: 'custom' as const, verts: mesh.verts, faces: mesh.faces }
      } catch (e) {
        if (e instanceof GlbError) {
          throw new CapabilityError(`could not read ${assetId}: ${e.message}`)
        }
        throw new CapabilityError(`could not read ${assetId}: ${(e as Error).message}`)
      }

      // The document lives under one Durable Object key with a 128 KiB ceiling,
      // so geometry competes with the rest of the scene for room. Refusing here
      // with a number beats a write that fails inside the DO.
      const { doc } = await ctx.getDoc(projectId)
      const projected = JSON.stringify(doc).length + JSON.stringify(geometry).length
      if (projected > 110_000) {
        throw new CapabilityError(
          `this mesh would take the document to ~${Math.round(projected / 1024)}KB, past the ` +
            `~110KB it can hold (a Durable Object value caps at 128KB). Lower targetTriangles — ` +
            `${targetTriangles} costs about ${Math.round(JSON.stringify(geometry).length / 1024)}KB — ` +
            `or import into a project with fewer scenes.`,
        )
      }

      const id = newId('mesh')
      const node: MeshNode = {
        ...baseNode({ x, y }),
        z,
        id,
        type: 'mesh',
        geometry,
        fill: args.fill,
        shading: args.shading,
        ambient: args.ambient,
        cull: args.cull,
        ...(args.stroke ? { stroke: args.stroke } : {}),
        strokeWidth: args.strokeWidth,
      }
      await ctx.submit(projectId, [op.addNode(sceneId, node)])
      return said(
        `imported ${assetId} as ${id} at (${x},${y},${z}) — ${sourceTriangles} triangles ` +
          `reduced to ${geometry.faces.length}, longest axis ${size}px, ` +
          `${Math.round(JSON.stringify(geometry).length / 1024)}KB of document`,
        { nodeId: id, sourceTriangles, triangles: geometry.faces.length },
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
