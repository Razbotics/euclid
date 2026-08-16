import { z, type ZodError } from 'zod'
import { CATALOG_REVISION, argsSchemaOf, capabilities, getCapability } from './catalog'
import { CapabilityError, type AgentCtx, type Capability, type CapabilityResult } from './types'

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
    '  hold nodes — latex, text and shapes, plus structured ones worth knowing',
    '  about before you build anything by hand: matrix and tokens (grids and',
    '  strips addressable by row/column), arrows that anchor to other nodes, and',
    '  vector3/axes3d/points3 for space. Coordinates are canvas pixels, origin',
    '  top-left — a 1920x1080 canvas centres at (960, 540). Nodes anchor at their',
    '  centre. Every `start` and `duration` is in SCENE-LOCAL seconds.',
    '',
    '  A scene can also have a camera (set_camera / move_camera). Node coordinates',
    '  never change — the camera decides which part of the scene the frame shows,',
    '  so a diagram can be laid out larger than the canvas and read piece by piece.',
    '',
    '  Usual order: create_project → add_scene → add_* nodes → set_narration →',
    '  generate_narration (gives real timings) → fit_scene_to_narration →',
    '  animate/morph_latex/highlight against those timings → render_video.',
    '',
    'COST',
    '  Everything is free except the two capabilities marked below. Iterate as',
    '  much as you like: reading the document, editing it and checking captions',
    '  cost nothing. Only synthesis and rendering spend credits, and they are',
    '  reached through a separate `execute_paid` tool so they can never be',
    '  covered by a standing approval on `execute`.',
    '',
    `FREE CAPABILITIES (${free.length}) — via execute`,
    ...free.map(row),
    '',
    `PAID CAPABILITIES (${paid.length}) — via execute_paid, SPENDS CREDITS`,
    ...paid.map(row),
    '',
    'SEEING YOUR WORK',
    '  You CAN see it. preview_frames returns one labeled contact sheet of the',
    '  moments that matter — free, a second or two, and the same renderer the',
    '  export uses, so what you see is what the MP4 will contain. Use it while',
    '  building, not once at the end: a tool reporting success means the document',
    '  changed, never that it looks right, and layout errors are invisible in any',
    '  text you can read. get_project is still the cheap read and reports pacing',
    '  (dead air is flagged `(long)`); get_scene gives exact keyframes.',
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
