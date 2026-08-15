import { z } from 'zod'
import { formatDecision, type Decision } from '@euclid/dsl'
import { projectStub } from '../shared'
import { PROJECT_ID } from './schemas'
import { capability, said, CapabilityError } from './types'

/**
 * `ask_user` is deliberately NOT here.
 *
 * Asking is an MCP *protocol* act: the server asks the client to open its own
 * picker (elicitation), and the fallback controls what the agent puts in its
 * very next reply. Neither is expressible as a request/response capability, so
 * asking stays a native tool in the gateway. Closing a question is ordinary
 * state, so it lives here.
 */
export const decisionTools = [
  capability({
    name: 'record_answer',
    summary: 'Close an ask_user question with the answer the human gave you.',
    doc: [
      'Free. The only thing that closes a question, and nothing will chase you for it.',
      '',
      'Only for what they actually said — never guess on their behalf. If they have not answered, keep waiting rather than choosing for them: continuing without an answer means you decided it yourself.',
      '',
      'Provenance is kept and ranked by trust. This capability records `agent` — your reading of what they said, the only path where the answer is an interpretation. First answer wins; a second is refused rather than overwriting.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      decisionId: z.string().min(1),
      optionId: z.string().optional().describe('the id of the option they chose'),
      note: z.string().optional().describe('their answer verbatim, if they did not pick an option'),
    }),
    async handler(ctx, { projectId, decisionId, optionId, note }) {
      await ctx.requireProject(projectId)
      if (!optionId && !note) {
        throw new CapabilityError('pass optionId (what they picked) or note (what they said)')
      }
      const res = await projectStub(ctx.env, projectId).fetch(
        `https://do/decisions/${decisionId}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ optionId, note, via: 'agent' }),
        },
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; decision?: Decision }
        if (body.error === 'already_answered' && body.decision) {
          throw new CapabilityError(
            `question ${decisionId} was already answered — first answer wins:\n` +
              formatDecision(body.decision),
            409,
          )
        }
        throw new CapabilityError(
          `could not record the answer (${res.status}): ${body.error ?? 'unknown'}`,
          res.status,
        )
      }
      const { decision } = (await res.json()) as { decision: Decision }
      return said(formatDecision(decision), { decision })
    },
  }),
]
