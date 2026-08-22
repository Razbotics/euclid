import { planAllowedKinds, type PlanBudgetKind, type ProjectPlan } from '@euclid/dsl'
import { projectStub } from '../shared'
import type { Env } from '../env'

/**
 * The review-mode gate (plans/010).
 *
 * While a project's `review_mode` is on, paid generation must fit a
 * human-approved plan: the call's kind must be in the plan's roster and its
 * cost must fit the remaining budget. The check-and-spend itself runs in the
 * Durable Object, which serializes requests — so two generations racing for
 * the last credits resolve there, not here.
 *
 * This lives beside the debit (startGeneration, generateSceneNarration)
 * rather than in the capability layer, for the same reason those services
 * exist at all: budget, credits and refunds meet at one boundary with one
 * refund path. A generation that fails refunds its plan budget exactly where
 * it refunds its credits.
 */
export class PlanGateError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 403,
  ) {
    super(message)
    this.name = 'PlanGateError'
  }
}

export async function reviewModeOf(env: Env, projectId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT review_mode FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ review_mode: number }>()
  return !!row?.review_mode
}

export async function setReviewMode(env: Env, projectId: string, enabled: boolean): Promise<void> {
  await env.DB.prepare('UPDATE projects SET review_mode = ? WHERE id = ?')
    .bind(enabled ? 1 : 0, projectId)
    .run()
}

export async function listPlans(
  env: Env,
  projectId: string,
): Promise<{ plans: ProjectPlan[]; activeId?: string }> {
  const res = await projectStub(env, projectId).fetch('https://do/plans')
  if (!res.ok) return { plans: [] }
  return (await res.json()) as { plans: ProjectPlan[]; activeId?: string }
}

export async function proposePlan(
  env: Env,
  projectId: string,
  proposed: unknown,
): Promise<{ plan: ProjectPlan; decision: { id: string } }> {
  const res = await projectStub(env, projectId).fetch('https://do/plans', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(proposed),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string }
    throw new PlanGateError(
      body.error ?? 'plan_rejected',
      `the plan was rejected: ${body.detail ?? body.error ?? res.status}`,
      400,
    )
  }
  return (await res.json()) as { plan: ProjectPlan; decision: { id: string } }
}

/**
 * Charge `cost` against the approved plan's budget, if review mode gates this
 * project. Returns the plan drawn from (`null` when review mode is off), so
 * the caller can stamp its job and refund the right plan later. Throws a
 * PlanGateError whose message is the remedy when the gate refuses.
 */
export async function chargePlanBudget(
  env: Env,
  projectId: string,
  kind: PlanBudgetKind,
  cost: number,
): Promise<{ planId: string } | null> {
  if (!(await reviewModeOf(env, projectId))) return null
  const res = await projectStub(env, projectId).fetch('https://do/plans/spend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credits: cost, kind }),
  })
  if (res.ok) {
    const { plan } = (await res.json()) as { plan: ProjectPlan }
    return { planId: plan.id }
  }
  const body = (await res.json().catch(() => ({}))) as {
    error?: string
    kinds?: string[]
    remaining?: number
    estTotalCredits?: number
  }
  // Errors are the agent's only teacher: each refusal names the capability to
  // call next, not just the rule it broke.
  if (body.error === 'no_approved_plan') {
    throw new PlanGateError(
      'plan_required',
      'review mode is on: paid generation needs a human-approved plan first. ' +
        'Call propose_plan with the scenes and assets you intend, present it to the human, ' +
        'and STOP until they answer. (If the human has said to skip review, ' +
        'set_review_mode with enabled: false.)',
    )
  }
  if (body.error === 'kind_not_in_plan') {
    throw new PlanGateError(
      'kind_not_in_plan',
      `the approved plan does not budget ${kind} generation — it covers: ` +
        `${(body.kinds ?? []).join(', ') || 'nothing'}. Propose a revision with propose_plan ` +
        'that includes it, and wait for approval.',
    )
  }
  if (body.error === 'budget_exhausted') {
    throw new PlanGateError(
      'plan_budget_exhausted',
      `the approved plan has ${body.remaining ?? 0} of its ${body.estTotalCredits ?? 0} ` +
        `budgeted credits left and this ${kind} costs ${cost}. Propose a revision with ` +
        'propose_plan to extend the budget, and wait for approval.',
    )
  }
  throw new PlanGateError('plan_gate_failed', `plan budget check failed: ${body.error ?? res.status}`, 502)
}

/**
 * Return budget to the plan a failed generation drew from. Best-effort: the
 * user's *credits* are the refund that matters and are handled by the caller;
 * this is bookkeeping, and a plan that has since been superseded absorbs
 * nothing (its budget no longer meters anything).
 */
export async function refundPlanBudget(
  env: Env,
  projectId: string,
  planId: string,
  cost: number,
): Promise<void> {
  await projectStub(env, projectId)
    .fetch('https://do/plans/spend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId, credits: -cost }),
    })
    .catch(() => {})
}
