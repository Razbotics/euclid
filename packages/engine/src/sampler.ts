import {
  ANIMATABLE_PROPS,
  DEFAULT_CAMERA_DISTANCE,
  LIMITS,
  type Canvas,
  type CellRange,
  type Easing,
  type EuclidNode,
  type KeyValue,
  type Keyframe,
  type Scene,
  type Vec2,
} from '@euclid/dsl'
import { clamp01, easings } from './easing'
import { isFlatCamera, project3, type Camera3, type Projected } from './project'

/**
 * The core invariant of Euclid: rendering is a pure function of (document, time).
 * No wall-clock, no accumulated state — the same t always yields the same frame,
 * in the browser preview and in the headless export worker alike.
 */

export interface TexMorphState {
  fromTex: string
  toTex: string
  /** eased progress in [0,1] */
  progress: number
}

/** Fraction of the highlight spent ramping in, and again ramping out. */
const HIGHLIGHT_RAMP = 0.18

export interface HighlightState {
  /** LaTeX of the sub-expression to mark; whole node when absent. */
  tex?: string
  /** Cells to mark on a matrix/tokens node; whole node when absent. */
  cells?: CellRange
  style: 'box' | 'underline' | 'color' | 'spotlight'
  color: string
  /** 0 → invisible, 1 → fully drawn. Ramps up, holds, ramps down. */
  strength: number
}

/** A matrix restating itself: which grid is leaving, which is arriving, how far. */
export interface CellMorphState {
  fromCells: string[][]
  toCells: string[][]
  /** eased progress in [0,1] */
  progress: number
}

export interface ResolvedNode {
  source: EuclidNode
  /** Animatable properties, resolved at t (base value unless a track overrides it). */
  props: Record<string, KeyValue>
  /** null = no write transition on this node. 0 = not yet drawn (invisible). */
  writeProgress: number | null
  texMorph: TexMorphState | null
  cellMorph: CellMorphState | null
  /**
   * Where this node's anchor projects to, and its depth. null in a flat scene
   * (no projection ran) or when the node sits at or behind the camera, which
   * the stage draws as invisible rather than as an enormous artifact.
   */
  projection: Projected | null
  highlight: HighlightState | null
  children: ResolvedNode[]
}

/** The framing at t. Screen = canvasCentre + R(−rotation)·zoom·(scenePoint − position). */
export interface ResolvedCamera {
  position: Vec2
  zoom: number
  rotation: number
  /** Orbit about the vertical axis, in radians. */
  yaw: number
  /** Orbit about the horizontal axis; positive looks down. */
  pitch: number
  /** Camera distance from the z=0 plane, driving the perspective divide. */
  distance: number
}

/** The 3D half of the camera, in the form the projection maths wants. */
export function camera3(cam: ResolvedCamera): Camera3 {
  return { focus: cam.position, yaw: cam.yaw, pitch: cam.pitch, distance: cam.distance }
}

export interface ResolvedScene {
  nodes: ResolvedNode[]
  /** null = no camera on this scene; the frame is the canvas, untransformed. */
  camera: ResolvedCamera | null
  /**
   * Whether anything in this scene is three-dimensional — an orbiting camera,
   * a node with a depth, or a node that is 3D by type. False means the stage
   * draws exactly as it always did: document order, no projection, no sort.
   */
  spatial: boolean
  /** The projection to feed vertex-projecting nodes; null when the scene is flat. */
  cam3: Camera3 | null
}

export function resolveScene(scene: Scene, t: number, canvas?: Canvas): ResolvedScene {
  const camera = resolveCamera(scene, t)
  const nodes = scene.nodes.map((n) => resolveNode(n, t))
  const anySpatial = nodes.some(hasDepth)
  // A scene can hold a vector without holding a camera, and it must still
  // draw — straight on, which is what a projection with no yaw or pitch is.
  // Falling back to the canvas centre matters: focus is the point everything
  // scales about, and (0,0) would slide a deep node toward the corner.
  const cam3 =
    camera !== null
      ? camera3(camera)
      : anySpatial
        ? {
            focus: canvas
              ? { x: canvas.width / 2, y: canvas.height / 2 }
              : { x: 0, y: 0 },
            yaw: 0,
            pitch: 0,
            distance: DEFAULT_CAMERA_DISTANCE,
          }
        : null
  // Projection has to be worth turning on: a flat camera over flat nodes must
  // leave a 2D scene bit-identical to what it was before this existed.
  const spatial = cam3 !== null && (anySpatial || !isFlatCamera(cam3))
  if (spatial && cam3) {
    for (const n of nodes) n.projection = projectNode(n, cam3)
  }
  return { nodes, camera, spatial, cam3: spatial ? cam3 : null }
}

