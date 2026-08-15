import { ZodError } from 'zod'
import { CATALOG_REVISION, argsSchemaOf, capabilities, getCapability } from './catalog'
import { CapabilityError, type AgentCtx, type CapabilityResult } from './types'

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
    '  hold nodes (latex, text, shapes). Coordinates are canvas pixels, origin',
    '  top-left — a 1920x1080 canvas centres at (960, 540). Nodes anchor at their',
    '  centre. Every `start` and `duration` is in SCENE-LOCAL seconds.',
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
    '  You cannot see the video. get_project is the cheap read and reports pacing',
    '  (dead air is flagged `(long)`); get_scene gives exact keyframes. A tool',
    '  reporting success means the document changed — not that it looks right.',
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

  const parsed = cap.args.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    throw new CapabilityError(
      `invalid arguments for ${name}:\n${formatZodIssues(parsed.error)}\n` +
        `Call describe(["${name}"]) for the full argument contract ` +
        `(catalog revision ${CATALOG_REVISION} — if you are working from an ` +
        `earlier describe, it may have moved).`,
    )
  }

  const result = await cap.handler(ctx, parsed.data)
  return { ...result, name, revision: CATALOG_REVISION }
}

function formatZodIssues(error: ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.length ? i.path.join('.') : '(root)'
      return `  ${path}: ${i.message}`
    })
    .join('\n')
}
