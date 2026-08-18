import { z, type ZodError } from 'zod'
import type { EuclidNode } from '@euclid/dsl'
import { CATALOG_REVISION, argsSchemaOf, capabilities, getCapability } from './catalog'
import { CapabilityError, type AgentCtx, type Capability, type CapabilityResult } from './types'

/**
 * What each node type is, in one phrase, for the orientation block.
 *
 * A `Record` keyed by `EuclidNode['type']` rather than a hand-written sentence,
 * because that sentence went stale twice. Milestone run 6 found the prose
 * saying "You cannot see the video" two lines above `preview_frames`; run 7
 * found it listing the spatial types with no mention of `mesh`, which had
 * shipped hours earlier — so an agent reading orientation could not know solids
 * existed. Nothing linked the prose to the thing it described.
 *
 * Now the compiler does: adding a member to the `EuclidNode` union fails the
 * build until it is described here. Types that read as one idea share a phrase
 * and are collapsed once, so rect/circle/line still say "shapes" rather than
 * turning the paragraph into an inventory.
 */
type NodeGroup = 'basic' | 'structured' | 'spatial'

const NODE_BLURBS: Record<EuclidNode['type'], { group: NodeGroup; phrase: string }> = {
  text: { group: 'basic', phrase: 'text' },
  latex: { group: 'basic', phrase: 'latex' },
  rect: { group: 'basic', phrase: 'shapes' },
  circle: { group: 'basic', phrase: 'shapes' },
  line: { group: 'basic', phrase: 'shapes' },
  path: { group: 'basic', phrase: 'paths and plotted curves' },
  image: { group: 'basic', phrase: 'image for a still from a project asset' },
  axes: { group: 'basic', phrase: 'axes a plot can borrow' },
  group: { group: 'basic', phrase: 'groups that move their children together' },
  matrix: {
    group: 'structured',
    phrase: 'matrix and tokens (grids and strips addressable by row/column)',
  },
  tokens: {
    group: 'structured',
    phrase: 'matrix and tokens (grids and strips addressable by row/column)',
  },
  arrow: { group: 'structured', phrase: 'arrows that anchor to other nodes and track them' },
  vector3: {
    group: 'spatial',
    phrase: 'vector3/axes3d/points3 for arrows, frames and clouds in space',
  },
  axes3d: {
    group: 'spatial',
    phrase: 'vector3/axes3d/points3 for arrows, frames and clouds in space',
  },
  points3: {
    group: 'spatial',
    phrase: 'vector3/axes3d/points3 for arrows, frames and clouds in space',
  },
  mesh: {
    group: 'spatial',
    phrase: 'mesh for shaded, self-occluding solids — sphere, cylinder, cone, torus, cube, plane',
  },
}

/** Distinct phrases for one group, in declaration order. */
function nodePhrases(group: NodeGroup): string {
  const seen = new Set<string>()
  for (const b of Object.values(NODE_BLURBS)) {
    if (b.group === group) seen.add(b.phrase)
  }
  return [...seen].join(', ')
}

/**
 * Name a capability inside prose.
 *
 * Throws at module load if it does not exist, so a renamed or removed tool
 * cannot go on being recommended by the block that teaches the surface. The
 * catalog already fails this way on duplicate names; this is the same idea
 * pointed at the prose.
 */
function ref(name: string): string {
  if (!getCapability(name)) {
    throw new Error(
      `instructions reference unknown capability "${name}" — rename it here too, ` +
        `or the orientation block teaches a tool that does not exist`,
    )
  }
  return name
}

/** Soft-wrap generated prose so the block stays readable as plain text. */
function wrap(text: string, indent = '  ', width = 78): string[] {
  const lines: string[] = []
  let line = indent
  for (const word of text.split(/\s+/)) {
    if (line.length > indent.length && line.length + 1 + word.length > width) {
      lines.push(line)
      line = indent + word
    } else {
      line = line.length > indent.length ? `${line} ${word}` : line + word
    }
  }
  if (line.trim()) lines.push(line)
  return lines
}

