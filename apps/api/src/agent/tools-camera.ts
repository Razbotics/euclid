import { z } from 'zod'
import {
  defaultCamera,
  LIMITS,
  op,
  type Camera,
  type CameraProp,
  type CameraTrack,
  type Easing,
  type KeyValue,
} from '@euclid/dsl'
import { resolveCamera } from '@euclid/engine'
import { EASING, NUMBERISH, PROJECT_ID, SCENE_ID, SECONDS } from './schemas'
import { checkDistance } from './tools-3d'
import { capability, said, CapabilityError } from './types'

const ZOOM = NUMBERISH.describe(
  `1 = the canvas as laid out; 2 shows half as much, twice as large (${LIMITS.minCameraZoom}–${LIMITS.maxCameraZoom})`,
)

/** Shared prose: the two things every camera call gets wrong on the first try. */
const CAMERA_UNITS = [
  '`zoom` is magnification, not a distance: **2 shows half the scene at twice the size**, 0.5 shows four times the area, smaller. `x`/`y` are the **scene point placed at the centre of the frame** — the same coordinate space every node uses, so a 1920x1080 canvas frames its own centre at (960, 540).',
  '',
  '`rotation` is camera roll in **RADIANS**, positive clockwise. A 15° tilt is 0.262, not 15 — the degrees guess succeeds and spins the scene more than twice round.',
  '',
  'The camera never moves a node. Every coordinate you pass to add_* and animate stays scene-local, which is the point: lay a diagram out larger than the canvas and let the camera decide what is being looked at.',
  '',
  '`yaw` and `pitch` (radians) turn the camera into a **3D** one: they orbit the scene about the framed point, and any node with a `z` — or an add_vector3 / add_axes3d / add_points3 node — is then projected, scaled and dimmed by its depth. While both are zero the scene is drawn flat, in document order, exactly as it always was. `distance` is how far the camera sits from the z=0 plane: smaller is a wider lens with stronger perspective.',
].join('\n')

function checkZoom(zoom: number | undefined): void {
  if (zoom === undefined) return
  if (zoom < LIMITS.minCameraZoom || zoom > LIMITS.maxCameraZoom) {
    throw new CapabilityError(
      `zoom ${zoom} is outside ${LIMITS.minCameraZoom}–${LIMITS.maxCameraZoom}. ` +
        `zoom is magnification: 2 is twice as large, 0.5 is half. A value far outside ` +
        `that range renders an empty frame, which looks like a broken renderer.`,
    )
  }
}

/**
 * Replace a camera track from `start` onward, keeping what came before — the
 * same rule `animate` follows for nodes, so successive calls chain into one
 * continuous move instead of stacking.
 */
function extendTrack(
  tracks: CameraTrack[],
  property: CameraProp,
  from: KeyValue,
  to: KeyValue,
  start: number,
  duration: number,
  easing: Easing,
): CameraTrack[] {
  const existing = tracks.find((t) => t.property === property)
  const keep = existing ? existing.keyframes.filter((k) => k.t < start) : []
  return [
    ...tracks.filter((t) => t.property !== property),
    {
      property,
      keyframes: [
        ...keep,
        { t: start, value: from, easing: 'linear' },
        { t: start + duration, value: to, easing },
      ],
    },
  ]
}

