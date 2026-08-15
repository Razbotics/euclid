import { z } from 'zod'
import { LIMITS } from './limits'

export const SCHEMA_VERSION = 1 as const

// ---------- primitives ----------

export interface Vec2 {
  x: number
  y: number
}
export const Vec2Schema: z.ZodType<Vec2> = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
})

/** '#rrggbb' hex. */
export type Color = string
export const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb hex color')

export const EASINGS = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'smooth'] as const
export type Easing = (typeof EASINGS)[number]
export const EasingSchema = z.enum(EASINGS)

// ---------- animation ----------

export type KeyValue = number | Vec2 | Color
export const KeyValueSchema: z.ZodType<KeyValue> = z.union([
  z.number().finite(),
  Vec2Schema,
  ColorSchema,
])

/** `t` is seconds, local to the owning scene. `easing` shapes the segment arriving AT this keyframe. */
export interface Keyframe {
  t: number
  value: KeyValue
  easing: Easing
}
export const KeyframeSchema: z.ZodType<Keyframe> = z.object({
  t: z.number().min(0),
  value: KeyValueSchema,
  easing: EasingSchema,
})

export const ANIMATABLE_PROPS = [
  'position',
  'scale',
  'rotation',
  'opacity',
  'fill',
  'stroke',
  'color',
  'width',
  'height',
  'radius',
  'fontSize',
  'strokeWidth',
] as const
export type AnimatableProp = (typeof ANIMATABLE_PROPS)[number]

export interface Track {
  property: AnimatableProp
  keyframes: Keyframe[]
}
export const TrackSchema: z.ZodType<Track> = z.object({
  property: z.enum(ANIMATABLE_PROPS),
  keyframes: z.array(KeyframeSchema).min(1),
})

/**
 * Transitions are animated effects that are not expressible as property keyframes.
 * Sugar like fadeIn/moveTo lives in the MCP tool layer and compiles down to Tracks.
 */
export interface WriteTransition {
  type: 'write'
  start: number
  duration: number
}
export interface TexMorphTransition {
  type: 'texMorph'
  start: number
  duration: number
  toTex: string
  easing: Easing
}
/**
 * Draw attention to a node, or to one term inside an equation, for a while.
 *
 * `tex` names the part to mark by its LaTeX rather than by coordinates: the
 * agent knows it wants to point at `\frac{b}{a}`, but has no way to know where
 * that lands on screen. The engine renders the fragment, finds its glyph
 * sequence inside the node's, and marks exactly those glyphs.
 */
export interface HighlightTransition {
  type: 'highlight'
  start: number
  duration: number
  /** LaTeX of the sub-expression to mark; the whole node when absent. */
  tex?: string
  /**
   * `box` / `underline` draw a marker around the term. `color` recolours the
   * term itself and `spotlight` dims everything except it — both need
   * per-glyph rendering, so they apply only to a `tex`-targeted latex node
   * and fall back to `box` otherwise.
   */
  style: 'box' | 'underline' | 'color' | 'spotlight'
  color: Color
}
export type Transition = WriteTransition | TexMorphTransition | HighlightTransition
export const TransitionSchema: z.ZodType<Transition> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('write'),
    start: z.number().min(0),
    duration: z.number().positive(),
  }),
  z.object({
    type: z.literal('texMorph'),
    start: z.number().min(0),
    duration: z.number().positive(),
    toTex: z.string().min(1),
    easing: EasingSchema,
  }),
  z.object({
    type: z.literal('highlight'),
    start: z.number().min(0),
    duration: z.number().positive(),
    tex: z.string().min(1).optional(),
    style: z.enum(['box', 'underline', 'color', 'spotlight']),
    color: ColorSchema,
  }),
])

// ---------- nodes ----------

interface NodeBase {
  id: string
  name?: string
  position: Vec2
  scale: number
  /** Radians, about `position` — not degrees, and not about the node's bounds. */
  rotation: number
  opacity: number
  tracks: Track[]
  transitions: Transition[]
}

export interface RectNode extends NodeBase {
  type: 'rect'
  width: number
  height: number
  fill: Color
  cornerRadius: number
  stroke?: Color
  strokeWidth: number
}
export interface CircleNode extends NodeBase {
  type: 'circle'
  radius: number
  fill: Color
  stroke?: Color
  strokeWidth: number
}
export interface LineNode extends NodeBase {
  type: 'line'
  from: Vec2
  to: Vec2
  stroke: Color
  strokeWidth: number
}
/**
 * A polyline through `points`, which are relative to `position` — the same
 * convention as a line's `from`/`to`.
 *
 * Exists because a curve was otherwise nine separate `line` nodes: run 4's
 * parabola was 9 of its scene's 22 nodes, moved as nine things, and had to be
 * re-laid nine times when the scale changed. Deliberately dumb — it holds
 * sampled points, not a formula. Anything that *produces* those points
 * (plotting `y = f(x)`, mapping a domain to the canvas) is agent-facing sugar
 * that compiles down to this, which keeps the formula out of the document and
 * the purity invariant untouched.
 */