/** The orientation block. Read once per thread; it is the whole tool list. */
export function buildInstructions(): string {
  const free = capabilities.filter((c) => !c.costsCredits)
  const paid = capabilities.filter((c) => c.costsCredits)
  const row = (c: (typeof capabilities)[number]) => `  ${c.name.padEnd(24)} ${c.summary}`

  return [
    'EUCLID — programmatic video editing. Read this once per thread; it is the whole tool list.',
    '',
    'HOW THIS SURFACE WORKS',
    '  Three tools stand in for every capability below:',
    '    instructions  — this block. Call it at the start of a new thread.',
    '    describe      — full arguments and behaviour for named capabilities.',
    '    execute       — run one capability: {name, args}.',
    '  Most capabilities are callable straight from the one-line summary. Call',
    '  describe when the summary is not enough, or when execute rejects your args.',
    '',
    'ORIENTATION',
    '  A project holds scenes; scenes play in sequence on one timeline; scenes',
    ...wrap(`hold nodes — ${nodePhrases('basic')}.`),
    ...wrap(
      `Structured, and worth knowing about before you build anything by hand: ` +
        `${nodePhrases('structured')}.`,
    ),
    ...wrap(`For space, and inert until the camera turns: ${nodePhrases('spatial')}.`),
    '',
    '  Coordinates are canvas pixels, origin top-left — a 1920x1080 canvas centres',
    '  at (960, 540). Nodes anchor at their centre. Every `start` and `duration` is',
    '  in SCENE-LOCAL seconds.',
    '',
    `  A scene can also have a camera (${ref('set_camera')} / ${ref('move_camera')}). Node`,
    '  coordinates never change — the camera decides which part of the scene the',
    '  frame shows, so a diagram can be laid out larger than the canvas and read',
    '  piece by piece.',
    '',
    ...wrap(
      `Usual order: ${ref('create_project')} → ${ref('add_scene')} → add_* nodes → ` +
        `${ref('set_narration')} → ${ref('generate_narration')} (gives real timings) → ` +
        `${ref('fit_scene_to_narration')} → ${ref('animate')}/${ref('morph_latex')}/` +
        `${ref('highlight')} against those timings → ${ref('render_video')}.`,
    ),
    '',
    'COST',
    ...wrap(
      `Everything is free except the ${paid.length} capabilities marked below. Iterate as ` +
        `much as you like: reading the document, editing it and checking captions cost ` +
        `nothing. Only the paid few spend credits, and they are reached through a separate ` +
        `\`execute_paid\` tool so they can never be covered by a standing approval on ` +
        `\`execute\`.`,
    ),
    '',
    `FREE CAPABILITIES (${free.length}) — via execute`,
    ...free.map(row),
    '',
    `PAID CAPABILITIES (${paid.length}) — via execute_paid, SPENDS CREDITS`,
    ...paid.map(row),
    '',
    'SEEING YOUR WORK',
    ...wrap(
      `You CAN see it. ${ref('preview_frames')} returns one labeled contact sheet of the ` +
        `moments that matter — free, a second or two, and the same renderer the export ` +
        `uses, so what you see is what the MP4 will contain. Use it while building, not ` +
        `once at the end: a tool reporting success means the document changed, never that ` +
        `it looks right, and layout errors are invisible in any text you can read. ` +
        `${ref('get_project')} is still the cheap read and reports pacing (dead air is ` +
        `flagged \`(long)\`); ${ref('get_scene')} gives exact keyframes.`,
    ),
    '',
    `catalog revision ${CATALOG_REVISION}`,
  ].join('\n')
}

export interface DescribeResult {
  name: string
  summary: string
  doc: string
  costsCredits: boolean
  args: unknown
}

/**
 * Full contract for named capabilities. An unknown name is an error rather than
 * a silent omission — a typo must not look like a capability that does not
 * exist.
 */
export function describeCapabilities(names: string[]): DescribeResult[] {
  if (names.length === 0) throw new CapabilityError('pass at least one capability name')
  return names.map((name) => {
    const cap = getCapability(name)
    if (!cap) throw new CapabilityError(unknownCapability(name), 404)
    return {
      name: cap.name,
      summary: cap.summary,
      doc: cap.doc,
      costsCredits: !!cap.costsCredits,
      args: argsSchemaOf(cap),
    }
  })
}

/** Formats a describe result the way an agent reads best: prose, then args. */
export function formatDescribe(d: DescribeResult): string {
  return [
    `${d.name} — ${d.summary}`,
    d.costsCredits ? 'SPENDS CREDITS — call through execute_paid.' : 'Free.',
    '',
    d.doc,
    '',
    'ARGUMENTS',
    JSON.stringify(d.args, null, 2),
  ].join('\n')
}

