/** Hard product ceilings for v1. Enforced by the document schema and the render endpoint. */
export const LIMITS = {
  maxDurationSec: 600,
  maxCanvasWidth: 1920,
  maxCanvasHeight: 1080,
  maxScenes: 100,
  maxNodesPerScene: 200,
  maxOpsPerEnvelope: 50,
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