export interface PathNode extends NodeBase {
  type: 'path'
  /** At least two points, relative to `position`. */
  points: Vec2[]
  stroke: Color
  strokeWidth: number
  /** Join the last point back to the first. */
  closed: boolean
  /** Filled only when set; a plotted curve normally is not. */
  fill?: Color
}
export interface TextNode extends NodeBase {
  type: 'text'
  text: string
  fontSize: number
  fill: Color
  fontFamily: string
}
export interface LatexNode extends NodeBase {
  type: 'latex'
  tex: string
  color: Color
  fontSize: number
}
export interface GroupNode extends NodeBase {
  type: 'group'
  children: EuclidNode[]
}
export type EuclidNode = RectNode | CircleNode | LineNode | PathNode | TextNode | LatexNode | GroupNode

const NodeBaseShape = {
  id: z.string().min(1),
  name: z.string().optional(),
  position: Vec2Schema,
  scale: z.number().finite(),
  rotation: z.number().finite(),
  opacity: z.number().min(0).max(1),
  tracks: z.array(TrackSchema),
  transitions: z.array(TransitionSchema),
}

export const NodeSchema: z.ZodType<EuclidNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      ...NodeBaseShape,
      type: z.literal('rect'),
      width: z.number().positive(),
      height: z.number().positive(),
      fill: ColorSchema,
      cornerRadius: z.number().min(0),
      stroke: ColorSchema.optional(),
      strokeWidth: z.number().min(0),
    }),
    z.object({
      ...NodeBaseShape,
      type: z.literal('circle'),
      radius: z.number().positive(),
      fill: ColorSchema,
      stroke: ColorSchema.optional(),
      strokeWidth: z.number().min(0),
    }),
    z.object({
      ...NodeBaseShape,
      type: z.literal('line'),
      from: Vec2Schema,
      to: Vec2Schema,
      stroke: ColorSchema,
      strokeWidth: z.number().positive(),
    }),
    z.object({
      ...NodeBaseShape,
      type: z.literal('path'),
      // Two points is the minimum that draws anything; below that a path is a
      // point, which is a circle.
      points: z.array(Vec2Schema).min(2),
      stroke: ColorSchema,
      strokeWidth: z.number().positive(),
      closed: z.boolean(),
      fill: ColorSchema.optional(),
    }),
    z.object({
      ...NodeBaseShape,
      type: z.literal('text'),
      text: z.string(),
      fontSize: z.number().positive(),
      fill: ColorSchema,
      fontFamily: z.string().min(1),
    }),
    z.object({
      ...NodeBaseShape,
      type: z.literal('latex'),
      tex: z.string().min(1),
      color: ColorSchema,
      fontSize: z.number().positive(),
    }),
    z.object({
      ...NodeBaseShape,
      type: z.literal('group'),
      children: z.array(NodeSchema).max(LIMITS.maxNodesPerScene),
    }),
  ]),
) as z.ZodType<EuclidNode>

// ---------- narration / scene / document ----------

export interface NarrationWord {
  word: string
  start: number
  end: number
}
export interface NarrationAudio {
  assetId: string
  durationSec: number
  words?: NarrationWord[]
}
export interface Narration {
  text: string
  voiceId?: string
  audio?: NarrationAudio
}
export const NarrationSchema: z.ZodType<Narration> = z.object({
  text: z.string(),
  voiceId: z.string().optional(),
  audio: z
    .object({
      assetId: z.string().min(1),
      durationSec: z.number().positive(),
      words: z
        .array(z.object({ word: z.string(), start: z.number().min(0), end: z.number().min(0) }))
        .optional(),
    })
    .optional(),
})

export interface Scene {
  id: string
  name: string
  duration: number
  background: Color
  nodes: EuclidNode[]
  narration?: Narration
}
export const SceneSchema: z.ZodType<Scene> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  duration: z.number().positive().max(LIMITS.maxDurationSec),
  background: ColorSchema,
  nodes: z.array(NodeSchema).max(LIMITS.maxNodesPerScene),
  narration: NarrationSchema.optional(),
})

export interface Canvas {
  width: number
  height: number
  fps: 30 | 60
}
export const CanvasSchema: z.ZodType<Canvas> = z.object({
  width: z.number().int().min(16).max(LIMITS.maxCanvasWidth),
  height: z.number().int().min(16).max(LIMITS.maxCanvasHeight),
  fps: z.union([z.literal(30), z.literal(60)]),
})

export interface EuclidDoc {
  schema: typeof SCHEMA_VERSION
  id: string
  name: string
  canvas: Canvas
  scenes: Scene[]
}
export const EuclidDocSchema: z.ZodType<EuclidDoc> = z
  .object({
    schema: z.literal(SCHEMA_VERSION),
    id: z.string().min(1),
    name: z.string().min(1),
    canvas: CanvasSchema,
    scenes: z.array(SceneSchema).max(LIMITS.maxScenes),
  })
  .superRefine((doc, ctx) => {
    const total = doc.scenes.reduce((s, sc) => s + sc.duration, 0)
    if (total > LIMITS.maxDurationSec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `total duration ${total}s exceeds limit of ${LIMITS.maxDurationSec}s`,
      })
    }
    const ids = new Set<string>()
    for (const sc of doc.scenes) {
      if (ids.has(sc.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate scene id ${sc.id}` })
      }
      ids.add(sc.id)
    }
  }) as z.ZodType<EuclidDoc>
