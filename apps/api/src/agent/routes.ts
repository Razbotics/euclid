import { Hono } from 'hono'
import { AccessError } from '../shared'
import { CATALOG_REVISION, capabilities } from './catalog'
import { makeCtx } from './context'
import {
  buildInstructions,
  describeCapabilities,
  executeCapability,
  formatDescribe,
} from './execute'
import { CapabilityError } from './types'
import type { Env, Vars } from '../env'

/**
 * The gateway the MCP worker sits on: three endpoints standing in for every
 * capability, so the agent-facing tool list never changes and a catalog edit is
 * live on the next call rather than the next reconnect.
 *
 * Responses are `text/plain` by default — the agent reads text, and keeping it
 * cheap is what makes iteration free. `?format=json` returns the structured
 * payload instead, which is what the editor will bind to.
 */
export const agent = new Hono<{ Bindings: Env; Variables: Vars }>()

function origin(c: { env: Env; req: { url: string } }): string {
  return c.env.PUBLIC_API_ORIGIN ?? new URL(c.req.url).origin
}

/** Tool 1 — orientation plus the whole capability list. */
agent.get('/tools', (c) => {
  if (c.req.query('format') === 'json') {
    return c.json({
      revision: CATALOG_REVISION,
      instructions: buildInstructions(),
      capabilities: capabilities.map((x) => ({
        name: x.name,
        summary: x.summary,
        costsCredits: !!x.costsCredits,
      })),
    })
  }
  return c.text(buildInstructions())
})

/** Tool 2 — the full contract for named capabilities. */
agent.post('/tools/describe', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { names?: unknown }
  const names = Array.isArray(body.names)
    ? body.names.filter((n): n is string => typeof n === 'string')
    : typeof body.names === 'string'
      ? [body.names]
      : []
  try {
    const described = describeCapabilities(names)
    if (c.req.query('format') === 'json') {
      return c.json({ revision: CATALOG_REVISION, capabilities: described })
    }
    return c.text(described.map(formatDescribe).join('\n\n────────────────────────\n\n'))
  } catch (e) {
    return failure(c, e)
  }
})

/** Tool 3 — run one capability. `paid=1` is the credit-spending executor. */
agent.post('/tools/:name/execute', async (c) => {
  const name = c.req.param('name')
  const args = await c.req.json().catch(() => ({}))
  const ctx = makeCtx(c.env, c.get('userId'), origin(c))
  try {
    const out = await executeCapability(ctx, name, args, { allowPaid: c.req.query('paid') === '1' })
    if (c.req.query('format') === 'json') {
      return c.json({
        revision: out.revision,
        name: out.name,
        data: out.data,
        text: out.text,
        ...(out.image ? { image: out.image } : {}),
      })
    }
    // The plain-text form cannot carry an image, so it says one exists rather
    // than dropping it silently — a caller reading only text should know it is
    // missing the point of the call.
    return c.text(out.image ? `${out.text}\n\n[image omitted: request ?format=json]` : out.text)
  } catch (e) {
    return failure(c, e)
  }
})

/**
 * Errors are the agent's only teacher here, so a CapabilityError's message is
 * returned verbatim as the body. Anything else is a real fault and says so
 * rather than being dressed up as guidance the agent could act on.
 */
function failure(
  c: { text: (b: string, s?: any) => Response },
  e: unknown,
): Response {
  if (e instanceof CapabilityError) return c.text(e.message, e.status as 400)
  if (e instanceof AccessError) return c.text(e.message, e.status as 403)
  console.error('agent gateway fault', e)
  return c.text(`internal error: ${(e as Error).message}`, 500)
}
