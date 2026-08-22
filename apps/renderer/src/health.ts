/**
 * Whether the render worker's **drain loop** is alive, as a pure function of
 * what the loop last recorded.
 *
 * Separate from `render-worker.ts` because that module *is* a running daemon —
 * it has top-level await and starts polling on import, so a test cannot ask it
 * anything. Here the verdict can be checked at states no live worker will hold
 * still in: the interesting ones are a loop that has stopped while the process
 * lingers, and a loop that is busy, which must never be mistaken for a dead one.
 */

/** What the loop is doing. Only `idle` carries a staleness bound — see below. */
export type Phase = 'starting' | 'idle' | 'probe' | 'shots' | 'proxy' | 'render' | 'stopped'

export interface HealthInput {
  phase: Phase
  /** When the loop last began a claim round trip. */
  lastPollAt: number
  now: number
  pollMs: number
}

export interface HealthVerdict {
  ok: boolean
  /** Present only when unhealthy, and says which failure it is. */
  reason?: string
}

/** Generous: four polls plus a second, so a slow API does not read as death. */
export const idleStaleMs = (pollMs: number): number => pollMs * 4 + 1000

/**
 * The rule, and the one judgement in it worth stating.
 *
 * A worker that is **busy** has not polled and must still read healthy: a
 * render or a transcode legitimately goes minutes without touching the top of
 * the loop, and failing health for that would cry wolf on exactly the worker
 * doing the most work. So staleness applies to `idle` alone — the phase whose
 * whole definition is "round-tripping the claim endpoint every pollMs".
 *
 * `stopped` is unhealthy at any age. It is the state that motivated all of
 * this: the loop having ended while the process survives it.
 */
export function healthVerdict({ phase, lastPollAt, now, pollMs }: HealthInput): HealthVerdict {
  if (phase === 'stopped') return { ok: false, reason: 'drain loop has stopped' }
  if (phase === 'idle' && now - lastPollAt > idleStaleMs(pollMs)) {
    return { ok: false, reason: 'drain loop is not polling' }
  }
  return { ok: true }
}
