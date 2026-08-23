import { z } from 'zod'

/**
 * Questions the agent puts to the human.
 *
 * Deliberately **not** part of `EuclidDoc`. A decision is workflow state, not
 * video content: putting it in the document would bump SCHEMA_VERSION, reach
 * the renderer, and make the render contract depend on something that never
 * affects a frame. It lives in the project's Durable Object instead, which
 * already serializes writes and broadcasts to every connected editor — so
 * decisions sync live for free without touching the document.
 *
 * The point of asking in the project rather than in the agent's chat is
 * context: "narration overruns by 1.92s" is a question about a moment in a
 * video, and the editor is where you can scrub to that moment before choosing.
 */

export interface DecisionOption {
  id: string
  label: string
  /** What choosing this actually does; shown under the label. */
  detail?: string
}

/** Where in the video the question is about, so the editor can jump there. */
export interface DecisionContext {
  sceneId?: string
  nodeId?: string
  /** global seconds — the editor seeks here when the question is opened */
  atSec?: number
}

/**
 * What this decision is *about*, beyond its text — the hook review flows hang
 * off (plans/010). A decision with refs is still an ordinary decision: same
 * answer surfaces, same first-answer-wins. What changes is the consequence of
 * answering — the DO flips the referenced plan's status, and (phase 2) writes
 * the referenced assets' review status — and how the editor renders it.
 */
export interface DecisionRefs {
  /** A plan revision this decision approves or bounces. */
  planId?: string
  /** Assets under review; the editor shows them inline. (Phase 2.) */
  assetIds?: string[]
  /**
   * Moments of the video this question is about, in global seconds.
   *
   * The one ref with **no consequence** — the others change what answering
   * does, this only changes what the human is looking at while they decide.
   * `request_review` puts *assets* in front of someone; what milestone run 8
   * actually needed eyes on was the **composition**, and the contact sheet
   * reached the human only by being described in chat.
   *
   * Plural on purpose. `context.atSec` is one place to seek to; a composition
   * question is usually about how several moments sit together — does this
   * caption collide at 3s, is the orbit still legible at 8s — and answering it
   * from one frame is how a run concludes the wrong thing.
   */
  previewAt?: number[]
}

/**
 * Which surface produced the answer, in descending order of trust:
 *  - `chat`   — the human answered a protocol elicitation directly in their
 *               client. Nothing interpreted it.
 *  - `editor` — the human clicked an option in the editor.
 *  - `agent`  — the agent relayed what it understood the human to say. The
 *               only path where the answer is an interpretation, which is
 *               exactly why it is recorded distinctly.
 */
export type AnswerVia = 'chat' | 'editor' | 'agent'

export interface DecisionAnswer {
  /** Absent when the human wrote a free-text answer instead of picking. */
  optionId?: string
  note?: string
  via: AnswerVia
  at: number
}

export interface Decision {
  id: string
  question: string
  detail?: string
  options: DecisionOption[]
  context?: DecisionContext
  refs?: DecisionRefs
  createdAt: number
  status: 'open' | 'answered'
  answer?: DecisionAnswer
}

export const DecisionOptionSchema: z.ZodType<DecisionOption> = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(120),
  detail: z.string().max(400).optional(),
})

export const DecisionContextSchema: z.ZodType<DecisionContext> = z.object({
  sceneId: z.string().optional(),
  nodeId: z.string().optional(),
  atSec: z.number().min(0).optional(),
})

export const DecisionRefsSchema: z.ZodType<DecisionRefs> = z.object({
  planId: z.string().min(1).optional(),
  assetIds: z.array(z.string().min(1)).max(20).optional(),
  // 16 is the contact sheet's tile cap, and this is a sanity bound rather than
  // the enforcement: the times are handed to preview_frames, whose own cap is
  // what actually refuses too many. Images are the most context-expensive
  // thing a tool returns, and that is where the reasoning for the number lives.
  previewAt: z.array(z.number().min(0)).max(16).optional(),
})

/** What a caller supplies; the server mints id/createdAt/status. */
export const NewDecisionSchema = z.object({
  question: z.string().min(1).max(400),
  detail: z.string().max(2000).optional(),
  // At least two, or it isn't a choice. Capped so the editor stays readable
  // and the agent can't dump a menu on the human.
  options: z.array(DecisionOptionSchema).min(2).max(6),
  context: DecisionContextSchema.optional(),
  refs: DecisionRefsSchema.optional(),
})
export type NewDecision = z.infer<typeof NewDecisionSchema>

export const SubmitAnswerSchema = z
  .object({
    optionId: z.string().optional(),
    note: z.string().max(2000).optional(),
    via: z.enum(['chat', 'editor', 'agent']),
  })
  // An answer with neither a choice nor a note says nothing.
  .refine((a) => !!a.optionId || !!a.note?.trim(), {
    message: 'answer must pick an option or provide a note',
  })
export type SubmitAnswer = z.infer<typeof SubmitAnswerSchema>

export const DecisionSchema: z.ZodType<Decision> = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  detail: z.string().optional(),
  options: z.array(DecisionOptionSchema),
  context: DecisionContextSchema.optional(),
  refs: DecisionRefsSchema.optional(),
  createdAt: z.number().int(),
  status: z.enum(['open', 'answered']),
  answer: z
    .object({
      optionId: z.string().optional(),
      note: z.string().optional(),
      via: z.enum(['chat', 'editor', 'agent']),
      at: z.number().int(),
    })
    .optional(),
})

/**
 * The question rendered for a human to read in a chat reply.
 *
 * Chat is the primary surface: the system may run headless, with no editor
 * open and nobody to click a button, so a question that only exists in a web
 * panel is a question nobody is asked. Options are numbered so the answer can
 * be "2" rather than an option id.
 */
export function formatQuestionForChat(d: Decision): string {
  const lines = [d.question]
  if (d.detail) lines.push('', d.detail)
  // Name the moments the frames came from. A human reading this in chat is
  // being shown a contact sheet beside it, and a tile they cannot place in the
  // video is a tile they cannot judge.
  const at = d.refs?.previewAt
  if (at?.length) {
    lines.push(
      '',
      `Frames above are at ${at.map((t) => `${t.toFixed(1)}s`).join(', ')} ` +
        `(open the editor to scrub around them).`,
    )
  }
  lines.push('')
  d.options.forEach((o, i) => {
    lines.push(`  ${i + 1}. ${o.label}${o.detail ? ` — ${o.detail}` : ''}`)
  })
  lines.push('', 'Reply with a number, or tell me what you want instead.')
  return lines.join('\n')
}

/** Compact text for the agent — MCP results must stay cheap. */
export function formatDecision(d: Decision): string {
  const lines = [`[${d.status}] ${d.id}: ${d.question}`]
  if (d.detail) lines.push(`  ${d.detail}`)
  for (const o of d.options) {
    lines.push(`  - ${o.id}: ${o.label}${o.detail ? ` — ${o.detail}` : ''}`)
  }
  if (d.answer) {
    const picked = d.options.find((o) => o.id === d.answer!.optionId)
    lines.push(
      `  answered via ${d.answer.via}: ${picked?.label ?? '(free text)'}` +
        (d.answer.note ? ` — "${d.answer.note}"` : ''),
    )
  }
  return lines.join('\n')
}