function unknownCapability(name: string): string {
  const near = capabilities
    .map((c) => c.name)
    .filter((n) => n.includes(name) || name.includes(n) || sharePrefix(n, name))
    .slice(0, 5)
  return (
    `no capability named "${name}". ` +
    (near.length ? `Did you mean: ${near.join(', ')}? ` : '') +
    `Call instructions for the full list.`
  )
}

function sharePrefix(a: string, b: string): boolean {
  return a.slice(0, 4) === b.slice(0, 4)
}

export interface ExecuteOutcome extends CapabilityResult {
  name: string
  revision: string
}

/**
 * Validate and run one capability.
 *
 * Validation moved server-side with the catalog, which makes the error text the
 * agent's only teacher — so a Zod failure is rewritten into the field-by-field
 * form, and it names `describe` as the way to get the full contract rather than
 * leaving the caller to guess.
 */
export async function executeCapability(
  ctx: AgentCtx,
  name: string,
  rawArgs: unknown,
  opts: { allowPaid: boolean },
): Promise<ExecuteOutcome> {
  const cap = getCapability(name)
  if (!cap) throw new CapabilityError(unknownCapability(name), 404)

  if (cap.costsCredits && !opts.allowPaid) {
    throw new CapabilityError(
      `${name} spends credits, so it must be called through execute_paid, not execute. ` +
        `This split exists so approving the free executor can never approve a charge.`,
      403,
    )
  }
  if (!cap.costsCredits && opts.allowPaid) {
    throw new CapabilityError(
      `${name} is free — call it through execute. execute_paid is only for ` +
        `capabilities that spend credits.`,
    )
  }

  const parsed = strictArgs(cap).safeParse(rawArgs ?? {})
  if (!parsed.success) {
    throw new CapabilityError(
      `invalid arguments for ${name}:\n${formatZodIssues(parsed.error, cap)}\n` +
        `Call describe(["${name}"]) for the full argument contract ` +
        `(catalog revision ${CATALOG_REVISION} — if you are working from an ` +
        `earlier describe, it may have moved).`,
    )
  }

  const result = await cap.handler(ctx, parsed.data)
  return { ...result, name, revision: CATALOG_REVISION }
}

/** Built once per capability; `.strict()` rebuilds the schema each call. */
const STRICT = new WeakMap<Capability, z.ZodType>()

/**
 * Reject arguments the capability does not have, rather than dropping them.
 *
 * Zod strips unknown keys by default, which turns a typo into a *success* —
 * `highlight(colour:)` cheerfully returned "highlighting … (color)" while using
 * the default, and `fit_scene_to_narration(tail:)` reported the 0.8s default
 * back as though it were the value asked for. That is the same class of defect
 * as the `update_node` trap: a call that reports doing one thing and does
 * another, which no amount of reading the response can catch.
 *
 * Enforced here rather than on each schema because the catalog is the single
 * chokepoint — this covers every capability, present and future, and no entry
 * can forget it.
 */
function strictArgs(cap: Capability): z.ZodType {
  const cached = STRICT.get(cap)
  if (cached) return cached
  const strict = cap.args instanceof z.ZodObject ? cap.args.strict() : cap.args
  STRICT.set(cap, strict)
  return strict
}

/** Valid argument names, for an error that can say what *was* expected. */
function argNames(cap: Capability): string[] {
  return cap.args instanceof z.ZodObject ? Object.keys(cap.args.shape) : []
}

function formatZodIssues(error: ZodError, cap: Capability): string {
  return error.issues
    .map((i) => {
      // An unrecognised key has an empty path, so the generic form would render
      // it as "(root): Unrecognized key" — true, and useless. Name the accepted
      // arguments instead: the mistake is nearly always a near-miss.
      if (i.code === 'unrecognized_keys') {
        const bad = (i as unknown as { keys: string[] }).keys
        return (
          `  unknown argument${bad.length > 1 ? 's' : ''} ${bad.map((k) => `\`${k}\``).join(', ')} — ` +
          `not dropped, because a silently ignored argument reports success while ` +
          `doing something else. Accepts: ${argNames(cap).join(', ')}.`
        )
      }
      const path = i.path.length ? i.path.join('.') : '(root)'
      return `  ${path}: ${i.message}`
    })
    .join('\n')
}
