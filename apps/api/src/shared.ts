import { applyOps, type Actor, type EuclidDoc, type Op } from '@euclid/dsl'
import type { Env } from './env'

export function projectStub(env: Env, projectId: string): DurableObjectStub {
  return env.PROJECT.get(env.PROJECT.idFromName(projectId))
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'captions'
}

/**
 * The project's document, straight from the DO. Callers must have already
 * checked ownership — this deliberately skips the auth forwarding.
 */
export async function docOf(env: Env, projectId: string): Promise<EuclidDoc | null> {
  const res = await projectStub(env, projectId).fetch('https://do/doc')
  if (!res.ok) return null
  return ((await res.json()) as { doc: EuclidDoc }).doc
}

export class AccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'AccessError'
  }
}

/**
 * **The tenancy rule.** Every gate in this worker is this one predicate, so
 * that a route cannot quietly decide something different — which is how the
 * asset upload route came to disagree with the asset read route.
 *
 * The row's owner is looked up in D1 and compared against the *claimed*
 * identity. The internal service key is not part of it: the key says "this
 * caller is one of our own workers", not "this caller may touch anything". A
 * worker acting on a user's behalf forwards that user's id (the MCP worker
 * does) and is held to exactly that user's rights; a worker acting on nobody's
 * behalf sends no `x-user-id` at all, the middleware names it `internal`, and
 * that is the single identity allowed past a mismatch.
 *
 * Note what this makes impossible: a leaked internal key can no longer be
 * pointed at an arbitrary project by claiming to be its owner — the claim is
 * checked against D1 either way.
 *
 * And note what it leaves possible, because the sentence above is narrower
 * than it reads: the holder of a leaked key can simply **send no `x-user-id`
 * at all**, be named `internal` by the middleware, and pass every gate here
 * for every project. Measured, not reasoned about — a keyed upload claiming
 * another user's id is refused 403, and the same upload with the header
 * removed succeeds. So this closes *impersonation*, not key leakage; the key
 * remains a full-access credential and belongs in the same class of secret as
 * a database password. Removing that last bypass means giving the workers
 * which legitimately act on nobody's behalf — the render worker fetching
 * narration audio, the probe/shots/proxy queues — a way to be authorised per
 * job rather than per process, which is real work and not a comment.
 */
export function mayAccess(ownerId: string, userId: string): boolean {
  return ownerId === userId || userId === 'internal'
}

/**
 * Ownership gate shared by every server-side path that isn't a raw DO forward.
 * See {@link mayAccess} for the rule itself.
 */
export async function requireProjectAccess(
  env: Env,
  projectId: string,
  userId: string,
): Promise<void> {
  const row = await env.DB.prepare('SELECT user_id FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ user_id: string }>()
  if (!row) throw new AccessError(`project ${projectId} not found`, 404)
  if (!mayAccess(row.user_id, userId)) throw new AccessError('forbidden', 403)
}

/**
 * Submit ops to a project's DO, rebasing on conflict.
 *
 * This is the loop that used to live in the MCP worker and cost three
 * cross-worker round trips per write (fetch doc → post ops → fetch doc). Here
 * it sits next to the Durable Object, so the retry is a local stub call.
 *
 * Returns the document as it stands after the write, because almost every
 * caller wants to report on what it just changed.
 */
export async function submitOps(
  env: Env,
  projectId: string,
  ops: Op[],
  actor: Actor,
): Promise<{ version: number; doc: EuclidDoc }> {
  const stub = projectStub(env, projectId)
  let lastError = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    const docRes = await stub.fetch('https://do/doc')
    if (!docRes.ok) throw new Error(`doc unavailable: ${docRes.status}`)
    const { doc, version } = (await docRes.json()) as { doc: EuclidDoc; version: number }

    const res = await stub.fetch('https://do/ops', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: crypto.randomUUID(), baseVersion: version, actor, ops }),
    })
    if (res.ok) {
      const { version: next } = (await res.json()) as { version: number }
      // Cheaper than a second round trip for the same answer: the reducer is
      // pure and the DO just applied these very ops to this very document.
      return { version: next, doc: applyOps(doc, ops) }
    }
    lastError = await res.text()
    if (res.status !== 409) break
  }
  throw new Error(`ops rejected: ${lastError}`)
}
