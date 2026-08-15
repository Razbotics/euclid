import {
  ANIMATABLE_PROPS,
  type EuclidNode,
  type KeyValue,
  type Keyframe,
  type Scene,
  type Vec2,
} from '@euclid/dsl'
import { clamp01, easings } from './easing'

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
  style: 'box' | 'underline' | 'color' | 'spotlight'
  color: string
  /** 0 → invisible, 1 → fully drawn. Ramps up, holds, ramps down. */
  strength: number
}

export interface ResolvedNode {
  source: EuclidNode
  /** Animatable properties, resolved at t (base value unless a track overrides it). */
  props: Record<string, KeyValue>
  /** null = no write transition on this node. 0 = not yet drawn (invisible). */
  writeProgress: number | null
  texMorph: TexMorphState | null
  highlight: HighlightState | null
  children: ResolvedNode[]
}

export function resolveScene(scene: Scene, t: number): ResolvedNode[] {
  return scene.nodes.map((n) => resolveNode(n, t))
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
  let texMorph: TexMorphState | null = null

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
    highlight = { tex: hl.tex, style: hl.style, color: hl.color, strength }
  }

  const morphs = node.transitions
    .filter((tr): tr is Extract<typeof tr, { type: 'texMorph' }> => tr.type === 'texMorph')
    .sort((a, b) => a.start - b.start)
  if (node.type === 'latex' && morphs.length > 0) {
    let currentTex = node.tex
    for (const m of morphs) {
      if (t >= m.start + m.duration) {
        currentTex = m.toTex
      } else if (t > m.start) {
        const u = clamp01((t - m.start) / m.duration)
        texMorph = { fromTex: currentTex, toTex: m.toTex, progress: easings[m.easing](u) }
        break
      } else {
        break
      }
    }
    if (!texMorph && currentTex !== node.tex) {
      // past all morphs: settle on the final tex, fully progressed
      texMorph = { fromTex: currentTex, toTex: currentTex, progress: 1 }
    }
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
    highlight,
    children: node.type === 'group' ? node.children.map((c) => resolveNode(c, t)) : [],
  }
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
