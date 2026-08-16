/** Hard product ceilings for v1. Enforced by the document schema and the render endpoint. */
export const LIMITS = {
  maxDurationSec: 600,
  maxCanvasWidth: 1920,
  maxCanvasHeight: 1080,
  maxScenes: 100,
  maxNodesPerScene: 200,
  maxOpsPerEnvelope: 50,
  /**
   * Camera zoom is bounded rather than merely positive. A zoom of 1e-9 or 1e9
   * is a degenerate transform that renders as an empty frame, which reads as a
   * broken renderer rather than as a bad argument — and the agent's only view
   * of it is a blank contact sheet.
   */
  minCameraZoom: 0.05,
  maxCameraZoom: 50,
} as const

/**
 * Credit pricing. 1 credit ≈ $0.01 retail (packs sold via Stripe).
 * Agent iteration (ops, previews) is free — credits meter renders and TTS only.
 */
export const CREDIT_COSTS = {
  renderPerSecond1080: 1,
  renderPerSecond720: 0.5,
  ttsPerMinute: 10,
} as const

/**
 * Speech rate used to price TTS. ~150 words/min at ~6 chars a word.
 * Pricing on characters rather than on the resulting audio matters: the cost
 * is knowable *before* synthesis, so the debit can be taken up front and
 * quoted to the agent, and it tracks how TTS providers actually bill.
 */
export const TTS_CHARS_PER_MINUTE = 900

/** Credits to synthesize `text`. Minimum 1 — no narration is free. */
export function ttsCost(text: string): number {
  const chars = text.trim().length
  if (chars === 0) return 0
  return Math.max(1, Math.ceil((chars / TTS_CHARS_PER_MINUTE) * CREDIT_COSTS.ttsPerMinute))
}