/** A node is three-dimensional if it carries a depth or is 3D by type. */
function hasDepth(n: ResolvedNode): boolean {
  return (
    n.props.z !== undefined ||
    n.source.type === 'vector3' ||
    n.source.type === 'axes3d' ||
    n.source.type === 'points3'
  )
}

/**
 * Where a node's anchor lands, and how near it is.
 *
 * One point per node: this is what the painter's sort and the depth cues ride
 * on. Nodes whose *geometry* spans depth — a vector, a point cloud — project
 * their own vertices in the stage with the same function; this is their sort
 * key, not their shape.
 */
function projectNode(res: ResolvedNode, cam: Camera3): Projected | null {
  const p = res.props.position as Vec2
  return project3({ x: p.x, y: p.y, z: (res.props.z as number | undefined) ?? 0 }, cam)
}

/**
 * The camera's framing at t — same rule as a node: a track shadows the base
 * value wherever one exists.
 *
 * Exported separately from `resolveScene` because the editor's frame overlay
 * wants the camera without paying to resolve every node in the scene.
 */
export function resolveCamera(scene: Scene, t: number): ResolvedCamera | null {
  const cam = scene.camera
  if (!cam) return null
  const out: ResolvedCamera = {
    position: cam.position,
    zoom: cam.zoom,
    rotation: cam.rotation,
    yaw: cam.yaw,
    pitch: cam.pitch,
    distance: cam.distance,
  }
  for (const track of cam.tracks) {
    const v = sampleKeyframes(track.keyframes, t)
    if (track.property === 'position') out.position = v as Vec2
    else if (track.property === 'zoom') out.zoom = v as number
    else if (track.property === 'rotation') out.rotation = v as number
    else if (track.property === 'yaw') out.yaw = v as number
    else if (track.property === 'pitch') out.pitch = v as number
    else out.distance = v as number
  }
  // The schema bounds the base value but cannot bound a keyframe — KeyValue is
  // one union for every property. A zoom at or below zero is a non-invertible
  // transform: the whole scene collapses and every frame after it is blank,
  // which looks like a broken renderer rather than a bad keyframe.
  out.zoom = Math.min(LIMITS.maxCameraZoom, Math.max(LIMITS.minCameraZoom, out.zoom))
  // Same argument for distance: a keyframe that walks the camera into the
  // scene inverts the perspective divide and turns the diagram inside out.
  out.distance = Math.min(
    LIMITS.maxCameraDistance,
    Math.max(LIMITS.minCameraDistance, out.distance),
  )
  return out
}

