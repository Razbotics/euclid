/** Hard product ceilings for v1. Enforced by the document schema and the render endpoint. */
export const LIMITS = {
  maxDurationSec: 600,
  /**
   * The canvas is bounded by **pixels and a longest side**, not by a width and
   * a height.
   *
   * It used to be `maxCanvasWidth: 1920, maxCanvasHeight: 1080`, which reads
   * like a resolution budget and is actually a *shape*: it makes 1080x1920
   * fail the schema, so a vertical video — the native format of everything
   * this is pointed at — could not be created at all.
   *
   * A budget of 1920x1080 pixels admits 16:9 (1920x1080), 9:16 (1080x1920) and
   * 1:1 (1440x1440) at exactly the same cost, which is the point: the renderer
   * cares how many pixels it must fill, never how they are arranged.
   */
  maxCanvasDimension: 1920,
  maxCanvasPixels: 1920 * 1080,
  maxScenes: 100,
  maxNodesPerScene: 200,
  maxOpsPerEnvelope: 50,
  /**
   * Keyframes on one property track.
   *
   * There was no cap while `animate` could only add two at a time; taking a
   * whole list in one call makes one worth having. The binding constraint is
   * the document, not the sampler — it lives under a single Durable Object key
   * and DO values stop at 128 KiB, and a position keyframe is ~50 bytes. 500
   * is far past useful (50 per second on a 10s scene) and nowhere near the
   * budget.
   */
  maxKeyframesPerTrack: 500,
  /**
   * Audio lanes on one document, and clips on one lane. Every clip becomes an
   * ffmpeg input with its own filter chain at export, so this is a mux-time
   * ceiling as much as a UI one — `amix` with hundreds of inputs is where a
   * render stops being a render and starts being a hang.
   */
  maxAudioTracks: 8,
  maxClipsPerTrack: 100,
  /**
   * Camera zoom is bounded rather than merely positive. A zoom of 1e-9 or 1e9
   * is a degenerate transform that renders as an empty frame, which reads as a
   * broken renderer rather than as a bad argument — and the agent's only view
   * of it is a blank contact sheet.
   */
  minCameraZoom: 0.05,
  maxCameraZoom: 50,
  /**
   * Cells in one matrix or token strip. A structured primitive is one node, so
   * without this a single call could put 10,000 sprites on the stage and the
   * per-scene node cap would not notice.
   */
  maxCells: 400,
  /** Points in one cloud. Drawn as one Graphics, so the cost is per point, not per node. */
  maxPoints: 2000,
  /**
   * Triangles in one mesh. Every triangle is projected, sorted and filled on
   * the CPU each frame — there is no GPU in the render container — so this is
   * a frame-time ceiling rather than a memory one. Measured, not guessed: see
   * the budget table in plans/009.
   */
  maxTriangles: 4000,
  /**
   * Triangles in an **imported** mesh, which is far below the render ceiling
   * above and for an unrelated reason: imported geometry is stored in the
   * document, the document lives under one Durable Object key, and DO values
   * are capped at 128 KiB. Measured (plans/009): 4,000 triangles serialise to
   * ~105KB of coordinates, leaving nothing for the scene around them; 2,000
   * costs ~48KB. The limit here is the document budget, not the frame budget.
   */
  maxImportedTriangles: 2000,
  /**
   * Largest file a user may upload, per file.
   *
   * Uploads are the *only* way media enters a project (plans/003 picked
   * "users bring their own", so there is no fetcher), which makes this the one
   * place a project's storage can run away. R2 has no practical per-object
   * limit; this is a product ceiling, and 500MB is comfortably more than the
   * source clips this edits and comfortably less than a feature film.
   */
  maxUploadBytes: 500 * 1024 * 1024,
  /**
   * Camera distance from the focus plane. The floor keeps the perspective
   * divide away from the scene itself — a camera 10px from a diagram turns it
   * inside out — and the ceiling is orthographic for all practical purposes.
   */
  minCameraDistance: 200,
  maxCameraDistance: 1e6,
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

/**
 * Canvas shapes worth naming.
 *
 * All of them cost the same to render — `LIMITS.maxCanvasPixels` is a pixel
 * budget, not a resolution — so the choice is purely about where the video is
 * going. Every one has even dimensions, which H.264 requires.
 */
export const CANVAS_PRESETS = {
  landscape: { width: 1920, height: 1080, note: '16:9 — YouTube, embeds, anything widescreen' },
  portrait: { width: 1080, height: 1920, note: '9:16 — reels, shorts, stories' },
  square: { width: 1440, height: 1440, note: '1:1 — feed posts' },
  vertical_4_5: { width: 1152, height: 1440, note: '4:5 — the tallest most feeds will show' },
} as const

export type CanvasPreset = keyof typeof CANVAS_PRESETS
