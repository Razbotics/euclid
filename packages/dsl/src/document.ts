import { z } from 'zod'
import type { CellRange } from './grid'
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

/**
 * A point in the pseudo-3D space: scene pixels, `y` down, `z` **toward the
 * viewer**. Larger z is nearer, so it draws bigger and on top.
 */
export interface Vec3 extends Vec2 {
  z: number
}
export const Vec3Schema: z.ZodType<Vec3> = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
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
  // Depth, so a node can fly toward the camera on an ordinary track. Absent on
  // every node that has not opted into the third dimension, and `animate`
  // refuses a property the node does not have.
  'z',
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
   * Cells to mark on a `matrix` or `tokens` node — the structured counterpart
   * of `tex`. Same idea: name the part by what it *is* (row 2, cell (0,1))
   * rather than by where it landed on screen.
   */
  cells?: CellRange
  /**
   * `box` / `underline` draw a marker around the term. `color` recolours the
   * term itself and `spotlight` dims everything except it — both need
   * per-glyph rendering, so they apply only to a `tex`-targeted latex node
   * and fall back to `box` otherwise.
   */
  style: 'box' | 'underline' | 'color' | 'spotlight'
  color: Color
}
/**
 * A matrix restating itself: cells that appear in both grids move to their new
 * places, and only genuinely new or removed ones fade. The structured twin of
 * `texMorph`, matched by cell content instead of glyph code.
 */
export interface CellMorphTransition {
  type: 'cellMorph'
  start: number
  duration: number
  /** Row-major, like `MatrixNode.cells`. May change shape. */
  toCells: string[][]
  easing: Easing
}
/**
 * Ride a `path` node from one end to the other.
 *
 * The position it produces **overrides** the node's own from `start` onward,
 * which is what makes a token flowing along a curve one call instead of a
 * keyframe per bend.
 */
export interface FollowTransition {
  type: 'follow'
  start: number
  duration: number
  /** id of the `path` node to travel along. */
  pathId: string
  easing: Easing
  /** Turn the node to face the direction of travel. */
  orient: boolean
}
export type Transition =
  | WriteTransition
  | TexMorphTransition
  | HighlightTransition
  | CellMorphTransition
  | FollowTransition

const CellRangeSchema: z.ZodType<CellRange> = z.object({
  rows: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
  cols: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
})

