export interface Env {
  PROJECT: DurableObjectNamespace
  DB: D1Database
  ASSETS: R2Bucket
  APP_ORIGIN: string
  BETTER_AUTH_SECRET: string
  /** Better Auth cloud dashboard key (optional; from .env.local). */
  BETTER_AUTH_API_KEY?: string
  /** Public dev-tunnel origin (optional; set by scripts/tunnel.sh). */
  TUNNEL_ORIGIN?: string
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  /** Shared secret for service-to-service calls (MCP worker, render worker). */
  INTERNAL_API_KEY: string
  /**
   * Dev-only: '1' lets requests without a session act as user 'dev-user' so
   * the editor can sync before auth UI exists. NEVER set in production.
   */
  DEV_ALLOW_ANON?: string
}

export interface Vars {
  userId: string
}
