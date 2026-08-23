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
import { CapabilityError, accessKind } from './types'
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
  const asJson = c.req.query('format') === 'json'
  try {
    const described = describeCapabilities(names)
    if (asJson) {
      return c.json({ revision: CATALOG_REVISION, capabilities: described })
    }
    return c.text(described.map(formatDescribe).join('\n\n────────────────────────\n\n'))
  } catch (e) {
    return failure(c, e, asJson)
  }
})

/** Tool 3 — run one capability. `paid=1` is the credit-spending executor. */
agent.post('/tools/:name/execute', async (c) => {
  const name = c.req.param('name')
  const args = await c.req.json().catch(() => ({}))
  const ctx = makeCtx(c.env, c.get('userId'), origin(c))
  const asJson = c.req.query('format') === 'json'
  try {
    const out = await executeCapability(ctx, name, args, { allowPaid: c.req.query('paid') === '1' })
    if (asJson) {
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
    return failure(c, e, asJson)
  }
})

/**
 * Errors are the agent's only teacher here, so a CapabilityError's message is
 * returned verbatim. Anything else is a real fault and says so rather than
 * being dressed up as guidance the agent could act on.
 *
 * Under `?format=json` the body is JSON **including when it fails**. It used to
 * be `text/plain` either way, which meant a caller that parses every reply —
 * code in a programmatic tool call does exactly that — hit a parse error on
 * every capability error, turning the best teaching surface in this system into
 * a crash. The prose is unchanged and lives verbatim in `message`; `kind` is
 * present only where the throwing site knew it (see ErrorKind), so a script can
 * branch without matching on strings and without being lied to when it can't.
 */
function failure(
  c: { text: (b: string, s?: any) => Response; json: (b: unknown, s?: any) => Response },
  e: unknown,
  asJson: boolean,
): Response {
  const [message, status, kind] =
    e instanceof CapabilityError
      ? ([e.message, e.status, e.kind] as const)
      : e instanceof AccessError
        ? ([e.message, e.status, accessKind(e.status)] as const)
        : ([`internal error: ${(e as Error).message}`, 500, undefined] as const)

  if (!(e instanceof CapabilityError) && !(e instanceof AccessError)) {
    console.error('agent gateway fault', e)
  }
  if (asJson) {
    return c.json(
      { error: { message, status, ...(kind ? { kind } : {}), revision: CATALOG_REVISION } },
      status as 400,
    )
  }
  return c.text(message, status as 400)
}
