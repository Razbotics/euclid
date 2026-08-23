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
  /**
   * Does a capability exist, and does it spend credits — without running it.
   *
   * For a caller that must check a whole list *before* it starts: discovering
   * a paid or misspelled name halfway through a batch would mean refusing
   * after already changing the document.
   */
  capabilityInfo(name: string): { exists: boolean; costsCredits: boolean }
  /**
   * Run another capability by name, as `execute` would.
   *
   * Here rather than imported directly because the executor reads the catalog
   * and the catalog is built from the tool files — a handler importing it back
   * would close the loop at module load, where `ref()` and the duplicate-name
   * check already run. `AgentCtx` is where everything a handler cannot do for
   * itself already lives, so this is the seam that was waiting for it.
   *
   * **Free capabilities only**, and not negotiable from the caller's side:
   * there is no `allowPaid` to pass. The paid door is a separate MCP tool so a
   * standing approval on the free one can never cover a charge, and a batch
   * that could reach `render_video` would be a way around exactly that.
   */
  runCapability(name: string, args: unknown): Promise<CapabilityResult & { name: string }>
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
   * The shape of `data`, for a caller that reads it as data.
   *
   * Optional, and only worth writing on the capabilities a script computes
   * over — the reads. A model reading `text` needs none of this; code calling
   * `json.loads` on the reply needs to know the field names before it writes
   * the loop, and Anthropic's programmatic-tool-calling guidance is explicit
   * that a documented output shape is what makes that work.
   *
   * Declared rather than inferred: `data` is assembled by hand in the handler,
   * so this is a claim about it, and `check-gateway.ts` is what holds the two
   * together.
   */
  result?: z.ZodType
  /**
   * Spends credits. Routed through a separate executor tool so a human's
   * standing "always allow" on the free executor can never cover a render.
   */
  costsCredits?: boolean
  handler: (ctx: AgentCtx, args: A) => Promise<CapabilityResult>
}

/**
 * What kind of failure this is, for a caller that is code rather than a model.
 *
 * Deliberately **optional and never inferred from the status code**. A status
 * is a transport fact — 403 covers both "not your project" and "the human has
 * not approved that asset yet" — so deriving a taxonomy from it would be a
 * guess dressed as data, which is the same defect as a silently dropped
 * argument. A kind is set only where the throwing site knows the answer;
 * absent means "read the message", which is what a model does anyway.
 */
export type ErrorKind =
  /** The arguments did not match the capability's schema. */
  | 'invalid_args'
  /** No capability by that name. */
  | 'unknown_capability'
  /** Right capability, wrong door — free called as paid, or the reverse. */
  | 'wrong_executor'
  /** A named project/scene/node/asset does not exist. */
  | 'not_found'
  /** The reducer refused the edit. */
  | 'rejected'
  /** Ownership: the caller may not touch this. */
  | 'forbidden'
  /** A human gate is closed — review mode, or an unapproved asset. */
  | 'gated'

/**
 * The kind behind an `AccessError`.
 *
 * The one place a status code really is the meaning: the tenancy gate throws
 * 404 for "no such project" and 403 for "not yours", deliberately distinct
 * (and deliberately *not* distinguished in the message, which must not leak
 * whether someone else's project exists). Reading it back is therefore not the
 * inference this type otherwise forbids — mapping every AccessError to
 * `forbidden` was, and it put `kind: "forbidden"` on a 404 whose own message
 * said "not found".
 */
export function accessKind(status: number): ErrorKind {
  return status === 404 ? 'not_found' : 'forbidden'
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
    readonly kind?: ErrorKind,
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
  result?: z.ZodType
  costsCredits?: boolean
  handler: (ctx: AgentCtx, args: z.infer<S>) => Promise<CapabilityResult>
}): Capability<z.infer<S>> {
  return entry as Capability<z.infer<S>>
}

/** Most handlers return a one-liner and nothing structured beyond it. */
export function said(text: string, data: unknown = null): CapabilityResult {
  return { data, text }
}
