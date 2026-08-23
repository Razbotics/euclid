import { z } from 'zod'
import {
  anchorTime,
  describeRange,
  op,
  type Easing,
  type TimeAnchor,
  type Track,
  type Transition,
  LIMITS,
} from '@euclid/dsl'
import { resolveNode } from '@euclid/engine'
import { COLOR, EASING, NODE_ID, NUMBERISH, PROJECT_ID, SCENE_ID, SECONDS } from './schemas'
import { CELLS_ARG, checkRange, gridOrThrow } from './tools-grid'
import { capability, said, CapabilityError } from './types'

/**
 * Timing an effect to the narration instead of to a number.
 *
 * Kept in one constant because three capabilities offer it and a rule that is
 * explained three ways is explained none.
 */
const AT_WORD = z
  .string()
  .min(1)
  .optional()
  .describe('start when this narrated word is spoken, instead of at `start`')
const AT_WORD_NTH = z
  .number()
  .int()
  .min(1)
  .default(1)
  .describe('which occurrence of atWord, 1-based')
const AT_WORD_OFFSET = z
  .number()
  .finite()
  .default(0)
  .describe('seconds before (negative) or after the word begins')

const ANCHOR_DOC = [
  '**`atWord` times this to the narration rather than to the clock.** Pass a word from the scene\'s script and the effect fires when it is spoken — so a term lights up as it is said, and re-generating the narration with different phrasing re-syncs it instead of silently leaving it behind. This is the same idea as `connect` taking node ids rather than coordinates: anchored, not positioned.',
  '',
  'The anchor is stored in the document and resolved every time the frame is sampled, so it costs nothing and stays true. `atWordOffset` shifts it — negative to lead the word, positive to trail it. Use `get_narration_timing` to see which words are available and when.',
  '',
  'If the word is not spoken in that scene the written `start` is used instead, so an anchor can never break a render. The response says which of the two you got.',
].join('\n')

/**
 * `start` is optional once `atWord` exists, because an anchored effect has no
 * number to give — but one of the two has to be there, or the call has not
 * said when. Refusing is better than defaulting to 0, which would put the
 * effect at the top of the scene and look deliberate.
 */
function requireWhen(start: number | undefined, atWord: string | undefined): number {
  if (start === undefined && !atWord) {
    throw new CapabilityError(
      'say when: pass `start` in scene-local seconds, or `atWord` to fire on a narrated word ' +
        '(get_narration_timing lists them). With both, the word wins and `start` is the ' +
        'fallback for when it is not spoken.',
    )
  }
  return start ?? 0
}

/** Build the anchor an effect carries, and describe what it resolved to. */
function anchorFor(
  scene: { narration?: { audio?: { words?: { word: string; start: number; end: number }[] } } },
  atWord: string | undefined,
  occurrence: number,
  offsetSec: number,
  start: number,
): { anchor?: TimeAnchor; start: number; note: string } {
  if (!atWord) return { start, note: '' }
  const anchor: TimeAnchor = {
    word: atWord,
    ...(occurrence !== 1 ? { occurrence } : {}),
    ...(offsetSec !== 0 ? { offsetSec } : {}),
  }
  const at = anchorTime(scene.narration?.audio?.words, anchor)
  if (at === null) {
    return {
      anchor,
      start,
      note:
        ` — "${atWord}" is not in this scene's generated narration yet, so it plays at ` +
        `${start}s for now and will move to the word once generate_narration has run`,
    }
  }
  return { anchor, start: at, note: ` — anchored to "${atWord}" at ${at.toFixed(2)}s` }
}

/** Transitions that do not overlap [start, start+duration). */
const outside = (t: Transition, start: number, duration: number): boolean =>
  t.start + t.duration <= start || start + duration <= t.start

/**
 * A value any animatable property can take. NUMBERISH first: a colour like
 * "#ff0000" fails it and falls through to COLOR, while "1.12" is accepted
 * where a bare z.number() would not.
 */
const ANIM_VALUE = z.union([NUMBERISH, z.object({ x: NUMBERISH, y: NUMBERISH }), COLOR])

