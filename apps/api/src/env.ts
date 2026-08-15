export interface Env {
  PROJECT: DurableObjectNamespace
  DB: D1Database
  ASSETS: R2Bucket
  APP_ORIGIN: string
  /**
   * Public origin of this API, used to build URLs handed to clients.
   * Required because service-binding requests (from the MCP worker) arrive
   * with an internal hostname — deriving the origin from the request would
   * produce unusable links like https://api/...
   */
  PUBLIC_API_ORIGIN?: string
  BETTER_AUTH_SECRET: string
  /** Better Auth cloud dashboard key (optional; from .env.local). */
  BETTER_AUTH_API_KEY?: string
  /** Public dev-tunnel origin (optional; set by scripts/tunnel.sh). */
  TUNNEL_ORIGIN?: string
  /** TTS provider (ElevenLabs, chosen for word-level timestamps). */
  ELEVENLABS_API_KEY: string
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  /** Shared secret for service-to-service calls (MCP worker, render worker). */
  INTERNAL_API_KEY: string
  /**
   * Where `preview_frames` captures frames. A Worker cannot run Chromium, so
   * capture happens out of process; defaults to the local preview server in
   * dev. Production points this at the render backend — never a second
   * renderer, or preview frames stop being export frames.
   */
  PREVIEW_ORIGIN?: string
  /**
   * Dev-only: '1' lets requests without a session act as user 'dev-user' so
   * the editor can sync before auth UI exists. NEVER set in production.
   */
  DEV_ALLOW_ANON?: string
}

export interface Vars {
  userId: string
}
