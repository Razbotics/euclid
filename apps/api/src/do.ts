import { DurableObject } from 'cloudflare:workers'
import {
  NewDecisionSchema,
  OpEnvelopeSchema,
  OpError,
  SubmitAnswerSchema,
  applyEnvelope,
  emptyDoc,
  type Decision,
  type EuclidDoc,
  type OpEnvelope,
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
      return json({ decision })
    }

    return json({ error: 'not_found' }, 404)
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
