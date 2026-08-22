import { z } from 'zod'

/**
 * The plan the agent proposes before spending credits.
 *
 * Like decisions (see decisions.ts), a plan is workflow state, deliberately
 * **not** part of `EuclidDoc`: it never affects a frame, so it must not bump
 * SCHEMA_VERSION or reach the renderer. It lives in the project's Durable
 * Object under `plan:<id>`, broadcasts over the same WebSocket as ops and
 * decisions, and survives disconnects.
 *
 * Approval is a budget, not a snapshot. What the human authorizes at plan
 * time is *spending* — which assets get generated and roughly what it costs —
 * so that is what approval is scoped to: the asset roster and the credit
 * estimate. Each gated generation draws `spentCredits` down against
 * `estTotalCredits`; a call outside the roster or past the budget is refused
 * with "propose a revision" as the remedy. Approval never expires by time,
 * and document iteration (layout, animation, re-timing) never re-triggers it —
 * that work is free, and asset review still catches every output.
 */

export type PlanAssetKind = 'image' | 'video' | 'audio' | 'model'

/** What the budget gate meters: the four generative kinds plus narration TTS. */
export type PlanBudgetKind = PlanAssetKind | 'narration'

export interface PlanAssetItem {
  kind: PlanAssetKind
  /** What this asset is for, in the human's terms — shown in the approval. */
  description: string
  /** Roster model name. Resolved and priced server-side, never trusted. */
  model: string
  /**
   * Budgeted attempts, iterations included. The human is approving spend, and
   * one attempt is rarely enough — counting iterations here is the honest way
   * to say so up front rather than coming back for more after every miss.
   */
  count: number
  /** model credits × count. Computed server-side, never typed by the agent. */
  estCredits: number
}

export interface PlanScene {
  title: string
  /**
   * Narration draft. Doubles as the pricing input: the narration budget is
   * ttsCost over these drafts × narrationTakes, so a plan with takes but no
   * drafts cannot be priced and is refused.
   */
  narration?: string
  /** What happens on screen, one line. */
  beats?: string
}

export type PlanStatus = 'proposed' | 'approved' | 'changes_requested' | 'superseded'

export interface ProjectPlan {
  id: string
  /** 1-based; a revised plan is a new revision superseding the old, never an edit. */
  revision: number
  status: PlanStatus
  summary: string
  scenes: PlanScene[]
  assets: PlanAssetItem[]
  /** Narration syntheses budgeted (first take + revisions). 0 = no narration. */
  narrationTakes: number
  narrationEstCredits: number
  /** The budget the human approves: asset items + narration. Server-computed. */
  estTotalCredits: number
  /** Drawn down by gated generations; refunded when a generation refunds. */
  spentCredits: number
  /** The decision whose answer approves or bounces this revision. */
  decisionId: string
  createdAt: number
}

const PlanSceneSchema: z.ZodType<PlanScene> = z.object({
  title: z.string().min(1).max(120),
  narration: z.string().max(2000).optional(),
  beats: z.string().max(400).optional(),
})

const PlanAssetItemSchema: z.ZodType<PlanAssetItem> = z.object({
  kind: z.enum(['image', 'video', 'audio', 'model']),
  description: z.string().min(1).max(300),
  model: z.string().min(1),
  count: z.number().int().min(1).max(20),
  estCredits: z.number().int().min(0),
})

/**
 * What the API layer sends the DO: the plan fully priced, minus what the DO
 * mints (id, revision, status, spentCredits, decisionId, createdAt).
 */
export const ProposedPlanSchema = z.object({
  summary: z.string().min(1).max(500),
  scenes: z.array(PlanSceneSchema).min(1).max(50),
  assets: z.array(PlanAssetItemSchema).max(30),
  narrationTakes: z.number().int().min(0).max(5),
  narrationEstCredits: z.number().int().min(0),
  estTotalCredits: z.number().int().min(0),
})
export type ProposedPlan = z.infer<typeof ProposedPlanSchema>

export const ProjectPlanSchema: z.ZodType<ProjectPlan> = z.object({
  id: z.string().min(1),
  revision: z.number().int().min(1),
  status: z.enum(['proposed', 'approved', 'changes_requested', 'superseded']),
  summary: z.string(),
  scenes: z.array(PlanSceneSchema),
  assets: z.array(PlanAssetItemSchema),
  narrationTakes: z.number().int().min(0),
  narrationEstCredits: z.number().int().min(0),
  estTotalCredits: z.number().int().min(0),
  spentCredits: z.number().int().min(0),
  decisionId: z.string().min(1),
  createdAt: z.number().int(),
})

/** The kinds an approved plan's budget may be spent on. */
export function planAllowedKinds(plan: ProjectPlan): PlanBudgetKind[] {
  const kinds = new Set<PlanBudgetKind>(plan.assets.map((a) => a.kind))
  if (plan.narrationTakes > 0) kinds.add('narration')
  return [...kinds]
}

export function planRemaining(plan: ProjectPlan): number {
  return Math.max(0, plan.estTotalCredits - plan.spentCredits)
}

/** Compact text for the agent and the chat block — MCP results stay cheap. */
export function formatPlan(plan: ProjectPlan): string {
  const lines = [
    `plan rev ${plan.revision} [${plan.status}] — ${plan.summary}`,
    `  budget ${plan.estTotalCredits} credits` +
      (plan.spentCredits > 0
        ? ` (spent ${plan.spentCredits}, ${planRemaining(plan)} left)`
        : ''),
    '  scenes:',
  ]
  plan.scenes.forEach((s, i) => {
    const draft = s.narration ? ` — "${truncate(s.narration, 70)}"` : ''
    const beats = s.beats ? ` [${truncate(s.beats, 60)}]` : ''
    lines.push(`    ${i + 1}. ${s.title}${draft}${beats}`)
  })
  if (plan.assets.length > 0 || plan.narrationTakes > 0) lines.push('  generate:')
  for (const a of plan.assets) {
    lines.push(
      `    - ${a.kind} ×${a.count} via ${a.model} — ${a.description} (${a.estCredits} credits)`,
    )
  }
  if (plan.narrationTakes > 0) {
    lines.push(
      `    - narration ×${plan.narrationTakes} takes over the scene drafts ` +
        `(${plan.narrationEstCredits} credits)`,
    )
  }
  return lines.join('\n')
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}
