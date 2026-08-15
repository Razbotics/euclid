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
 * Ownership gate shared by every server-side path that isn't a raw DO forward.
 * Tenancy is enforced by looking the project up in D1, never by trusting the
 * caller — `internal` is the render/MCP worker acting on a user's behalf and is
 * the only identity allowed past a mismatch.
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
  if (row.user_id !== userId && userId !== 'internal') {
    throw new AccessError('forbidden', 403)
  }
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
