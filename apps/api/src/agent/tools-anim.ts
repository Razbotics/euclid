import { z } from 'zod'
import { op, type Easing, type Track, type Transition } from '@euclid/dsl'
import { resolveNode } from '@euclid/engine'
import { COLOR, EASING, NODE_ID, NUMBERISH, PROJECT_ID, SCENE_ID, SECONDS } from './schemas'
import { capability, said, CapabilityError } from './types'

/** Transitions that do not overlap [start, start+duration). */
const outside = (t: Transition, start: number, duration: number): boolean =>
  t.start + t.duration <= start || start + duration <= t.start

export const animTools = [
  capability({
    name: 'animate',
    summary:
      'Keyframe one property from its current value to `to` over `duration` (rotation in radians).',
    doc: [
      'The generic motion primitive. The start value is **sampled from the document at `start`**, never assumed — so animations chain continuously and you never have to restate where something already is.',
      '',
      'Properties: `position` ({x,y}), `scale`/`rotation`/`opacity`/`width`/`height`/`radius`/`fontSize`/`strokeWidth` (number), `fill`/`stroke`/`color` (#rrggbb).',
      '',
      '**`rotation` is in RADIANS, not degrees** — a quarter turn is 1.5708, not 90. Degrees are the natural guess and the call will succeed with a wildly wrong value: 90 wraps more than fourteen full turns. Convert with `degrees × π / 180`. A node rotates about its own `position`, so a line pivots about its anchor rather than its midpoint.',
      '',
      'Existing keyframes for that property **after `start` are replaced**, so re-calling to revise a move works; keyframes before `start` are kept, which is what makes a chain of calls compose.',
      '',
      'Times are scene-local seconds. An animation running past the scene end simply never finishes on screen — check the scene duration in get_project.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      nodeId: NODE_ID,
      property: z.enum([
        'position', 'scale', 'rotation', 'opacity', 'fill', 'stroke', 'color',
        'width', 'height', 'radius', 'fontSize', 'strokeWidth',
      ]),
      // NUMBERISH first: a colour like "#ff0000" fails it and falls through to
      // COLOR, while "1.12" is accepted where a bare z.number() would not.
      to: z.union([NUMBERISH, z.object({ x: NUMBERISH, y: NUMBERISH }), COLOR]),
      start: SECONDS,
      duration: z.number().positive(),
      easing: EASING,
    }),
    async handler(ctx, { projectId, sceneId, nodeId, property, to, start, duration, easing }) {
      const { doc } = await ctx.getDoc(projectId)
      const node = ctx.nodeOrThrow(doc, sceneId, nodeId)
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
    doc: 'On a latex node the equation is revealed symbol by symbol in reading order; other node types use a sweeping mask. Only one write transition exists per node — calling again replaces it.',
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      nodeId: NODE_ID,
      start: SECONDS,
      duration: z.number().positive().default(1.5),
    }),
    async handler(ctx, { projectId, sceneId, nodeId, start, duration }) {
      const { doc } = await ctx.getDoc(projectId)
      const node = ctx.nodeOrThrow(doc, sceneId, nodeId)
      const transitions: Transition[] = [
        ...node.transitions.filter((t) => t.type !== 'write'),
        { type: 'write', start, duration },
      ]
      await ctx.submit(projectId, [op.updateNode(sceneId, nodeId, { transitions })])
      return said(`write-on ${nodeId} over [${start}s, ${start + duration}s]`, {
        nodeId, start, duration,
      })
    },
  }),

  capability({
    name: 'highlight',
    summary: 'Emphasise a node, or one term inside an equation named by its LaTeX.',
    doc: [
      'Free. Give `tex` to mark a sub-expression — `tex: "\\\\frac{b}{a}"` marks just that term, located by its glyph codes, so you never need screen coordinates.',
      '',
      'Styles: `color` recolours the term (default, usually cleanest); `spotlight` dims everything else and reads strongest on a busy equation; `box`/`underline` draw a marker around it. `color` and `spotlight` need `tex` on a latex node and fall back to a box otherwise.',
      '',
      'Use it when the narration dwells on something and nothing else is moving. Sequential highlights on one node accumulate; a call overlapping an existing window replaces it, because the engine renders one highlight at a time.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      nodeId: NODE_ID,
      start: SECONDS,
      duration: z.number().positive(),
      tex: z.string().optional().describe('sub-expression to mark; whole node if omitted'),
      style: z.enum(['box', 'underline', 'color', 'spotlight']).default('color'),
      color: COLOR.default('#e8c74a'),
    }),
    async handler(ctx, { projectId, sceneId, nodeId, start, duration, tex, style, color }) {
      const { doc } = await ctx.getDoc(projectId)
      const node = ctx.nodeOrThrow(doc, sceneId, nodeId)
      if (tex && node.type !== 'latex') {
        throw new CapabilityError(
          `tex targeting only works on latex nodes; ${nodeId} is a ${node.type}. ` +
            `Omit tex to highlight the whole node.`,
        )
      }
      const replaced = node.transitions.filter(
        (t) => t.type === 'highlight' && !outside(t, start, duration),
      ).length
      const transitions: Transition[] = [
        ...node.transitions.filter((t) => t.type !== 'highlight' || outside(t, start, duration)),
        { type: 'highlight', start, duration, tex, style, color },
      ]
      await ctx.submit(projectId, [op.updateNode(sceneId, nodeId, { transitions })])
      return said(
        `highlighting ${tex ? `"${tex}" in ` : ''}${nodeId} over ` +
          `[${start}s, ${start + duration}s] (${style})` +
          (replaced ? ` (replaced ${replaced} overlapping)` : ''),
        { nodeId, tex, style, start, duration, replaced },
      )
    },
  }),
]
