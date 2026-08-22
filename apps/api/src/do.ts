import { DurableObject } from 'cloudflare:workers'
import {
  NewDecisionSchema,
  OpEnvelopeSchema,
  OpError,
  ProposedPlanSchema,
  SubmitAnswerSchema,
  applyEnvelope,
  emptyDoc,
  planAllowedKinds,
  planRemaining,
  type Decision,
  type EuclidDoc,
  type OpEnvelope,
  type PlanBudgetKind,
  type ProjectPlan,
} from '@euclid/dsl'
import type { Env } from './env'

/**
 * One ProjectDO per project — the single writer for that project's document.
 * All mutations arrive as OpEnvelopes (from the editor UI, the MCP worker, or
 * system jobs), are validated + applied via the shared @euclid/dsl reducer,
 * appended to an event log, and broadcast to every connected WebSocket.
 *
 * Envelopes carry baseVersion; a mismatch returns 409 and the writer rebases.
 * This is what lets the whole backend stay stateless outside this object.
 */
export class ProjectDO extends DurableObject<Env> {
  private doc: EuclidDoc | null = null
  private version = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.doc = (await ctx.storage.get<EuclidDoc>('doc')) ?? null
      this.version = (await ctx.storage.get<number>('version')) ?? 0
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return json({ error: 'expected websocket upgrade' }, 426)
      }
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1])
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    if (url.pathname === '/init' && request.method === 'POST') {
      const body = (await request.json()) as {
        id: string
        name: string
        canvas?: { width: number; height: number; fps: 30 | 60 }
      }
      if (!this.doc) {
        this.doc = emptyDoc(body.id, body.name, body.canvas)
        await this.ctx.storage.put({ doc: this.doc, version: this.version })
      }
      return json({ version: this.version })
    }

    if (url.pathname === '/doc') {
      if (!this.doc) return json({ error: 'not_initialized' }, 404)
      return json({ doc: this.doc, version: this.version })
    }

    /**
     * Tear this project down. Called only by the API's delete path, after it
     * has checked ownership.
     *
     * The in-memory copies are cleared too: a Durable Object is not evicted
     * just because its storage was emptied, so an instance that kept `doc`
     * would happily keep serving and mutating a document that no longer
     * exists anywhere else. Subscribers are closed rather than left hanging on
     * a project that is gone — 1001 "going away" is what tells an open editor
     * to stop, instead of it retrying against a dead id.
     */
    if (url.pathname === '/destroy' && request.method === 'POST') {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1001, 'project deleted')
        } catch {
          // already closing; hibernation API cleans it up
        }
      }
      await this.ctx.storage.deleteAll()
      this.doc = null
      this.version = 0
      return json({ destroyed: true })
    }

    if (url.pathname === '/ops' && request.method === 'POST') {
      const parsed = OpEnvelopeSchema.safeParse(await request.json())
      if (!parsed.success) return json({ error: 'invalid_envelope', detail: parsed.error.message }, 400)
      return this.submit(parsed.data)
    }

    if (url.pathname === '/events') {
      const since = Number(url.searchParams.get('since') ?? 0)
      const events = await this.ctx.storage.list({
        prefix: 'evt:',
        start: eventKey(since + 1),
      })
      return json({ version: this.version, events: [...events.values()] })
    }

    // ---------- decisions ----------
    // Kept out of the document on purpose (see packages/dsl/src/decisions.ts):
    // workflow state, not video content. They ride the same WebSocket so the
    // editor sees a question appear the moment the agent asks it.
    if (url.pathname === '/decisions' && request.method === 'GET') {
      const all = await this.listDecisions()
      const open = url.searchParams.get('status') === 'open'
      return json({ decisions: open ? all.filter((d) => d.status === 'open') : all })
    }

    if (url.pathname === '/decisions' && request.method === 'POST') {
      const parsed = NewDecisionSchema.safeParse(await request.json())
      if (!parsed.success) {
        return json({ error: 'invalid_decision', detail: parsed.error.message }, 400)
      }
      const ids = new Set(parsed.data.options.map((o) => o.id))
      if (ids.size !== parsed.data.options.length) {
        return json({ error: 'duplicate_option_id' }, 400)
      }
      const decision: Decision = {
        ...parsed.data,
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        status: 'open',
      }
      await this.ctx.storage.put(decisionKey(decision.id), decision)
      this.broadcast({ type: 'decision', decision })
      return json({ decision })
    }

    if (url.pathname.startsWith('/decisions/') && request.method === 'POST') {
      const id = url.pathname.slice('/decisions/'.length)
      const existing = await this.ctx.storage.get<Decision>(decisionKey(id))
      if (!existing) return json({ error: 'decision_not_found' }, 404)
      // First answer wins: two surfaces can answer (editor and agent), and a
      // silently overwritten answer would be worse than a clear rejection.
      if (existing.status === 'answered') {
        return json({ error: 'already_answered', decision: existing }, 409)
      }
      const parsed = SubmitAnswerSchema.safeParse(await request.json())
      if (!parsed.success) {
        return json({ error: 'invalid_answer', detail: parsed.error.message }, 400)
      }
      if (parsed.data.optionId && !existing.options.some((o) => o.id === parsed.data.optionId)) {
        return json({ error: 'unknown_option', optionId: parsed.data.optionId }, 400)
      }
      const decision: Decision = {
        ...existing,
        status: 'answered',
        answer: { ...parsed.data, at: Date.now() },
      }
      await this.ctx.storage.put(decisionKey(id), decision)
      this.broadcast({ type: 'decision', decision })
      // A plan-approval decision carries the plan it decides: answering it is
      // what flips the plan's status, so approval has exactly one path whether
      // the human clicked in the editor or told the agent (plans/010).
      const plan = decision.refs?.planId
        ? await this.applyPlanAnswer(decision.refs.planId, decision)
        : undefined
      // An asset-review decision carries the assets it judges — same shape,
      // same single path: answering writes their review status.
      if (decision.refs?.assetIds?.length) await this.applyAssetReviewAnswer(decision)
      return json({ decision, ...(plan ? { plan } : {}) })
    }

    /**
     * Who last set a scene's narration text, skipping the `system` write-back
     * that TTS itself submits (it restates the same text). This is what lets
     * a human-typed script auto-approve its own audio (plans/010): the event
     * log already records every writer, so authorship is a reverse scan, not
     * a new piece of state.
     */
    if (url.pathname === '/narration-author') {
      const sceneId = url.searchParams.get('sceneId')
      if (!sceneId) return json({ error: 'missing_sceneId' }, 400)
      // Bounded: list() materialises everything it matches, and an old project
      // carries hundreds of envelopes. 200 covers any plausible gap between a
      // script edit and its synthesis; older than that, "unknown" is the
      // honest answer (and the conservative one — unknown text gets reviewed).
      const events = await this.ctx.storage.list<{
        envelope: { actor?: { type?: string }; ops?: { kind?: string; sceneId?: string }[] }
      }>({ prefix: 'evt:', reverse: true, limit: 200 })
      for (const evt of events.values()) {
        const actor = evt.envelope?.actor?.type
        if (actor === 'system') continue
        if (evt.envelope?.ops?.some((o) => o.kind === 'narration.set' && o.sceneId === sceneId)) {
          return json({ author: actor ?? null })
        }
      }
      return json({ author: null })
    }

    // ---------- plans ----------
    // Workflow state like decisions: the agent's proposed plan, whose approval
    // is a spending budget the generation gate draws down (plans/010).
    if (url.pathname === '/plans' && request.method === 'GET') {
      const plans = await this.listPlans()
      const active = plans.find((p) => p.status === 'approved')
      return json({ plans, ...(active ? { activeId: active.id } : {}) })
    }

    if (url.pathname === '/plans' && request.method === 'POST') {
      const parsed = ProposedPlanSchema.safeParse(await request.json())
      if (!parsed.success) {
        return json({ error: 'invalid_plan', detail: parsed.error.message }, 400)
      }
      const plans = await this.listPlans()
      // A new proposal supersedes anything still awaiting an answer — two open
      // plan approvals would be two budgets racing for one yes.
      for (const p of plans) {
        if (p.status === 'proposed' || p.status === 'changes_requested') {
          const superseded: ProjectPlan = { ...p, status: 'superseded' }
          await this.ctx.storage.put(planKey(p.id), superseded)
          this.broadcast({ type: 'plan', plan: superseded })
        }
      }
      const planId = crypto.randomUUID()
      const decision: Decision = {
        id: crypto.randomUUID(),
        question:
          `Approve plan rev ${plans.length + 1}? ` +
          `(${parsed.data.estTotalCredits} credits of generation)`,
        detail: parsed.data.summary,
        options: [
          {
            id: 'approve',
            label: 'Approve the plan',
            detail: 'unlocks generation up to the budget',
          },
          {
            id: 'request_changes',
            label: 'Request changes',
            detail: 'add a note saying what to change',
          },
        ],
        refs: { planId },
        createdAt: Date.now(),
        status: 'open',
      }
      const plan: ProjectPlan = {
        ...parsed.data,
        id: planId,
        revision: plans.length + 1,
        status: 'proposed',
        spentCredits: 0,
        decisionId: decision.id,
        createdAt: Date.now(),
      }
      await this.ctx.storage.put({
        [planKey(plan.id)]: plan,
        [decisionKey(decision.id)]: decision,
      })
      this.broadcast({ type: 'plan', plan })
      this.broadcast({ type: 'decision', decision })
      return json({ plan, decision })
    }

    /**
     * Draw down (credits > 0) or refund (credits < 0) the approved plan's
     * budget. Lives here because the DO serializes requests: check-and-spend
     * is atomic without a lock, exactly like op versioning. Reachable only via
     * the service stub — the API never forwards it.
     */
    if (url.pathname === '/plans/spend' && request.method === 'POST') {
      const body = (await request.json()) as {
        planId?: string
        credits: number
        kind?: PlanBudgetKind
      }
      if (typeof body.credits !== 'number' || !Number.isFinite(body.credits)) {
        return json({ error: 'invalid_spend' }, 400)
      }
      if (body.credits < 0) {
        // Refund. To the named plan, whatever its status now is: a generation
        // that failed gives its budget back even if the plan moved on — unless
        // the plan is superseded, where the new budget never counted it.
        if (!body.planId) return json({ error: 'refund_needs_plan_id' }, 400)
        const plan = await this.ctx.storage.get<ProjectPlan>(planKey(body.planId))
        if (!plan) return json({ error: 'plan_not_found' }, 404)
        if (plan.status === 'superseded') return json({ plan, skipped: true })
        const updated: ProjectPlan = {
          ...plan,
          spentCredits: Math.max(0, plan.spentCredits + body.credits),
        }
        await this.ctx.storage.put(planKey(plan.id), updated)
        this.broadcast({ type: 'plan', plan: updated })
        return json({ plan: updated })
      }
      const plans = await this.listPlans()
      const plan = plans.find((p) => p.status === 'approved')
      if (!plan) return json({ error: 'no_approved_plan' }, 409)
      const kinds = planAllowedKinds(plan)
      if (body.kind && !kinds.includes(body.kind)) {
        return json({ error: 'kind_not_in_plan', kind: body.kind, kinds }, 409)
      }
      const remaining = planRemaining(plan)
      if (body.credits > remaining) {
        return json(
          {
            error: 'budget_exhausted',
            remaining,
            cost: body.credits,
            estTotalCredits: plan.estTotalCredits,
          },
          409,
        )
      }
      const updated: ProjectPlan = { ...plan, spentCredits: plan.spentCredits + body.credits }
      await this.ctx.storage.put(planKey(plan.id), updated)
      this.broadcast({ type: 'plan', plan: updated })
      return json({ plan: updated })
    }

    return json({ error: 'not_found' }, 404)
  }

  private async listPlans(): Promise<ProjectPlan[]> {
    const rows = await this.ctx.storage.list<ProjectPlan>({ prefix: 'plan:' })
    return [...rows.values()].sort((a, b) => a.revision - b.revision)
  }

  /**
   * The consequence of answering a plan decision. `approve` approves the plan
   * and supersedes any previously approved one (one active budget at a time);
   * anything else — request_changes, or a bare note — is feedback, which is
   * `changes_requested`. A plan no longer `proposed` is left alone: its
   * decision was answered after a newer proposal superseded it.
   */
  private async applyPlanAnswer(
    planId: string,
    decision: Decision,
  ): Promise<ProjectPlan | undefined> {
    const plan = await this.ctx.storage.get<ProjectPlan>(planKey(planId))
    if (!plan || plan.status !== 'proposed') return plan
    const approved = decision.answer?.optionId === 'approve'
    if (approved) {
      for (const p of await this.listPlans()) {
        if (p.status === 'approved') {
          const superseded: ProjectPlan = { ...p, status: 'superseded' }
          await this.ctx.storage.put(planKey(p.id), superseded)
          this.broadcast({ type: 'plan', plan: superseded })
        }
      }
    }
    const updated: ProjectPlan = {
      ...plan,
      status: approved ? 'approved' : 'changes_requested',
    }
    await this.ctx.storage.put(planKey(plan.id), updated)
    this.broadcast({ type: 'plan', plan: updated })
    return updated
  }

  /**
   * The consequence of answering an asset-review decision: `approve` approves
   * every asset it carries, anything else — request_changes, or a bare note —
   * rejects them with the note as the iteration signal. The D1 write happens
   * here rather than in the API layer because two paths answer decisions
   * (editor forward, record_answer capability) and both land here; one
   * consequence, one place. `request_review` validated the assets were
   * pending when the decision was minted; if two decisions ever cover one
   * asset, the later answer wins, which is visible in reviewed_at.
   */
  private async applyAssetReviewAnswer(decision: Decision): Promise<void> {
    const assetIds = decision.refs?.assetIds ?? []
    if (assetIds.length === 0) return
    const approved = decision.answer?.optionId === 'approve'
    const status = approved ? 'approved' : 'rejected'
    const note = decision.answer?.note ?? null
    const via = decision.answer?.via ?? 'editor'
    const marks = assetIds.map(() => '?').join(', ')
    await this.env.DB.prepare(
      `UPDATE assets SET review_status = ?, review_note = ?, reviewed_at = ?, reviewed_via = ?
       WHERE id IN (${marks})`,
    )
      .bind(status, note, Date.now(), via, ...assetIds)
      .run()
    this.broadcast({ type: 'asset-reviewed', assetIds, status, note })
  }

  private async listDecisions(): Promise<Decision[]> {
    const rows = await this.ctx.storage.list<Decision>({ prefix: 'dec:' })
    return [...rows.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  private async submit(envelope: OpEnvelope): Promise<Response> {
    if (!this.doc) return json({ error: 'not_initialized' }, 404)
    if (envelope.baseVersion !== this.version) {
      return json({ error: 'version_conflict', version: this.version }, 409)
    }
    let next: EuclidDoc
    try {
      next = applyEnvelope(this.doc, envelope)
    } catch (e) {
      if (e instanceof OpError) return json({ error: e.code, detail: e.message }, 422)
      throw e
    }
    this.doc = next
    this.version += 1
    await this.ctx.storage.put({
      doc: next,
      version: this.version,
      [eventKey(this.version)]: { version: this.version, envelope, at: Date.now() },
    })
    this.broadcast({ type: 'ops', version: this.version, envelope })
    return json({ version: this.version })
  }

  private broadcast(msg: unknown): void {
    const text = JSON.stringify(msg)
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text)
      } catch {
        // socket already closing; hibernation API cleans it up
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    let msg: { type?: string; reqId?: string; envelope?: unknown }
    try {
      msg = JSON.parse(message)
    } catch {
      return
    }
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }))
      return
    }
    if (msg.type === 'ops') {
      const parsed = OpEnvelopeSchema.safeParse(msg.envelope)
      if (!parsed.success) {
        ws.send(JSON.stringify({ type: 'nack', reqId: msg.reqId, error: 'invalid_envelope' }))
        return
      }
      const res = await this.submit(parsed.data)
      const body = (await res.json()) as Record<string, unknown>
      ws.send(
        JSON.stringify(
          res.ok
            ? { type: 'ack', reqId: msg.reqId, version: body.version }
            : { type: 'nack', reqId: msg.reqId, ...body },
        ),
      )
    }
  }
}

function decisionKey(id: string): string {
  return `dec:${id}`
}

function planKey(id: string): string {
  return `plan:${id}`
}

function eventKey(version: number): string {
  // zero-padded so storage.list() range scans stay in numeric order
  return `evt:${String(version).padStart(10, '0')}`
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
