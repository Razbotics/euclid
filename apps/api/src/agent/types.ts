import type { z } from 'zod'
import type { EuclidDoc, EuclidNode, Op } from '@euclid/dsl'
import type { Env } from '../env'

/**
 * What a capability handler is handed. Everything a tool used to do by calling
 * back across the service binding — fetch the doc, submit ops, rebase on 409 —
 * is a local method here, because the catalog runs inside the API worker next
 * to the Durable Object.
 */
export interface AgentCtx {
  env: Env
  userId: string
  /** Origin for client-facing URLs (never derived from the request — see publicOrigin). */
  origin: string
  /**
   * Ownership-checked document read. Deliberately returns no version: writes
   * go through `submit`, which fetches its own version immediately before
   * applying. A version handed out here would be stale by the time a handler
   * used it, and stale-but-plausible is worse than absent.
   */
  getDoc(projectId: string): Promise<{ doc: EuclidDoc }>
  /** Ownership check on its own, for handlers that don't need the document. */
  requireProject(projectId: string): Promise<void>
  /** Submit ops as the `agent` actor: fetch version → apply → retry ×3 on 409. */
  submit(projectId: string, ops: Op[]): Promise<{ version: number; doc: EuclidDoc }>
  /** Scene lookup that fails with a message naming what does exist. */
  sceneOrThrow(doc: EuclidDoc, sceneId: string): EuclidDoc['scenes'][number]
  /** Node lookup, searching into groups. */
  nodeOrThrow(doc: EuclidDoc, sceneId: string, nodeId: string): EuclidNode
}

/**
 * One handler, two consumers. `data` is the structured result the editor (and
 * any future UI) binds to; `text` is the compact line the agent reads. Keeping
 * both on every capability is what stops the editor and the agent surface from
 * drifting into two implementations of the same verb.
 */
export interface CapabilityResult {
  data: unknown
  text: string
  /**
   * An image the caller should *look at*, base64-encoded.
   *
   * Deliberately alongside `text` rather than instead of it: an image with no
   * caption cannot say which tile is which, and a caller that cannot render
   * images still gets the useful half. Only `preview_frames` sets this today.
   */
  image?: { base64: string; mimeType: string }
}

export interface Capability<A = any> {
  name: string
  /** One line, shown in the `instructions` table. Most calls need no more than this. */
  summary: string
  /**
   * The behavioural contract, returned by `describe`. This is where the prose
   * that used to live in an MCP tool description goes — the warnings about
   * track shadowing, morph chaining and overlap-replace exist because real runs
   * failed without them, and `describe` is now the only place an agent can
   * learn them.
   */
  doc: string
  args: z.ZodType<A>
  /**
   * Spends credits. Routed through a separate executor tool so a human's
   * standing "always allow" on the free executor can never cover a render.
   */
  costsCredits?: boolean
  handler: (ctx: AgentCtx, args: A) => Promise<CapabilityResult>
}

/**
 * A failure the agent can act on: the message is the whole remedy, so it names
 * the tool to call or the argument to change rather than reporting a status
 * code. Anything thrown that is *not* one of these is a bug, and the executor
 * reports it as such instead of dressing it up as guidance.
 */
export class CapabilityError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'CapabilityError'
  }
}

/** Identity helper that preserves the inferred arg type through the registry. */
export function capability<S extends z.ZodType>(entry: {
  name: string
  summary: string
  doc: string
  args: S
  costsCredits?: boolean
  handler: (ctx: AgentCtx, args: z.infer<S>) => Promise<CapabilityResult>
}): Capability<z.infer<S>> {
  return entry as Capability<z.infer<S>>
}

/** Most handlers return a one-liner and nothing structured beyond it. */
export function said(text: string, data: unknown = null): CapabilityResult {
  return { data, text }
}
