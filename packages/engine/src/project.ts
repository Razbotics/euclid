import type { Vec2, Vec3 } from '@euclid/dsl'

/**
 * Pseudo-3D by projection.
 *
 * Very little of what reads as three dimensions in a 3blue1brown video is a 3D
 * engine: it is projected coordinates plus **depth cues** — perspective scale,
 * painter's ordering, dimming with distance. Manim renders it that way, and it
 * matters more here than it does there, because projection is arithmetic on
 * (document, time): it slots into the sampler, keeps the purity invariant, and
 * needs no GPU — which the render container does not have.
 *
 * Everything below is scene-space in and scene-space out. The 2D camera (pan,
 * zoom, roll) is a transform the stage applies afterwards, so the two compose
 * instead of fighting: projection decides where a point sits on the z=0 plane,
 * framing decides which part of that plane you are looking at.
 *
 * Axes: `x` right, `y` **down** (canvas convention), `z` **toward the viewer**.
 * A node with a larger z is nearer, and draws larger and on top.
 */

export interface Camera3 {
  /** The point the camera looks at and orbits; the z=0 plane passes through it. */
  focus: Vec2
  /** Radians about the vertical axis. Positive swings +x toward the viewer. */
  yaw: number
  /** Radians about the horizontal axis. Positive lifts the camera, looking down. */
  pitch: number
  /** Camera distance from the focus plane. Larger is flatter; huge is orthographic. */
  distance: number
}

export interface Projected {
  /** Scene-space position, ready for the 2D camera transform. */
  x: number
  y: number
  /** Perspective scale: >1 nearer than the focus plane, <1 further. */
  scale: number
  /** Camera-space depth. Larger is nearer — the painter's sort key. */
  depth: number
  /** Distance cue in [MIN_DIM, 1]: 1 at the focus plane, less further away. */
  dim: number
}

/**
 * How hard distance dims. The cue is what sells the effect — without it a
 * vector behind another reads as two flat overlapping lines — but overdone it
 * looks like fog, so the far half of a typical scene lands around 0.6.
 */
const DEPTH_DIM = 0.8
const MIN_DIM = 0.25

/**
 * A point at or beyond the camera cannot be projected: the perspective divide
 * flips sign and the node lands, hugely magnified, on the wrong side of the
 * frame. Culling it is the honest answer.
 */
const MIN_DENOM = 1e-3

/** Project a scene point. Returns null when the point is at or behind the camera. */
export function project3(p: Vec3, cam: Camera3): Projected | null {
  const px = p.x - cam.focus.x
  const py = p.y - cam.focus.y

  // Yaw about the vertical axis, then pitch about the horizontal one. Order
  // matters and this is the one that reads as an orbit: yaw turns the scene,
  // pitch lifts the viewpoint over the result.
  const cy = Math.cos(cam.yaw)
  const sy = Math.sin(cam.yaw)
  const x1 = px * cy + p.z * sy
  const z1 = -px * sy + p.z * cy

  const cp = Math.cos(cam.pitch)
  const sp = Math.sin(cam.pitch)
  // `y` grows downward, so a positive pitch must push near things *down* the
  // screen — that is what "the camera is above, looking down" looks like.
  const y1 = py * cp + z1 * sp
  const z2 = -py * sp + z1 * cp

  const denom = cam.distance - z2
  if (denom <= MIN_DENOM) return null
  const scale = cam.distance / denom

  return {
    x: cam.focus.x + x1 * scale,
    y: cam.focus.y + y1 * scale,
    scale,
    depth: z2,
    // Tied to the perspective scale rather than to raw depth, so one number
    // controls how strong every cue is: a flatter camera dims less, which is
    // what an orthographic view should do.
    dim: Math.min(1, Math.max(MIN_DIM, 1 - DEPTH_DIM * (1 - scale))),
  }
}

/**
 * True when the camera is doing nothing three-dimensional, so a scene of plain
 * 2D nodes can skip projection and depth sorting entirely and keep drawing in
 * document order.
 */
export function isFlatCamera(cam: Camera3): boolean {
  return cam.yaw === 0 && cam.pitch === 0
}

/** Rotate a scene point into camera space without projecting — for depth alone. */
export function depthOf(p: Vec3, cam: Camera3): number {
  const px = p.x - cam.focus.x
  const py = p.y - cam.focus.y
  const z1 = -px * Math.sin(cam.yaw) + p.z * Math.cos(cam.yaw)
  return -py * Math.sin(cam.pitch) + z1 * Math.cos(cam.pitch)
}
