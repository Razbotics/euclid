import { SCHEMA_VERSION, type EuclidDoc, type EuclidNode, type Scene } from './document'
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
      `  scene ${sc.id} "${sc.name}" [${start}s → ${start + sc.duration}s] bg=${sc.background}${narration}`,
    )
    outlineNodes(sc.nodes, lines, '    ')
    start += sc.duration
  }
  return lines.join('\n')
}

function outlineNodes(nodes: import('./document').EuclidNode[], lines: string[], indent: string): void {
  for (const n of nodes) {
    const anim = n.tracks.length > 0 ? ` tracks[${n.tracks.map((t) => t.property).join(',')}]` : ''
    const trans = n.transitions.length > 0 ? ` fx[${n.transitions.map((t) => t.type).join(',')}]` : ''
    const label =
      n.type === 'text' ? `"${truncate(n.text, 30)}"` : n.type === 'latex' ? `tex="${truncate(n.tex, 40)}"` : ''
    lines.push(
      `${indent}${n.type} ${n.id}${n.name ? ` (${n.name})` : ''} @(${n.position.x},${n.position.y}) ${label}${anim}${trans}`,
    )
    if (n.type === 'group') outlineNodes(n.children, lines, indent + '  ')
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
