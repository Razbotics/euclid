import { McpAgent } from 'agents/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { formatDecision, formatQuestionForChat, type Decision } from '@euclid/dsl'

interface Env {
  MCP_OBJECT: DurableObjectNamespace
  API: Fetcher
  INTERNAL_API_KEY: string
}

/** Set by the OAuth layer once wired; dev fallback below. */
type Props = { userId?: string }

/** How long to wait for a client to collect an answer before falling back. */
const ELICIT_TIMEOUT_MS = 30_000

/**
 * A generic gateway, not a tool surface.
 *
 * Every editing capability lives in the API worker's catalog
 * (apps/api/src/agent/) and is reached through `execute`. This worker only
 * knows how to relay — which is the point: an MCP client caches `tools/list`
 * when the session starts, so a surface that names each capability needs a
 * client restart every time one changes. This one never changes, and a catalog
 * edit is live on the next call in the same session.
 *
 * Two things stay native. `ask_user` is a protocol act — the server asks the
 * *client* to open a picker — and its fallback controls what the agent says
 * next; neither survives being turned into a request/response call. And paid
 * work gets its own tool, because MCP permissions are per-tool: with a single
 * executor, "always allow" would quietly cover renders.
 */
export class EuclidMcpAgent extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: 'euclid', version: '0.2.0' })

  private get userId(): string {
    return this.props?.userId ?? 'dev-user'
  }

  private async api(path: string, init?: RequestInit): Promise<Response> {
    return this.env.API.fetch(`https://api${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-internal-key': this.env.INTERNAL_API_KEY,
        'x-user-id': this.userId,
        ...(init?.headers ?? {}),
      },
    })
  }

  /**
   * Relay a gateway response verbatim.
   *
   * A failure body is already written for the agent — it names the argument to
   * fix or the capability to call next — so it is passed through untouched
   * rather than wrapped in a status code the agent cannot act on.
   */
  private async relay(res: Response): Promise<{ content: { type: 'text'; text: string }[] }> {
    const body = await res.text()
    if (!res.ok) throw new Error(body)
    return { content: [{ type: 'text' as const, text: body }] }
  }

  /**
   * Ask the client to collect the answer, via MCP's elicitation capability.
   *
   * This is the honest path: the human answers in their own client's UI and
   * the result comes straight back here, so the agent learns the answer but
   * cannot author it. The fallback — return a block, have the agent relay
   * what the human said — works everywhere but makes the agent an
   * interpreter, which is why that provenance is recorded as `agent`.
   *
   * Returns the text to hand the agent, or null when the client can't elicit
   * and the caller should fall back.
   */
  private async elicit(projectId: string, decision: Decision): Promise<string | null> {
    if (!this.server.server.getClientCapabilities()?.elicitation) return null
    try {
      const result = await this.server.server.elicitInput(
        {
          mode: 'form',
          message: formatQuestionForChat(decision),
          requestedSchema: {
            type: 'object',
            properties: {
              choice: {
                type: 'string',
                title: 'Choice',
                description: decision.question,
                enum: decision.options.map((o) => o.id),
                enumNames: decision.options.map((o) => o.label),
              },
              note: {
                type: 'string',
                title: 'Or in your own words',
                description: 'optional — overrides the choice above',
              },
            },
            required: ['choice'],
          },
        },
        // Bounded on purpose. A client can advertise the capability and still
        // never deliver the request — observed with a Streamable-HTTP client
        // that wasn't reading the stream server-initiated requests arrive on.
        // Without a cap, every question would stall for the default timeout
        // before falling back.
        { timeout: ELICIT_TIMEOUT_MS },
      )

      if (result.action !== 'accept') {
        // Declined or dismissed is not an answer; leave the question open so
        // the agent still knows it is blocked.
        return (
          `The human ${result.action === 'decline' ? 'declined' : 'dismissed'} the question ` +
          `(${decision.id}). It is still open. Ask them in your reply instead:\n\n` +
          formatQuestionForChat(decision)
        )
      }

      const content = (result.content ?? {}) as { choice?: string; note?: string }
      const answered = await this.api(
        `/api/projects/${projectId}/decisions/${decision.id}/answer`,
        {
          method: 'POST',
          body: JSON.stringify({ optionId: content.choice, note: content.note, via: 'chat' }),
        },
      )
      if (!answered.ok) return null // e.g. already answered in the editor
      const { decision: settled } = (await answered.json()) as { decision: Decision }
      return `ANSWERED by the human — continue.\n${formatDecision(settled)}`
    } catch {
      // Capability advertised but the request failed or timed out; the
      // pasteable block still works, so degrade rather than fail the tool.
      return null
    }
  }

  async init(): Promise<void> {
    this.server.tool(
      'instructions',
      'READ THIS FIRST in every new thread, before any other Euclid tool. Returns how this ' +
        'surface works, how a video project is put together, and the full list of capabilities ' +
        'with a one-line summary each. Free, and cheap enough to call whenever you are unsure. ' +
        'Most capabilities are callable straight from their summary; the list is the map for ' +
        'everything else.',
      {},
      async () => this.relay(await this.api('/api/agent/tools')),
    )

    this.server.tool(
      'describe',
      'Full arguments and behaviour for named capabilities (batch — pass several at once). ' +
        'Free. Call it when a summary from `instructions` is not enough, or when `execute` ' +
        'rejects your arguments. The behaviour notes matter: several capabilities succeed in ' +
        'ways that change nothing on screen, and this is where that is written down.',
      {
        names: z
          .array(z.string())
          .min(1)
          .describe('capability names, e.g. ["animate","morph_latex"]'),
      },
      async ({ names }) =>
        this.relay(
          await this.api('/api/agent/tools/describe', {
            method: 'POST',
            body: JSON.stringify({ names }),
          }),
        ),
    )

    this.server.tool(
      'execute',
      'Run one Euclid capability. `name` comes from `instructions`; `args` is a plain object ' +
        'matching that capability\'s arguments. Every FREE capability runs here — creating ' +
        'projects and scenes, adding and editing nodes, animating, narration text, captions, ' +
        'assets, reading the document. Iterate as much as you like; none of it costs credits. ' +
        'Capabilities that spend credits refuse this tool and must go through `execute_paid`.',
      {
        name: z.string().describe('capability name from instructions, e.g. "add_latex"'),
        args: z.record(z.any()).default({}).describe("the capability's arguments as an object"),
      },
      async ({ name, args }) =>
        this.relay(
          await this.api(`/api/agent/tools/${encodeURIComponent(name)}/execute`, {
            method: 'POST',
            body: JSON.stringify(args ?? {}),
          }),
        ),
    )

    this.server.tool(
      'execute_paid',
      'Run one Euclid capability that SPENDS CREDITS — today `generate_narration` (speech ' +
        'synthesis, priced by script length) and `render_video` (priced per second of video). ' +
        'Separate from `execute` on purpose, so that allowing free edits never silently allows ' +
        'a charge. Everything else is free and belongs in `execute`, which this tool refuses. ' +
        'Get the script right with the free capabilities before spending anything here.',
      {
        name: z.string().describe('a credit-spending capability, e.g. "render_video"'),
        args: z.record(z.any()).default({}).describe("the capability's arguments as an object"),
      },
      async ({ name, args }) =>
        this.relay(
          await this.api(`/api/agent/tools/${encodeURIComponent(name)}/execute?paid=1`, {
            method: 'POST',
            body: JSON.stringify(args ?? {}),
          }),
        ),
    )

    this.server.tool(
      'ask_user',
      'Put a choice to the human IN CHAT and wait for their reply. Free. Use when a decision is ' +
        'genuinely theirs — pacing, style, how to resolve a narration overrun, whether a scene ' +
        'change needs explaining — not for things you can determine yourself. This is blocking ' +
        'by intention. If your client supports MCP elicitation you will be shown the answer ' +
        'directly; otherwise it returns a ready-to-paste block — put it in your very next reply ' +
        'and stop. Do not keep building against a guess, and do not defer the question to a ' +
        'summary at the end — an unanswered question that you worked around was not a question. ' +
        'Chat is the surface that always exists — the system may run headless with no editor ' +
        'open, so never wait on a browser. When they reply, close the question with ' +
        'execute(name="record_answer").',
      {
        projectId: z.string(),
        question: z.string().min(1).describe('one clear question'),
        options: z
          .array(z.object({ label: z.string(), detail: z.string().optional() }))
          .min(2)
          .max(6)
          .describe('2-6 mutually exclusive choices; say what each one does'),
        detail: z.string().optional().describe('context they need to choose well'),
        sceneId: z.string().optional(),
        atSec: z.number().min(0).optional().describe('global seconds; the editor seeks here'),
      },
      async ({ projectId, question, options, detail, sceneId, atSec }) => {
        const res = await this.api(`/api/projects/${projectId}/decisions`, {
          method: 'POST',
          body: JSON.stringify({
            question,
            detail,
            // Stable, readable ids so the agent can refer to a choice later.
            options: options.map((o, i) => ({ id: `opt${i + 1}`, ...o })),
            context: sceneId || atSec !== undefined ? { sceneId, atSec } : undefined,
          }),
        })
        if (!res.ok) throw new Error(`ask_user failed (${res.status}): ${await res.text()}`)
        const { decision } = (await res.json()) as { decision: Decision }

        // Preferred path: have the client collect the answer itself, so the
        // human gets their own native picker and the answer travels
        // client → server with the agent never in the middle.
        const elicited = await this.elicit(projectId, decision)
        if (elicited) return { content: [{ type: 'text' as const, text: elicited }] }

        // Fallback. The return value is the strongest prompt surface there is
        // — the agent reads it the instant it lands. A receipt ("asked (id)")
        // gets filed and worked around; an instruction gets followed. This
        // wording exists because a real run asked a good question, scheduled a
        // wakeup, built the rest of the video against its own guess, and only
        // mentioned the unanswered question in its closing summary.
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `STOP — WAITING ON THE HUMAN (${decision.id})\n` +
                `Paste the block below into your NEXT reply, then stop and wait. Do not ` +
                `continue building, do not pick a default, and do not save it for a ` +
                `summary later.\n\n` +
                `────────────────────────────\n` +
                `${formatQuestionForChat(decision)}\n` +
                `────────────────────────────\n\n` +
                `When they reply to you, call execute(name="record_answer") with decisionId ` +
                `${decision.id} and optionId ${decision.options
                  .map((o, i) => `${i + 1}→${o.id}`)
                  .join(' ')} (or note=<their words>). Nothing else closes this question and ` +
                `nothing will remind you: continuing without an answer means you ` +
                `decided it yourself.`,
            },
          ],
        }
      },
    )
  }
}

const handler = EuclidMcpAgent.serve('/mcp')

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return handler.fetch(request, env, ctx)
  },
}
