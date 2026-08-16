import {
  SCHEMA_VERSION,
  type Camera,
  type Canvas,
  type EuclidDoc,
  type EuclidNode,
  type Scene,
} from './document'
import { LONG_TAIL_SEC, pacingSummary, scenePacing } from './narration'

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`
}

export function docDuration(doc: EuclidDoc): number {
  return doc.scenes.reduce((s, sc) => s + sc.duration, 0)
}

export interface SceneAt {
  scene: Scene
  sceneIndex: number
  /** seconds into the scene */
  localT: number
  /** global start time of the scene */
  sceneStart: number
}

/**
 * Map global timeline time → (scene, scene-local time). Clamps to the final
 * frame when t runs past the end, so scrubbing/rendering never lands nowhere.
 */
export function globalToScene(doc: EuclidDoc, t: number): SceneAt | null {
  if (doc.scenes.length === 0) return null
  let acc = 0
  for (let i = 0; i < doc.scenes.length; i++) {
    const scene = doc.scenes[i]!
    if (t < acc + scene.duration) {
      return { scene, sceneIndex: i, localT: Math.max(0, t - acc), sceneStart: acc }
    }
    acc += scene.duration
  }
  const last = doc.scenes[doc.scenes.length - 1]!
  return {
    scene: last,
    sceneIndex: doc.scenes.length - 1,
    localT: last.duration,
    sceneStart: acc - last.duration,
  }
}

/**
 * The camera that changes nothing: centred on the canvas, unzoomed, unrolled.
 * Adding a camera to a scene must not move anything by itself, or every
 * framing call would start by undoing a surprise.
 */
export function defaultCamera(canvas: Canvas): Camera {
  return {
    position: { x: canvas.width / 2, y: canvas.height / 2 },
    zoom: 1,
    rotation: 0,
    // Zero yaw and pitch means "flat": the stage skips projection and depth
    // sorting entirely, so adding a camera never changes a 2D scene.
    yaw: 0,
    pitch: 0,
    distance: DEFAULT_CAMERA_DISTANCE,
    tracks: [],
  }
}

/**
 * How far the camera sits from the z=0 plane by default, in scene px.
 *
 * Chosen against the canvas rather than arbitrarily: at 2000 a node 400px
 * toward the viewer draws 25% larger and one 400px behind draws 17% smaller,
 * which reads as depth without the wide-angle distortion that makes a diagram
 * look like it is falling over.
 */
export const DEFAULT_CAMERA_DISTANCE = 2000

export interface FoundNode {
  node: EuclidNode
  /** The array that directly contains the node (scene root or a group's children). */
  siblings: EuclidNode[]
  index: number
}

export function findNode(nodes: EuclidNode[], id: string): FoundNode | null {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    if (n.id === id) return { node: n, siblings: nodes, index: i }
    if (n.type === 'group') {
      const hit = findNode(n.children, id)
      if (hit) return hit
    }
  }
  return null
}

export function collectNodeIds(nodes: EuclidNode[], into: string[] = []): string[] {
  for (const n of nodes) {
    into.push(n.id)
    if (n.type === 'group') collectNodeIds(n.children, into)
  }
  return into
}

export function emptyDoc(id: string, name: string): EuclidDoc {
  return {
    schema: SCHEMA_VERSION,
    id,
    name,
    canvas: { width: 1920, height: 1080, fps: 60 },
    scenes: [],
  }
}

/** Compact text outline of a doc — what MCP tools return so agents can iterate cheaply. */
export function outlineDoc(doc: EuclidDoc): string {
  const pace = pacingSummary(doc)
  const byScene = new Map(scenePacing(doc).map((p) => [p.sceneId, p]))
  const lines: string[] = [
    `project "${doc.name}" (${doc.id}) ${doc.canvas.width}x${doc.canvas.height}@${doc.canvas.fps}fps, ${docDuration(doc)}s total, ${doc.scenes.length} scene(s)` +
      // Surfaced because nothing else made dead air visible: narration is
      // scene-scoped, so silence accumulates in the gaps without any single
      // scene looking wrong.
      (pace.speechSec > 0 ? `, ${pace.silentSec.toFixed(1)}s silent (${pace.silentPct}%)` : ''),
  ]
  let start = 0
  for (const sc of doc.scenes) {
    const p = byScene.get(sc.id)!
    let narration = ''
    if (sc.narration) {
      narration = p.speechSec
        ? ` speech=${p.speechSec.toFixed(2)}s tail=${p.tailSec.toFixed(2)}s${p.tailSec > LONG_TAIL_SEC ? ' (long)' : ''}`
        : ' narration=text-only'
      narration += ` "${truncate(sc.narration.text, 60)}"`
    }
    lines.push(
      `  scene ${sc.id} "${sc.name}" [${start}s → ${start + sc.duration}s] bg=${sc.background}` +
        // A camera re-frames every node in the scene, so an outline that showed
        // node positions but not the camera would be describing coordinates
        // nobody is looking at.
        outlineCamera(sc) +
        narration,
    )
    outlineNodes(sc.nodes, lines, '    ')
    start += sc.duration
  }
  return lines.join('\n')
}

function outlineCamera(scene: Scene): string {
  const cam = scene.camera
  if (!cam) return ''
  const tracks = cam.tracks.length > 0 ? ` cam-tracks[${cam.tracks.map((t) => t.property).join(',')}]` : ''
  // yaw/pitch are what turn projection on, so they are worth a column even
  // when zero would have been the boring answer.
  const orbit =
    cam.yaw !== 0 || cam.pitch !== 0
      ? ` yaw=${round(cam.yaw)} pitch=${round(cam.pitch)} dist=${round(cam.distance)}`
      : ''
  return (
    ` cam@(${round(cam.position.x)},${round(cam.position.y)}) zoom=${round(cam.zoom)}` +
    (cam.rotation !== 0 ? ` roll=${round(cam.rotation)}rad` : '') +
    orbit +
    tracks
  )
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function outlineNodes(nodes: import('./document').EuclidNode[], lines: string[], indent: string): void {
  for (const n of nodes) {
    const anim = n.tracks.length > 0 ? ` tracks[${n.tracks.map((t) => t.property).join(',')}]` : ''
    const trans = n.transitions.length > 0 ? ` fx[${n.transitions.map((t) => t.type).join(',')}]` : ''
    const label =
      n.type === 'text'
        ? `"${truncate(n.text, 30)}"`
        : n.type === 'latex'
          ? `tex="${truncate(n.tex, 40)}"`
          : n.type === 'matrix'
            ? // Shape first: it is what every cell range is indexed against, and
              // an off-by-one row index is the obvious way to mis-address one.
              `${n.cells.length}x${n.cells[0]?.length ?? 0} [${truncate(n.cells.map((r) => r.join(' ')).join(' ; '), 44)}]`
            : n.type === 'tokens'
              ? `${n.labels.length} ${n.orientation === 'row' ? '→' : '↓'} [${truncate(n.labels.join(' '), 44)}]`
              : n.type === 'vector3'
                ? `(${n.from.x},${n.from.y},${n.from.z})→(${n.to.x},${n.to.y},${n.to.z})`
                : n.type === 'axes3d'
                  ? `size=${n.size}`
                  : n.type === 'points3'
                    ? `${n.points.length} points`
                    : ''
    lines.push(
      `${indent}${n.type} ${n.id}${n.name ? ` (${n.name})` : ''} ` +
        `@(${n.position.x},${n.position.y}${n.z !== undefined ? `,z=${n.z}` : ''}) ${label}${anim}${trans}`,
    )
    if (n.type === 'group') outlineNodes(n.children, lines, indent + '  ')
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
