import { betterAuth } from 'better-auth'
import { D1Dialect } from 'kysely-d1'
import type { Env } from './env'

/**
 * Better Auth over D1 (Kysely dialect). Generate/migrate the auth tables with:
 *   npx @better-auth/cli generate   (then apply the SQL to D1)
 *
 * This same instance will later back the MCP OAuth flow (claude.ai connects to
 * the MCP worker via OAuth; the authorization server is this API).
 */
export function makeAuth(env: Env) {
  return betterAuth({
    database: {
      dialect: new D1Dialect({ database: env.DB }),
      type: 'sqlite',
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: undefined,
    trustedOrigins: [env.APP_ORIGIN, ...(env.TUNNEL_ORIGIN ? [env.TUNNEL_ORIGIN] : [])],
    emailAndPassword: { enabled: true },
  })
}