/** Row-major grid of LaTeX cells; '' is an empty cell, not a missing one. */
const CellsSchema = z
  .array(z.array(z.string()).min(1))
  .min(1)
  .superRefine((rows, ctx) => {
    const width = rows[0]!.length
    if (rows.some((r) => r.length !== width)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `every row must have the same number of cells; got ${rows.map((r) => r.length).join(', ')}`,
      })
    }
    if (rows.length * width > LIMITS.maxCells) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${rows.length}x${width} exceeds the ${LIMITS.maxCells}-cell limit for one node`,
      })
    }
  })

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
    cells: CellRangeSchema.optional(),
    style: z.enum(['box', 'underline', 'color', 'spotlight']),
    color: ColorSchema,
  }),
  z.object({
    type: z.literal('cellMorph'),
    start: z.number().min(0),
    duration: z.number().positive(),
    toCells: CellsSchema,
    easing: EasingSchema,
  }),
  z.object({
    type: z.literal('follow'),
    start: z.number().min(0),
    duration: z.number().positive(),
    pathId: z.string().min(1),
    easing: EasingSchema,
    orient: z.boolean(),
  }),
])

// ---------- nodes ----------

interface NodeBase {
  id: string
  name?: string
  position: Vec2
  /**
   * Depth, toward the viewer. Omitted means the node lives on the z=0 plane —
   * which is where every 2D node lives, so plain scenes are unaffected.
   */
  z?: number
  /**
   * Pinned to the frame: the node ignores the camera entirely — pan, zoom,
   * roll and orbit alike — and draws over the scene at its own coordinates.
   *
   * For captions, titles and legends. Without it every root node in an
   * orbiting scene is part of the world being turned, which is correct and is
   * not what anyone wants of a label: milestone run 6 watched its caption
   * drift across the frame and grow 46% as the space rotated behind it.
   * Applies at the scene root; a child inherits its group's transform, so a
   * pinned child of a moving group is a contradiction and the flag is ignored.
   */
  fixed?: boolean
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
  /** Omitted = unfilled outline. Painting the background colour instead would
   *  occlude whatever is behind it and break the moment a background is not flat. */
  fill?: Color
  cornerRadius: number
  stroke?: Color
  strokeWidth: number
}
export interface CircleNode extends NodeBase {
  type: 'circle'
  radius: number
  /** Omitted = unfilled ring. See RectNode.fill. */
  fill?: Color
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
/**
 * A grid of LaTeX cells, addressable by row and column.
 *
 * One node rather than a group of positioned latex nodes, because the *shape*
 * is the point: `highlight` can mark row 2 without anyone computing where row 2
 * landed, a morph can match cells by content, and a reveal can go cell by cell.
 * Built by hand, a 3x3 matrix is nine nodes whose ids the caller has to keep
 * straight and whose alignment breaks the moment the font size changes.
 *
 * Cells sit on a fixed pitch (`cellWidth` x `cellHeight`) with their contents
 * centred — see grid.ts for why nothing is measured.
 */
export interface MatrixNode extends NodeBase {
  type: 'matrix'
  /** Row-major. Every row the same length; '' is an empty cell. */
  cells: string[][]
  cellWidth: number
  cellHeight: number
  fontSize: number
  color: Color
  /** Delimiters around the grid, sized to it. */
  brackets: 'square' | 'paren' | 'none'
}

/**
 * A labelled strip — words, indices, layer names — laid out in a row or a
 * column, optionally boxed. The thing arrows will connect in Phase D.
 *
 * Separate from `matrix` because its content is prose rather than mathematics:
 * labels render as text, so a token reads as `cat` rather than as
 * `\text{cat}` typeset in an italic math font.
 */
export interface TokensNode extends NodeBase {
  type: 'tokens'
  labels: string[]
  orientation: 'row' | 'column'
  cellWidth: number
  cellHeight: number
  fontSize: number
  color: Color
  fontFamily: string
  /** Outline around each token; omitted draws the labels bare. */
  boxStroke?: Color
  /** Fill behind each token. */
  boxFill?: Color
}

/**
 * An arrow in space: `from` and `to` are 3D offsets from the node's anchor,
 * the same convention `line` uses in 2D.
 *
 * Its own node type rather than a line with a z, because both ends have to be
 * projected separately — a vector spanning depth is not a single point with a
 * depth, and drawing it as one is exactly the "flat overlapping lines" failure
 * this phase exists to avoid.
 */
export interface Vector3Node extends NodeBase {
  type: 'vector3'
  from: Vec3
  to: Vec3
  stroke: Color
  strokeWidth: number
  /** Arrowhead length in px at the focus plane; 0 draws a bare segment. */
  headSize: number
}

/** A coordinate frame: three arrows from the anchor, one per axis. */
export interface Axes3dNode extends NodeBase {
  type: 'axes3d'
  /** Length of each positive axis, in scene px. */
  size: number
  colorX: Color
  colorY: Color
  colorZ: Color
  strokeWidth: number
  /** Draw the negative half of each axis too, dimmer. */
  negative: boolean
}

/** A cloud of dots, each scaled and dimmed by its own depth. */
export interface Points3Node extends NodeBase {
  type: 'points3'
  points: Vec3[]
  radius: number
  fill: Color
}

/**
 * Either end of an arrow: a node to track, or a fixed point.
 *
 * Anchoring to a node is the whole point — the arrow recomputes its endpoints
 * every frame from where the node actually *is*, so a diagram whose parts move
 * keeps its connections instead of leaving them behind.
 */
export type ArrowEnd = { node: string; cells?: CellRange } | { at: Vec2 }
const ArrowEndSchema: z.ZodType<ArrowEnd> = z.union([
  // `cells` narrows the anchor to part of a matrix or token strip, so an arrow
  // can point at one cell rather than at the middle of the whole grid.
  z.object({ node: z.string().min(1), cells: CellRangeSchema.optional() }),
  z.object({ at: Vec2Schema }),
])

export interface ArrowNode extends NodeBase {
  type: 'arrow'
  from: ArrowEnd
  to: ArrowEnd
  stroke: Color
  strokeWidth: number
  /** Arrowhead length in px; 0 draws a bare connector. */
  headSize: number
  /**
   * Sideways bow as a fraction of the straight-line distance. 0 is straight;
   * ±0.2 is a gentle arc. Two arrows between the same pair curve apart.
   */
  curve: number
  /** Clearance left between the arrow and the edge of an anchored node. */
  gap: number
}

/**
 * A 2D coordinate frame: axis lines, ticks, numbers, optional grid.
 *
 * It owns the **mapping** — the rectangle it occupies and the function-space
 * ranges across it — which is the point. A curve plotted into the same axes
 * inherits that mapping instead of restating it, so the two cannot disagree;
 * run 4 lost fifteen re-lays to a curve and its reference frame having been
 * derived separately.
 *
 * Its geometry is absolute canvas coordinates, like a plotted `path`, so both
 * live in one space with no second transform to keep in step. Group them if
 * they need to move together.
 */
export interface AxesNode extends NodeBase {
  type: 'axes'
  /** The plot area in canvas px: top-left corner and size. */
  rect: { x: number; y: number; width: number; height: number }
  /** Function-space extent across the rectangle. */
  xRange: [number, number]
  yRange: [number, number]
  /** Tick spacing in function units. Omitted = chosen to land on round numbers. */
  xStep?: number
  yStep?: number
  color: Color
  strokeWidth: number
  /** Numbers beside the ticks. */
  labels: boolean
  fontSize: number
  /** Faint lines across the plot at every tick. */
  grid: boolean
  /** Axis names, drawn at the far end of each axis. */
  xLabel?: string
  yLabel?: string
}

export interface GroupNode extends NodeBase {
  type: 'group'
  children: EuclidNode[]
}
export type EuclidNode =
  | RectNode
  | CircleNode
  | LineNode
  | PathNode
  | TextNode
  | LatexNode
  | MatrixNode
  | TokensNode
  | Vector3Node
  | Axes3dNode
  | Points3Node
  | ArrowNode
  | AxesNode
  | GroupNode

const NodeBaseShape = {
  id: z.string().min(1),
  name: z.string().optional(),
  position: Vec2Schema,
  z: z.number().finite().optional(),
  fixed: z.boolean().optional(),
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
      fill: ColorSchema.optional(),
      cornerRadius: z.number().min(0),
      stroke: ColorSchema.optional(),
      strokeWidth: z.number().min(0),
    }),
    z.object({
      ...NodeBaseShape,
      type: z.literal('circle'),
      radius: z.number().positive(),
      fill: ColorSchema.optional(),
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
      type: z.literal('matrix'),
      cells: CellsSchema,
      cellWidth: z.number().positive(),
      cellHeight: z.number().positive(),
      fontSize: z.number().positive(),
      color: ColorSchema,
      brackets: z.enum(['square', 'paren', 'none']),
    }),
    z.object({
      ...NodeBaseShape,
      type: z.literal('tokens'),
      labels: z.array(z.string()).min(1).max(LIMITS.maxCells),
      orientation: z.enum(['row', 'column']),
      cellWidth: z.number().positive(),
      cellHeight: z.number().positive(),
      fontSize: z.number().positive(),
      color: ColorSchema,
      fontFamily: z.string().min(1),
      boxStroke: ColorSchema.optional(),
      boxFill: ColorSchema.optional(),
    }),
    z.object({
      ...NodeBaseShape,
      type: z.literal('vector3'),
      from: Vec3Schema,
      to: Vec3Schema,
      stroke: ColorSchema,
      strokeWidth: z.number().positive(),
      headSize: z.number().min(0),
    }),
    z.object({
      ...NodeBaseShape,
      type: z.literal('axes3d'),
      size: z.number().positive(),
      colorX: ColorSchema,
      colorY: ColorSchema,
      colorZ: ColorSchema,
      strokeWidth: z.number().positive(),
      negative: z.boolean(),
    }),
    z.object({
      ...NodeBaseShape,
      type: z.literal('points3'),
      points: z.array(Vec3Schema).min(1).max(LIMITS.maxPoints),
      radius: z.number().positive(),
      fill: ColorSchema,
    }),
    z.object({
      ...NodeBaseShape,
      type: z.literal('arrow'),
      from: ArrowEndSchema,
      to: ArrowEndSchema,
      stroke: ColorSchema,
      strokeWidth: z.number().positive(),
      headSize: z.number().min(0),
      curve: z.number().finite(),
      gap: z.number().min(0),
    }),
    z.object({
      ...NodeBaseShape,
      type: z.literal('axes'),
      rect: z.object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().positive(),
        height: z.number().positive(),
      }),
      xRange: z.tuple([z.number().finite(), z.number().finite()]),
      yRange: z.tuple([z.number().finite(), z.number().finite()]),
      xStep: z.number().positive().optional(),
      yStep: z.number().positive().optional(),
      color: ColorSchema,
      strokeWidth: z.number().positive(),
      labels: z.boolean(),
      fontSize: z.number().positive(),
      grid: z.boolean(),
      xLabel: z.string().optional(),
      yLabel: z.string().optional(),
    }),
    z.object({
      ...NodeBaseShape,
      type: z.literal('group'),
      children: z.array(NodeSchema).max(LIMITS.maxNodesPerScene),
    }),
  ]),
) as z.ZodType<EuclidNode>

// ---------- camera ----------

export const CAMERA_PROPS = ['position', 'zoom', 'rotation', 'yaw', 'pitch', 'distance'] as const
export type CameraProp = (typeof CAMERA_PROPS)[number]

/** Same keyframe machinery as a node track, restricted to what a camera has. */
export interface CameraTrack {
  property: CameraProp
  keyframes: Keyframe[]
}
export const CameraTrackSchema: z.ZodType<CameraTrack> = z.object({
  property: z.enum(CAMERA_PROPS),
  keyframes: z.array(KeyframeSchema).min(1),
})

/**
 * Which part of the scene the frame shows.
 *
 * A node's `position` is where it *is*; the camera decides what is looked at,
 * which is what lets a diagram be laid out larger than the canvas and still be
 * legible piece by piece. Deliberately not a node: a camera inside the tree
 * would inherit its parent's transform, and the frame is not something a group
 * can own. Deliberately not a new animation mechanism either — it is keyframed
 * by the same `Track` shape as everything else.
 */
export interface Camera {
  /** The scene point shown at the centre of the frame. */
  position: Vec2
  /** 1 = the canvas as laid out. 2 shows half as much, twice as large. */
  zoom: number
  /**
   * Camera roll in radians. Positive rolls the camera clockwise, so the scene
   * appears to turn counter-clockwise — the negation lives in the stage.
   */
  rotation: number
  /**
   * Radians about the vertical axis — the orbit. Positive swings +x toward the
   * viewer. Zero yaw *and* zero pitch means the scene is drawn flat, in
   * document order, with no projection at all.
   */
  yaw: number
  /** Radians about the horizontal axis. Positive lifts the camera, looking down. */
  pitch: number
  /**
   * How far the camera sits from the z=0 plane, in scene px. Smaller is a
   * wider lens: more perspective, stronger depth cues. Large is orthographic.
   */
  distance: number
  tracks: CameraTrack[]
}
export const CameraSchema: z.ZodType<Camera> = z.object({
  position: Vec2Schema,
  zoom: z.number().min(LIMITS.minCameraZoom).max(LIMITS.maxCameraZoom),
  rotation: z.number().finite(),
  // Defaulted rather than optional: a camera written before the third
  // dimension existed parses into a flat one, and every reader can treat the
  // three as always present.
  yaw: z.number().finite().default(0),
  pitch: z.number().finite().default(0),
  distance: z.number().min(LIMITS.minCameraDistance).max(LIMITS.maxCameraDistance).default(2000),
  tracks: z.array(CameraTrackSchema),
}) as z.ZodType<Camera>

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
  /** Absent = the frame is the canvas, untransformed. */
  camera?: Camera
}
export const SceneSchema: z.ZodType<Scene> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  duration: z.number().positive().max(LIMITS.maxDurationSec),
  background: ColorSchema,
  nodes: z.array(NodeSchema).max(LIMITS.maxNodesPerScene),
  narration: NarrationSchema.optional(),
  // Optional, so every document written before cameras existed stays valid and
  // SCHEMA_VERSION does not move.
  camera: CameraSchema.optional(),
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