/**
 * Which of the three shapes a value is.
 *
 * Only needed since `animate` began taking a whole list: one mistyped entry
 * among hundreds is the failure that form invites, and a position track
 * holding a bare number samples as a number and puts the node at (NaN, NaN) —
 * a wrong render with nothing in the document that looks wrong.
 */
function shapeOf(v: unknown): 'point' | 'colour' | 'number' {
  if (v !== null && typeof v === 'object') return 'point'
  return typeof v === 'string' ? 'colour' : 'number'
}

export const animTools = [
  capability({
    name: 'animate',
    summary:
      'Keyframe one property — one move with `to`, or a whole path with `keyframes` (rotation in radians).',
    doc: [
      'The generic motion primitive. The start value is **sampled from the document at `start`**, never assumed — so animations chain continuously and you never have to restate where something already is.',
      '',
      'Properties: `position` ({x,y}), `z`/`scale`/`rotation`/`opacity`/`width`/`height`/`radius`/`fontSize`/`strokeWidth` (number), `fill`/`stroke`/`color` (#rrggbb).',
      '',
      '`z` is depth, toward the viewer — animating it flies a node at the camera. It only exists on a node you gave a `z` to, and only shows once the camera has a yaw or pitch.',
      '',
      '**`rotation` is in RADIANS, not degrees** — a quarter turn is 1.5708, not 90. Degrees are the natural guess and the call will succeed with a wildly wrong value: 90 wraps more than fourteen full turns. Convert with `degrees × π / 180`. A node rotates about its own `position`, so a line pivots about its anchor rather than its midpoint.',
      '',
      'Existing keyframes for that property **after `start` are replaced**, so re-calling to revise a move works; keyframes before `start` are kept, which is what makes a chain of calls compose.',
      '',
      '**Pass `keyframes` instead when the motion is not one move.** `[{t, value}, …]` builds the whole track in a single call — `t` in scene-local seconds, ascending, each `value` the same shape as the property. Per-keyframe `easing` is optional and inherits the call\'s.',
      '',
      'This is the form for anything whose speed varies along the way: a planet that races near its star and dawdles far from it, a bouncing ball, a needle that overshoots and settles. `flow_along` rides a path at a *constant* speed and its easing is one curve over the whole trip, so it cannot say "fast, slow, fast" — that has to be a track. A real run spent **48 of its 95 calls** building two such motions one segment at a time before this existed.',
      '',
      'Keyframes before the first `t` are kept, exactly as with `to`, so this composes with earlier calls. But a track holds its first value *backwards in time*: if nothing precedes your first keyframe and it is not at 0, the node shows that value from the scene\'s opening rather than waiting. The result says so when it applies.',
      '',
      `Up to ${LIMITS.maxKeyframesPerTrack} keyframes on one property. Sample as finely as the motion needs — the sampler interpolates between whatever you give it, and 200 keyframes cost no more to render than 2.`,
      '',
      'Times are scene-local seconds. An animation running past the scene end simply never finishes on screen — check the scene duration in get_project.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      nodeId: NODE_ID,
      property: z.enum([
        'position', 'z', 'scale', 'rotation', 'opacity', 'fill', 'stroke', 'color',
        'width', 'height', 'radius', 'fontSize', 'strokeWidth',
      ]),
      // NUMBERISH first: a colour like "#ff0000" fails it and falls through to
      // COLOR, while "1.12" is accepted where a bare z.number() would not.
      to: ANIM_VALUE.optional(),
      start: SECONDS.optional(),
      duration: z.number().positive().optional(),
      easing: EASING,
      keyframes: z
        .array(
          z.object({
            t: SECONDS,
            value: ANIM_VALUE,
            /** No default: an omitted per-keyframe easing inherits the call's. */
            easing: z
              .enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'smooth'])
              .optional(),
          }),
        )
        .min(2)
        .max(LIMITS.maxKeyframesPerTrack)
        .optional()
        .describe('the whole path at once, instead of to/start/duration'),
    }),
    async handler(ctx, a) {
      const { projectId, sceneId, nodeId, property, easing, keyframes } = a
      const oneShot = a.to !== undefined
      if (oneShot === (keyframes !== undefined)) {
        throw new CapabilityError(
          keyframes
            ? 'give either `to` (one move) or `keyframes` (a whole path), not both — ' +
              'they would describe two different tracks'
            : 'nothing to animate: give `to` with `start`/`duration` for one move, ' +
              'or `keyframes` for a whole path in one call',
        )
      }
      const { doc } = await ctx.getDoc(projectId)
      const node = ctx.nodeOrThrow(doc, sceneId, nodeId)

      if (keyframes) {
        // Ascending and distinct. The reducer sorts keyframes, so an
        // out-of-order list would be silently reordered into a motion the
        // caller did not describe — and two keyframes at one time are
        // ambiguous rather than wrong-looking.
        for (let i = 1; i < keyframes.length; i++) {
          if (keyframes[i]!.t <= keyframes[i - 1]!.t) {
            throw new CapabilityError(
              `keyframes must be in ascending time order: [${i - 1}] is at ` +
                `${keyframes[i - 1]!.t}s and [${i}] is at ${keyframes[i]!.t}s. ` +
                `They are sorted before use, so an unsorted list would animate ` +
                `something you did not ask for.`,
            )
          }
        }
        // One bad entry in a list of hundreds is the failure this form invites,
        // and a position track holding a bare number would sample as a number
        // and place the node at (NaN, NaN). Checked against the property's
        // CURRENT value, so the shape is the node's own rather than a guess.
        const current = resolveNode(node, keyframes[0]!.t).props[property]
        if (current === undefined) {
          throw new CapabilityError(
            `property ${property} does not exist on ${node.type} node ${nodeId}`,
          )
        }
        const wanted = shapeOf(current)
        for (const [i, k] of keyframes.entries()) {
          if (shapeOf(k.value) !== wanted) {
            throw new CapabilityError(
              `keyframe [${i}] at ${k.t}s is ${shapeOf(k.value)}, but ${property} on ` +
                `${nodeId} is ${wanted} — every keyframe must be the same shape ` +
                `(${wanted === 'point' ? '{"x":…,"y":…}' : wanted === 'colour' ? '"#rrggbb"' : 'a number'}).`,
            )
          }
        }
        const first = keyframes[0]!
        const existing = node.tracks.find((t) => t.property === property)
        const keep = existing ? existing.keyframes.filter((k) => k.t < first.t) : []
        const track: Track = {
          property,
          keyframes: [
            ...keep,
            ...keyframes.map((k) => ({
              t: k.t,
              value: k.value,
              easing: (k.easing ?? easing) as Easing,
            })),
          ],
        }
        await ctx.submit(projectId, [op.setTrack(sceneId, nodeId, track)])
        const last = keyframes[keyframes.length - 1]!
        // A track's first keyframe is held backwards in time, so starting at
        // 2s does not mean "stay put until 2s" — it means the node shows that
        // value from the scene's opening. Said rather than silently fixed:
        // sometimes it is exactly what was wanted.
        const jumps = first.t > 0 && keep.length === 0
        return said(
          `animating ${nodeId}.${property} across ${keyframes.length} keyframes over ` +
            `[${first.t}s, ${last.t}s]` +
            (keep.length ? `, keeping ${keep.length} earlier keyframe(s)` : '') +
            `
from ${JSON.stringify(first.value)} to ${JSON.stringify(last.value)}` +
            (jumps
              ? `
WARNING: the first keyframe is at ${first.t}s and nothing precedes it, so ` +
                `${nodeId} shows ${JSON.stringify(first.value)} from the scene's opening ` +
                `rather than holding its own position until then. Add a keyframe at 0, or ` +
                `animate into this from an earlier call.`
              : ''),
          { nodeId, property, keyframes: track.keyframes.length, from: first.value, to: last.value },
        )
      }

      const start = a.start ?? 0
      const duration = a.duration
      if (duration === undefined) {
        throw new CapabilityError('`to` needs a `duration` (and usually a `start`)')
      }
      const to = a.to!
      const current = resolveNode(node, start).props[property]
      if (current === undefined) {
        throw new CapabilityError(
          `property ${property} does not exist on ${node.type} node ${nodeId}`,
        )
      }
      const existing = node.tracks.find((t) => t.property === property)
      const keep = existing ? existing.keyframes.filter((k) => k.t < start) : []
      const track: Track = {
        property,
        keyframes: [
          ...keep,
          { t: start, value: current, easing: 'linear' },
          { t: start + duration, value: to, easing: easing as Easing },
        ],
      }
      await ctx.submit(projectId, [op.setTrack(sceneId, nodeId, track)])
      return said(
        `animating ${nodeId}.${property} ${JSON.stringify(current)} → ${JSON.stringify(to)} ` +
          `over [${start}s, ${start + duration}s]`,
        { nodeId, property, from: current, to, start, duration },
      )
    },
  }),

  capability({
    name: 'morph_latex',
    summary: 'Morph a latex node into a new equation (matched-glyph, the 3b1b move).',
    doc: [
      'Shared glyphs move and only genuinely new or removed ones fade, so an unchanged term stays visibly still.',
      '',
      '**Prefer several small morphs to one structural leap.** Additive changes (appending a term) read cleanly because the existing glyphs hold position. A change that re-lays-out the equation — collapsing something into a fraction — is briefly illegible mid-morph.',
      '',
      'Sequential morphs on one node chain in start-time order. A call whose window **overlaps** an existing morph replaces it, so re-calling revises rather than stacks — two overlapping morphs would be ambiguous anyway, since the later one\'s source would be a half-finished equation.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      nodeId: NODE_ID,
      toTex: z.string().min(1),
      start: SECONDS,
      duration: z.number().positive().default(1),
      easing: EASING,
    }),
    async handler(ctx, { projectId, sceneId, nodeId, toTex, start, duration, easing }) {
      const { doc } = await ctx.getDoc(projectId)
      const node = ctx.nodeOrThrow(doc, sceneId, nodeId)
      if (node.type !== 'latex') {
        throw new CapabilityError(
          `${nodeId} is a ${node.type}, not latex — only latex nodes can morph`,
        )
      }
      const replaced = node.transitions.filter(
        (t) => t.type === 'texMorph' && !outside(t, start, duration),
      ).length
      const transitions: Transition[] = [
        ...node.transitions.filter((t) => t.type !== 'texMorph' || outside(t, start, duration)),
        { type: 'texMorph', start, duration, toTex, easing: easing as Easing },
      ]
      await ctx.submit(projectId, [op.updateNode(sceneId, nodeId, { transitions })])
      return said(
        `morphing ${nodeId} → "${toTex}" over [${start}s, ${start + duration}s]` +
          (replaced ? ` (replaced ${replaced} overlapping morph${replaced > 1 ? 's' : ''})` : ''),
        { nodeId, toTex, start, duration, replaced },
      )
    },
  }),

  capability({
    name: 'write_on',
    summary: 'Draw-on reveal, like writing by hand. Node is invisible before `start`.',
    doc: [
      'How the reveal is drawn depends on the node, because one motion does not suit all three:',
      '',
      '- **latex** — symbol by symbol in reading order, so glyphs are never sliced mid-stroke.',
      '- **path** — along the curve by **arc length**, like drawing it by hand. Note this is *not* uniform in x: on a sine curve the steep sections have more arc per unit x, so a path reveal paced against a linearly-advancing quantity drifts slightly. Match them by eye, or animate the other thing to the same easing.',
      '- **everything else** — a mask sweeping left to right across the node.',
      '',
      'Only one write transition exists per node; calling again replaces it.',
      '',
      ANCHOR_DOC,
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      nodeId: NODE_ID,
      start: SECONDS.optional(),
      duration: z.number().positive().default(1.5),
      atWord: AT_WORD,
      atWordOccurrence: AT_WORD_NTH,
      atWordOffset: AT_WORD_OFFSET,
    }),
    async handler(ctx, args) {
      const { projectId, sceneId, nodeId, duration } = args
      const { doc } = await ctx.getDoc(projectId)
      const scene = ctx.sceneOrThrow(doc, sceneId)
      const node = ctx.nodeOrThrow(doc, sceneId, nodeId)
      const a = anchorFor(
        scene,
        args.atWord,
        args.atWordOccurrence,
        args.atWordOffset,
        requireWhen(args.start, args.atWord),
      )
      const transitions: Transition[] = [
        ...node.transitions.filter((t) => t.type !== 'write'),
        { type: 'write', start: a.start, duration, ...(a.anchor ? { anchor: a.anchor } : {}) },
      ]
      await ctx.submit(projectId, [op.updateNode(sceneId, nodeId, { transitions })])
      return said(
        `write-on ${nodeId} over [${a.start}s, ${a.start + duration}s]${a.note}`,
        { nodeId, start: a.start, duration, anchored: !!a.anchor },
      )
    },
  }),

  capability({
    name: 'highlight',
    summary: 'Emphasise a node, one term inside an equation, or a range of matrix cells.',
    doc: [
      'Free. Name the part by what it *is*, never by where it landed on screen:',
      '',
      '- `tex` marks a sub-expression of a latex node — `tex: "\\\\frac{b}{a}"` marks just that term, located by its glyph codes.',
      '- `cells` marks part of a matrix or token strip — `{"rows":1}` a row, `{"cols":2}` a column, `{"rows":1,"cols":2}` one cell, `{"rows":[0,1]}` a band. Indices are 0-based, and one that does not exist is an error rather than a marker drawn somewhere plausible.',
      '- Neither marks the whole node.',
      '',
      'Styles: `color` recolours the target (default, usually cleanest); `spotlight` dims everything else and reads strongest on a busy equation or a large matrix; `box`/`underline` draw a marker around it. `color` and `spotlight` need a `tex` or `cells` target and fall back to a box otherwise.',
      '',
      'Use it when the narration dwells on something and nothing else is moving. Sequential highlights on one node accumulate; a call overlapping an existing window replaces it, because the engine renders one highlight at a time.',
      '',
      ANCHOR_DOC,
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      nodeId: NODE_ID,
      start: SECONDS.optional(),
      atWord: AT_WORD,
      atWordOccurrence: AT_WORD_NTH,
      atWordOffset: AT_WORD_OFFSET,
      duration: z.number().positive(),
      tex: z.string().optional().describe('sub-expression to mark; whole node if omitted'),
      cells: CELLS_ARG.optional(),
      style: z.enum(['box', 'underline', 'color', 'spotlight']).default('color'),
      color: COLOR.default('#e8c74a'),
    }),
    async handler(ctx, args) {
      const { projectId, sceneId, nodeId, duration, tex, cells, style, color } = args
      const { doc } = await ctx.getDoc(projectId)
      const node = ctx.nodeOrThrow(doc, sceneId, nodeId)
      const anchored = anchorFor(
        ctx.sceneOrThrow(doc, sceneId),
        args.atWord,
        args.atWordOccurrence,
        args.atWordOffset,
        requireWhen(args.start, args.atWord),
      )
      const start = anchored.start
      if (tex && node.type !== 'latex') {
        throw new CapabilityError(
          `tex targeting only works on latex nodes; ${nodeId} is a ${node.type}. ` +
            `Omit tex to highlight the whole node` +
            (node.type === 'matrix' || node.type === 'tokens' ? ', or use cells.' : '.'),
        )
      }
      if (tex && cells) {
        throw new CapabilityError('pass tex or cells, not both — they target different node types')
      }
      if (cells) checkRange(node, gridOrThrow(node, nodeId), cells, nodeId)
      const replaced = node.transitions.filter(
        (t) => t.type === 'highlight' && !outside(t, start, duration),
      ).length
      const transitions: Transition[] = [
        ...node.transitions.filter((t) => t.type !== 'highlight' || outside(t, start, duration)),
        {
          type: 'highlight',
          start,
          duration,
          tex,
          cells,
          style,
          color,
          ...(anchored.anchor ? { anchor: anchored.anchor } : {}),
        },
      ]
      await ctx.submit(projectId, [op.updateNode(sceneId, nodeId, { transitions })])
      const target = tex ? `"${tex}" in ` : cells ? `${describeRange(cells)} of ` : ''
      return said(
        `highlighting ${target}${nodeId} over ` +
          `[${start}s, ${start + duration}s] (${style})` +
          (replaced ? ` (replaced ${replaced} overlapping)` : ''),
        { nodeId, tex, cells, style, start, duration, replaced },
      )
    },
  }),
]
