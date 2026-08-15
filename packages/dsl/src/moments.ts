import { collectNodeIds, docDuration } from './helpers'
import type { EuclidDoc, EuclidNode, Scene } from './document'

/**
 * A timestamp worth looking at, in global seconds.
 *
 * `why` is the reason this moment was picked, not a description of the frame —
 * nothing here has seen a pixel. A caller rendering these is reading a
 * *prediction* about where trouble hides, which is exactly what the document
 * can offer and a screenshot cannot.
 */
export interface KeyMoment {
  /** Global seconds, clamped inside the document. */
  t: number
  sceneId: string
  /** The node that made this moment interesting; absent for a scene opening. */
  nodeId?: string
  kind: 'scene' | 'texMorph' | 'write' | 'highlight'
  /** Where in the effect this lands: '25%', '50%', '75%', 'hold', 'open'. */
  phase: string
  /** One short line for a contact-sheet tile label. */
  label: string
}

/** Sampling points across a transition, as fractions of its duration. */
const TRAJECTORY = [0.25, 0.5, 0.75]

/**
 * Two moments closer together than this render as near-identical tiles, so the
 * later one is dropped. Chosen to be a couple of frames at 60fps: far enough
 * apart to differ, close enough that nothing interesting hides between them.
 */
const MIN_GAP_SEC = 0.05

/** Keep a scene opening off the very first frame, where a write has not started. */
const SCENE_OPEN_OFFSET = 0.1

export interface KeyMomentOptions {
  /**
   * Cap on how many moments come back. A 60s video has around a dozen; a
   * 10-minute one has hundreds, and a contact sheet of hundreds of tiles is
   * both unreadable and expensive to look at.
   */
  max?: number
}

const DEFAULT_MAX = 12

/**
 * The times in a document worth rendering, newest analysis first.
 *
 * Pure, like `scenePacing` and `documentCues`: the document already knows every
 * morph midpoint, highlight window and mid-reveal, and before this they were
 * worked out by hand — three separate times during the third milestone run.
 *
 * Transitions are sampled at 25/50/75% rather than only at the midpoint,
 * because the failure being hunted is usually a *trajectory* (an equation
 * re-laying out illegibly) rather than one bad frame. When the cap forces a
 * choice, the midpoints survive and the flanking samples go first — half a
 * trajectory is still worth more than a missing effect.
 */
export function keyMoments(doc: EuclidDoc, options: KeyMomentOptions = {}): KeyMoment[] {
  const max = options.max ?? DEFAULT_MAX
  const total = docDuration(doc)
  const picked: (KeyMoment & { priority: number })[] = []

  let sceneStart = 0
  for (const scene of doc.scenes) {
    // A scene's opening frame is where static layout errors live — two nodes
    // overlapping, a label off-centre. Those are invisible in an outline and
    // do not need an effect to be happening.
    picked.push({
      t: sceneStart + Math.min(SCENE_OPEN_OFFSET, scene.duration / 2),
      sceneId: scene.id,
      kind: 'scene',
      phase: 'open',
      label: `scene "${scene.name}"`,
      priority: 1,
    })

    for (const node of walk(scene.nodes)) {
      for (const tr of node.transitions) {
        const at = (fraction: number) => sceneStart + tr.start + tr.duration * fraction
        if (tr.type === 'texMorph') {
          for (const f of TRAJECTORY) {
            picked.push({
              t: at(f),
              sceneId: scene.id,
              nodeId: node.id,
              kind: 'texMorph',
              phase: `${f * 100}%`,
              label: `morph → ${truncate(tr.toTex, 28)}`,
              // The midpoint is the frame a re-layout looks worst in.
              priority: f === 0.5 ? 0 : 3,
            })
          }
        } else if (tr.type === 'write') {
          picked.push({
            t: at(0.5),
            sceneId: scene.id,
            nodeId: node.id,
            kind: 'write',
            phase: '50%',
            label: `write ${describe(node)}`,
            priority: 2,
          })
        } else if (tr.type === 'highlight') {
          // A highlight ramps in, holds, then ramps out, so the middle is the
          // only frame where it is at full strength — the one that shows
          // whether it landed on the right glyphs.
          picked.push({
            t: at(0.5),
            sceneId: scene.id,
            nodeId: node.id,
            kind: 'highlight',
            phase: 'hold',
            label: `highlight ${tr.tex ? truncate(tr.tex, 24) : describe(node)} (${tr.style})`,
            priority: 0,
          })
        }
      }
    }
    sceneStart += scene.duration
  }

  // Clamp inside the document: a transition may legitimately run past its
  // scene, and a time past the end would render the final frame twice.
  for (const m of picked) m.t = Math.max(0, Math.min(m.t, Math.max(0, total - 1e-3)))

  const byTime = [...picked].sort((a, b) => a.t - b.t || a.priority - b.priority)
  const deduped = byTime.filter(
    (m, i) => i === 0 || m.t - byTime[i - 1]!.t >= MIN_GAP_SEC,
  )
  if (deduped.length <= max) return deduped.map(strip)

  // Over budget: drop the lowest-priority samples first (the 25/75% flanks),
  // then thin what remains evenly across the timeline rather than truncating,
  // so a cap never means "only the first half of the video was looked at".
  const ranked = [...deduped].sort((a, b) => a.priority - b.priority || a.t - b.t)
  const cutoff = ranked[max - 1]!.priority
  const kept = deduped.filter((m) => m.priority < cutoff)
  const spare = deduped.filter((m) => m.priority === cutoff)
  const room = max - kept.length
  if (room > 0 && spare.length > room) {
    const step = spare.length / room
    for (let i = 0; i < room; i++) kept.push(spare[Math.floor(i * step)]!)
  } else if (room > 0) {
    kept.push(...spare)
  }
  return kept.sort((a, b) => a.t - b.t).slice(0, max).map(strip)
}

/** One line per moment — the same compact-text discipline the tools follow. */
export function formatMoments(moments: KeyMoment[]): string {
  if (moments.length === 0) return 'no key moments — the document has no scenes yet'
  return moments
    .map((m) => `t=${m.t.toFixed(2).padStart(6)}  ${m.kind.padEnd(9)} ${m.phase.padEnd(5)} ${m.label}`)
    .join('\n')
}

function strip(m: KeyMoment & { priority?: number }): KeyMoment {
  const { priority: _priority, ...rest } = m
  return rest
}

function* walk(nodes: EuclidNode[]): Generator<EuclidNode> {
  for (const n of nodes) {
    yield n
    if (n.type === 'group') yield* walk(n.children)
  }
}

function describe(node: EuclidNode): string {
  if (node.type === 'latex') return truncate(node.tex, 24)
  if (node.type === 'text') return `"${truncate(node.text, 20)}"`
  return `${node.type} ${node.id}`
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

/** Scene count is not the interesting number; nodes with effects is. */
export function momentSummary(doc: EuclidDoc): { scenes: number; nodes: number; effects: number } {
  let effects = 0
  let nodes = 0
  for (const scene of doc.scenes as Scene[]) {
    nodes += collectNodeIds(scene.nodes).length
    for (const node of walk(scene.nodes)) effects += node.transitions.length
  }
  return { scenes: doc.scenes.length, nodes, effects }
}
