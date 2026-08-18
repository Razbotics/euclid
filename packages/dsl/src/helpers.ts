import {
  SCHEMA_VERSION,
  type Camera,
  type Canvas,
  type EuclidDoc,
  type EuclidNode,
  type Scene,
} from './document'
import { LONG_TAIL_SEC, pacingSummary, planAudio, scenePacing } from './narration'
import { clipPlaySec } from './audio'

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

/** An effect that would run past a scene's end — see `effectsPastEnd`. */
export interface OverrunningEffect {
  /** Node id, or 'camera' for a camera track. */
  owner: string
  /** `write`, `texMorph`, `track position`, `camera yaw`… */
  what: string
  /** Scene-local second the effect finishes at. */
  endsAt: number
}

/**
 * Effects that finish after `duration` — what shortening a scene would orphan.
 *
 * Nothing is deleted when a scene shrinks: keyframes past the new end simply
 * stop being reached, so an effect is truncated rather than broken and every
 * frame still looks plausible. Milestone run 6 lost 1.6s off the end of a 9.5s
 * camera orbit that way, to `fit_scene_to_narration`, and caught it by
 * arithmetic rather than by anything the system said. This is what lets the
 * tools say it instead.
 */
export function effectsPastEnd(scene: Scene, duration: number): OverrunningEffect[] {
  const out: OverrunningEffect[] = []
  const walk = (nodes: EuclidNode[]): void => {
    for (const n of nodes) {
      for (const tr of n.transitions) {
        const endsAt = tr.start + tr.duration
        if (endsAt > duration) out.push({ owner: n.id, what: tr.type, endsAt })
      }
      for (const t of n.tracks) {
        const endsAt = t.keyframes[t.keyframes.length - 1]?.t ?? 0
        if (endsAt > duration) out.push({ owner: n.id, what: `track ${t.property}`, endsAt })
      }
      if (n.type === 'group') walk(n.children)
    }
  }
  walk(scene.nodes)
  // The camera is the one that bit hardest: an orbit is a scene-level effect
  // with no node to notice it under.
  for (const t of scene.camera?.tracks ?? []) {
    const endsAt = t.keyframes[t.keyframes.length - 1]?.t ?? 0
    if (endsAt > duration) out.push({ owner: 'camera', what: `camera ${t.property}`, endsAt })
  }
  return out.sort((a, b) => b.endsAt - a.endsAt)
}

/** One line naming what would be cut, for a tool response. */
export function formatOverruns(cut: OverrunningEffect[], duration: number): string {
  if (cut.length === 0) return ''
  const worst = cut
    .slice(0, 3)
    .map((c) => `${c.owner} ${c.what} ends ${c.endsAt.toFixed(2)}s`)
    .join(', ')
  return (
    ` — WARNING: ${cut.length} effect${cut.length > 1 ? 's' : ''} now run${cut.length > 1 ? '' : 's'} ` +
    `past the ${duration.toFixed(2)}s end and will never finish on screen (${worst}` +
    `${cut.length > 3 ? `, +${cut.length - 3} more` : ''}). Re-time them, or set a longer tail.`
  )
}

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
  // Audio tracks are document-level, so they cannot hang off a scene line —
  // and an agent that cannot see the music bed will happily generate a second
  // one. Muted lanes are listed *and* marked: invisible mute is how a render
  // comes back missing a sound nobody remembers turning off.
  //
  // Geometry from `planAudio`, never from the clip's own numbers: a 30s bed on
  // an 8s video *plays* for 8s, and an outline reporting 30 would be telling
  // the agent about audio the export throws away.
  const audioPlan = new Map(planAudio(doc).map((p) => [p.key, p]))
  for (const track of doc.audio ?? []) {
    lines.push(
      `  audio "${track.name}" (${track.id}) ${track.kind}` +
        (track.muted ? ' MUTED (silent in the export)' : '') +
        (track.gain !== undefined && track.gain !== 1 ? ` gain=${round(track.gain)}` : '') +
        ` ${track.clips.length} clip(s)`,
    )
    for (const clip of track.clips) {
      const play = audioPlan.get(clip.id)?.playSec ?? clipPlaySec(clip)
      const cut = play < clipPlaySec(clip) - 0.001
      lines.push(
        `    clip ${clip.id} [${round(clip.startSec)}s → ${round(clip.startSec + play)}s]` +
          (cut ? ` (cut from ${round(clipPlaySec(clip))}s at the end of the video)` : '') +
          ` asset=${clip.assetId}` +
          (clip.sourceInSec ? ` from=${round(clip.sourceInSec)}s` : '') +
          (clip.gain !== undefined && clip.gain !== 1 ? ` gain=${round(clip.gain)}` : '') +
          (clip.fadeInSec ? ` fadeIn=${round(clip.fadeInSec)}s` : '') +
          (clip.fadeOutSec ? ` fadeOut=${round(clip.fadeOutSec)}s` : '') +
          (clip.name ? ` "${truncate(clip.name, 40)}"` : ''),
      )
    }
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

/** `from`/`to` of an arrow: the node it tracks, or the fixed point. */
function arrowEnd(end: { node: string } | { at: { x: number; y: number } }): string {
  return 'node' in end ? end.node : `(${round(end.at.x)},${round(end.at.y)})`
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
                    : n.type === 'arrow'
                      ? // An arrow's identity is its endpoints; its own position is
                        // an offset that is almost always zero.
                        `${arrowEnd(n.from)} → ${arrowEnd(n.to)}`
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