export const cameraTools = [
  capability({
    name: 'set_camera',
    summary: 'Frame a scene statically: what the camera is centred on, and how close. Free.',
    doc: [
      'Sets the scene\'s standing framing. Use it to compose — lay the diagram out at whatever size reads well, then decide what the frame shows. A scene with no camera is framed on the plain canvas, and adding one changes nothing until you pass a value.',
      '',
      CAMERA_UNITS,
      '',
      '**A camera track shadows this**, exactly as a node track shadows a node property: if `move_camera` has keyframed `zoom`, setting `zoom` here changes the document and nothing on screen. The response says so when it happens — reach for move_camera instead, or `reset: true` to throw the whole camera away and start again.',
      '',
      'Nothing here costs credits, and preview_frames is how you check a framing: a zoom that cuts a label in half is invisible in any outline.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      x: NUMBERISH.optional().describe('scene x placed at the centre of the frame'),
      y: NUMBERISH.optional().describe('scene y placed at the centre of the frame'),
      zoom: ZOOM.optional(),
      rotation: NUMBERISH.optional().describe('camera roll in RADIANS, positive clockwise'),
      yaw: NUMBERISH.optional().describe('orbit about the vertical axis, RADIANS; non-zero turns on 3D'),
      pitch: NUMBERISH.optional().describe('orbit about the horizontal axis, RADIANS; positive looks down'),
      distance: NUMBERISH.optional().describe('camera distance from the z=0 plane; smaller = more perspective'),
      reset: z
        .boolean()
        .default(false)
        .describe('drop the camera and its tracks entirely, back to the plain canvas frame'),
    }),
    async handler(ctx, { projectId, sceneId, x, y, zoom, rotation, yaw, pitch, distance, reset }) {
      const { doc } = await ctx.getDoc(projectId)
      const scene = ctx.sceneOrThrow(doc, sceneId)
      const framing = [x, y, zoom, rotation, yaw, pitch, distance].some((v) => v !== undefined)

      if (reset) {
        if (framing) {
          throw new CapabilityError(
            'reset drops the camera entirely — pass either reset: true or a framing, not both',
          )
        }
        if (!scene.camera) return said(`scene ${sceneId} has no camera; nothing to reset`, { sceneId })
        await ctx.submit(projectId, [op.clearCamera(sceneId)])
        return said(`removed the camera from ${sceneId} — back to the plain canvas frame`, {
          sceneId,
          camera: null,
        })
      }
      if (!framing) {
        throw new CapabilityError(
          'nothing to set — pass at least one of x, y, zoom, rotation, yaw, pitch, distance ' +
            '(or reset: true)',
        )
      }
      checkZoom(zoom)
      checkDistance(distance)

      const base = scene.camera ?? defaultCamera(doc.canvas)
      const camera: Camera = {
        ...base,
        position: { x: x ?? base.position.x, y: y ?? base.position.y },
        zoom: zoom ?? base.zoom,
        rotation: rotation ?? base.rotation,
        yaw: yaw ?? base.yaw,
        pitch: pitch ?? base.pitch,
        distance: distance ?? base.distance,
      }
      await ctx.submit(projectId, [op.setCamera(sceneId, camera)])

      // The one failure mode that reports success and changes nothing on
      // screen. Naming it here is the whole remedy — the agent has no other
      // way to find out short of a screenshot it may not think to take.
      const touched: CameraProp[] = [
        ...(x !== undefined || y !== undefined ? (['position'] as const) : []),
        ...(zoom !== undefined ? (['zoom'] as const) : []),
        ...(rotation !== undefined ? (['rotation'] as const) : []),
        ...(yaw !== undefined ? (['yaw'] as const) : []),
        ...(pitch !== undefined ? (['pitch'] as const) : []),
        ...(distance !== undefined ? (['distance'] as const) : []),
      ]
      const shadowed = touched.filter((p) => base.tracks.some((t) => t.property === p))
      return said(
        `camera on ${sceneId}: centre (${camera.position.x}, ${camera.position.y}), ` +
          `zoom ${camera.zoom}, roll ${camera.rotation}rad, yaw ${camera.yaw}, ` +
          `pitch ${camera.pitch}, distance ${camera.distance}` +
          (camera.yaw === 0 && camera.pitch === 0
            ? ' — flat: yaw and pitch are both zero, so nothing is projected'
            : '') +
          (shadowed.length
            ? ` — WARNING: ${shadowed.join(' and ')} ${shadowed.length > 1 ? 'are' : 'is'} keyframed ` +
              `on this camera, so the track wins at render time and this will not be visible. ` +
              `Use move_camera, or set_camera with reset: true first.`
            : ''),
        { sceneId, camera, shadowed },
      )
    },
  }),

  capability({
    name: 'move_camera',
    summary: 'Animate the camera: pan, zoom or roll from wherever it is to where you want it. Free.',
    doc: [
      'The camera equivalent of `animate`, and it works the same way: the starting framing is **sampled from the document at `start`**, never assumed, so moves chain continuously and you never restate where the camera already is. Pass only the properties you want to change — a pure zoom leaves the pan alone.',
      '',
      CAMERA_UNITS,
      '',
      'Existing camera keyframes **after `start` are replaced** and earlier ones are kept, so re-calling revises a move rather than stacking one on top of it. Creating a camera this way starts it centred on the canvas at zoom 1, so a first call is always a move from the plain framing.',
      '',
      '**Drifting slowly reads as intent; snapping reads as a mistake.** A push-in over 2–3s under narration is the move that makes a large diagram legible; the same move in 0.3s is a jump cut. `smooth` easing (the default) is what keeps the ends from looking mechanical.',
      '',
      'preview_frames samples every camera move automatically — mid-move and where it settles — so a pan that ends with the subject half out of frame shows up on the next contact sheet.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      x: NUMBERISH.optional().describe('scene x to centre the frame on'),
      y: NUMBERISH.optional().describe('scene y to centre the frame on'),
      zoom: ZOOM.optional(),
      rotation: NUMBERISH.optional().describe('camera roll in RADIANS, positive clockwise'),
      yaw: NUMBERISH.optional().describe('orbit about the vertical axis, RADIANS'),
      pitch: NUMBERISH.optional().describe('orbit about the horizontal axis, RADIANS'),
      distance: NUMBERISH.optional().describe('camera distance from the z=0 plane'),
      start: SECONDS,
      duration: z.number().positive().default(2),
      easing: EASING,
    }),
    async handler(ctx, args) {
      const { projectId, sceneId, x, y, zoom, rotation, yaw, pitch, distance, start, duration, easing } =
        args
      const { doc } = await ctx.getDoc(projectId)
      const scene = ctx.sceneOrThrow(doc, sceneId)
      if ([x, y, zoom, rotation, yaw, pitch, distance].every((v) => v === undefined)) {
        throw new CapabilityError(
          'nothing to move — pass at least one of x, y, zoom, rotation, yaw, pitch, distance. ' +
            'A camera move with no target is a hold, which is what happens anyway.',
        )
      }
      checkZoom(zoom)
      checkDistance(distance)

      const base = scene.camera ?? defaultCamera(doc.canvas)
      const from = resolveCamera({ ...scene, camera: base }, start)!
      let tracks = base.tracks
      const moves: string[] = []
      const ease = easing as Easing

      if (x !== undefined || y !== undefined) {
        const to = { x: x ?? from.position.x, y: y ?? from.position.y }
        tracks = extendTrack(tracks, 'position', from.position, to, start, duration, ease)
        moves.push(`centre (${from.position.x}, ${from.position.y}) → (${to.x}, ${to.y})`)
      }
      if (zoom !== undefined) {
        tracks = extendTrack(tracks, 'zoom', from.zoom, zoom, start, duration, ease)
        moves.push(`zoom ${from.zoom} → ${zoom}`)
      }
      if (rotation !== undefined) {
        tracks = extendTrack(tracks, 'rotation', from.rotation, rotation, start, duration, ease)
        moves.push(`roll ${from.rotation} → ${rotation}rad`)
      }
      for (const [prop, target, current] of [
        ['yaw', yaw, from.yaw],
        ['pitch', pitch, from.pitch],
        ['distance', distance, from.distance],
      ] as const) {
        if (target === undefined) continue
        tracks = extendTrack(tracks, prop, current, target, start, duration, ease)
        moves.push(`${prop} ${current} → ${target}`)
      }

      await ctx.submit(projectId, [op.setCamera(sceneId, { ...base, tracks })])
      const overrun = start + duration > scene.duration
      return said(
        `camera on ${sceneId}: ${moves.join(', ')} over [${start}s, ${start + duration}s]` +
          (overrun
            ? ` — note the scene ends at ${scene.duration}s, so this move never finishes on screen`
            : ''),
        { sceneId, from, start, duration, moves },
      )
    },
  }),

  capability({
    name: 'orbit_camera',
    summary: 'Swing the camera around the scene by a number of DEGREES — the 3D establishing move.',
    doc: [
      'Sugar over move_camera for the one motion a spatial scene almost always wants: a slow turn around what it is looking at, which is what makes a projection read as depth rather than as a strange flat drawing. Nothing else conveys "this is a space" as cheaply.',
      '',
      '**This is the only capability that takes degrees**, because an orbit is naturally described as "a quarter turn" and `90` is unambiguous when the argument is called `degrees`. Everywhere else — including `yaw` and `pitch` on set_camera and move_camera — angles are RADIANS.',
      '',
      'The turn is *relative*: it adds to wherever the camera is at `start`, so successive orbits compose. `pitchDegrees` tilts at the same time; positive lifts the camera and looks down, which is usually what a diagram wants.',
      '',
      'Slow is the whole point. Under narration, 20–40 degrees over several seconds reads as a considered look around; a full turn in one second reads as a spin.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      degrees: NUMBERISH.default(45).describe('how far to swing about the vertical axis, DEGREES'),
      pitchDegrees: NUMBERISH.optional().describe('tilt to reach, DEGREES; positive looks down'),
      start: SECONDS,
      duration: z.number().positive().default(4),
      easing: EASING,
    }),
    async handler(ctx, { projectId, sceneId, degrees, pitchDegrees, start, duration, easing }) {
      const { doc } = await ctx.getDoc(projectId)
      const scene = ctx.sceneOrThrow(doc, sceneId)
      const base = scene.camera ?? defaultCamera(doc.canvas)
      const from = resolveCamera({ ...scene, camera: base }, start)!
      const ease = easing as Easing
      const toYaw = from.yaw + (degrees * Math.PI) / 180

      let tracks = extendTrack(base.tracks, 'yaw', from.yaw, toYaw, start, duration, ease)
      const moves = [`yaw ${round(from.yaw)} → ${round(toYaw)}rad (${degrees}°)`]
      if (pitchDegrees !== undefined) {
        const toPitch = (pitchDegrees * Math.PI) / 180
        tracks = extendTrack(tracks, 'pitch', from.pitch, toPitch, start, duration, ease)
        moves.push(`pitch ${round(from.pitch)} → ${round(toPitch)}rad (${pitchDegrees}°)`)
      }
      await ctx.submit(projectId, [op.setCamera(sceneId, { ...base, tracks })])
      return said(
        `orbiting ${sceneId}: ${moves.join(', ')} over [${start}s, ${start + duration}s]` +
          (from.yaw === 0 && from.pitch === 0 && pitchDegrees === undefined
            ? ' — the scene starts flat and turns into the projection as it goes'
            : ''),
        { sceneId, degrees, pitchDegrees, start, duration },
      )
    },
  }),
]

const round = (n: number): number => Math.round(n * 1000) / 1000