export function resolveNode(node: EuclidNode, t: number): ResolvedNode {
  const props: Record<string, KeyValue> = {}
  const source = node as unknown as Record<string, unknown>
  for (const p of ANIMATABLE_PROPS) {
    const v = source[p]
    if (v !== undefined) props[p] = v as KeyValue
  }

  for (const track of node.tracks) {
    props[track.property] = sampleKeyframes(track.keyframes, t)
  }

  let writeProgress: number | null = null

  // An emphasis is a pulse, not a ramp: it appears, holds while the narration
  // talks about the thing, then leaves. A monotonic 0→1 would be a wipe.
  let highlight: HighlightState | null = null
  // Highlights are sequential: the one whose window contains t wins. The MCP
  // layer keeps windows non-overlapping, so at most one is active at a time.
  const hl = node.transitions.find(
    (tr) => tr.type === 'highlight' && t >= tr.start && t <= tr.start + tr.duration,
  )
  if (hl && hl.type === 'highlight') {
    const u = clamp01((t - hl.start) / hl.duration)
    const ramp = Math.min(HIGHLIGHT_RAMP, 0.5)
    const strength =
      u < ramp ? u / ramp : u > 1 - ramp ? (1 - u) / ramp : 1
    highlight = { tex: hl.tex, cells: hl.cells, style: hl.style, color: hl.color, strength }
  }

  let texMorph: TexMorphState | null = null
  if (node.type === 'latex') {
    const chain = resolveMorphChain(
      node.transitions
        .filter((tr): tr is Extract<typeof tr, { type: 'texMorph' }> => tr.type === 'texMorph')
        .sort((a, b) => a.start - b.start)
        .map((m) => ({ start: m.start, duration: m.duration, easing: m.easing, value: m.toTex })),
      node.tex,
      t,
    )
    if (chain) texMorph = { fromTex: chain.from, toTex: chain.to, progress: chain.progress }
  }

  let cellMorph: CellMorphState | null = null
  if (node.type === 'matrix') {
    const chain = resolveMorphChain(
      node.transitions
        .filter((tr): tr is Extract<typeof tr, { type: 'cellMorph' }> => tr.type === 'cellMorph')
        .sort((a, b) => a.start - b.start)
        .map((m) => ({ start: m.start, duration: m.duration, easing: m.easing, value: m.toCells })),
      node.cells,
      t,
    )
    if (chain) cellMorph = { fromCells: chain.from, toCells: chain.to, progress: chain.progress }
  }

  const write = node.transitions.find((tr) => tr.type === 'write')
  if (write) {
    writeProgress = clamp01((t - write.start) / write.duration)
  }

  return {
    source: node,
    props,
    writeProgress,
    texMorph,
    cellMorph,
    projection: null,
    highlight,
    children: node.type === 'group' ? node.children.map((c) => resolveNode(c, t)) : [],
  }
}

/**
 * Sequential morphs of one kind chain in start-time order: each one's source is
 * whatever the previous left behind, so a node that has morphed three times is
 * showing the third result and not the original.
 *
 * Shared by `texMorph` and `cellMorph` because the chaining rule is the whole
 * behaviour and it is identical for both — only the thing being interpolated
 * differs, and neither is interpolated *here*: the stage does that, with glyph
 * or cell correspondence.
 */
function resolveMorphChain<V>(
  morphs: { start: number; duration: number; easing: Easing; value: V }[],
  base: V,
  t: number,
): { from: V; to: V; progress: number } | null {
  let current = base
  for (const m of morphs) {
    if (t >= m.start + m.duration) {
      current = m.value
    } else if (t > m.start) {
      const u = clamp01((t - m.start) / m.duration)
      return { from: current, to: m.value, progress: easings[m.easing](u) }
    } else {
      break
    }
  }
  // Past every morph: settle on the final value, fully progressed. Identity
  // against `base` rather than equality, so a morph back to the original value
  // still reports as "morphed" and the stage keeps drawing the same way.
  return current === base ? null : { from: current, to: current, progress: 1 }
}

/** Keyframes must be sorted by t (the reducer guarantees this on track.set). */
export function sampleKeyframes(kfs: Keyframe[], t: number): KeyValue {
  const first = kfs[0]!
  if (t <= first.t) return first.value
  const last = kfs[kfs.length - 1]!
  if (t >= last.t) return last.value
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!
    const b = kfs[i + 1]!
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t
      const u = span <= 0 ? 1 : (t - a.t) / span
      return lerpValue(a.value, b.value, easings[b.easing](u))
    }
  }
  return last.value
}

export function lerpValue(a: KeyValue, b: KeyValue, u: number): KeyValue {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * u
  if (typeof a === 'object' && typeof b === 'object') return lerpVec2(a, b, u)
  if (typeof a === 'string' && typeof b === 'string') return lerpColor(a, b, u)
  return u < 1 ? a : b
}

function lerpVec2(a: Vec2, b: Vec2, u: number): Vec2 {
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
}

export function lerpColor(a: string, b: string, u: number): string {
  const ca = hexToRgb(a)
  const cb = hexToRgb(b)
  const r = Math.round(ca[0] + (cb[0] - ca[0]) * u)
  const g = Math.round(ca[1] + (cb[1] - ca[1]) * u)
  const bch = Math.round(ca[2] + (cb[2] - ca[2]) * u)
  return `#${hex2(r)}${hex2(g)}${hex2(bch)}`
}

function hexToRgb(c: string): [number, number, number] {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
}

function hex2(n: number): string {
  return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
}
