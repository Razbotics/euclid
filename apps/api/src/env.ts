export interface Env {
  PROJECT: DurableObjectNamespace
  DB: D1Database
  ASSETS: R2Bucket
  APP_ORIGIN: string
  BETTER_AUTH_SECRET: string
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  /** Shared secret for service-to-service calls (MCP worker, render worker). */
  INTERNAL_API_KEY: string
}

export interface Vars {
  userId: string
}
