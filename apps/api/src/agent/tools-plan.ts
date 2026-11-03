import { z } from 'zod'
import {
  formatPlan,
  planRemaining,
  ttsCost,
  type PlanAssetKind,
  type ProposedPlan,
} from '@euclid/dsl'
import { falModel, modelsOfKind, priceOf } from '../fal'
import { requireAsset } from '../services/assets'
import { listPlans, proposePlan, reviewModeOf, setReviewMode } from '../services/plan'
import { AccessError, projectStub } from '../shared'
import { PROJECT_ID } from './schemas'
import { capability, said, CapabilityError } from './types'
import type { Decision } from '@euclid/dsl'

/**
 * The human-in-the-loop plan (plans/010, phase 1).
 *
 * Projects start in review mode: paid generation is gated behind a plan the
 * human has approved. The plan's approval is a *budget* — the roster of asset
 * kinds plus a server-priced credit estimate — and each gated generation draws
 * it down. Approval rides the existing decision mechanism: propose_plan mints
 * a decision alongside the plan, and answering that decision (editor click or
 * record_answer) is what flips the plan's status.
 */

/** Mirrors the generate_* capability defaults, so an unpriced item is priced
 * as the call the agent would most likely make. */
const DEFAULT_MODEL: Record<PlanAssetKind, string> = {
  image: 'flux-schnell',
  video: 'ltx-video',
  audio: 'stable-audio',
  model: 'trellis',
}

const STOP_BLOCK = (decisionId: string, chat: string) =>
  [
    'STOP — WAITING ON THE HUMAN.',
    'Present this plan in your next reply and wait for their answer. Do not',
    'generate anything, and do not choose for them.',
    '',
    '--- paste from here ---',
    chat,
    '--- to here ---',
    '',
    `When they answer, call record_answer(decisionId: "${decisionId}") with`,
    'optionId "approve", or optionId "request_changes" plus their feedback as',
    'the note. Then act on it: approved means generate within the budget;',
    'changes mean revise and propose again.',
  ].join('\n')

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

export const planTools = [
  capability({
    name: 'propose_plan',
    summary: 'Propose scenes + assets + a priced budget for the human to approve.',
    doc: [
      'Free. In review mode (the default) this must be approved before any paid generation runs — the gate on generate_* and generate_narration checks the plan roster and its remaining budget.',
      '',
      '**The estimate is computed server-side** from the model roster and the narration drafts; you cannot set it. What the human approves is a budget: each generation draws it down, a failed one refunds it, and a call outside the roster or past the budget is refused with "propose a revision" as the remedy.',
      '',
      '**Budget iterations honestly.** `count` on an asset item is total attempts, iterations included — one attempt is rarely enough, and asking for more up front beats coming back after every miss. `narrationTakes` is the same idea for TTS (default 2: a first take plus one revision), priced from the scene narration drafts — so include the drafts, or pass narrationTakes: 0.',
      '',
      'Proposing again supersedes any plan still awaiting an answer; a revision after approval starts a fresh budget, so scope it to the *remaining* work.',
      '',
      'The response ends with a ready-to-paste block. Present it and STOP — a question that does not stop the asker is a log line, not a question.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      summary: z.string().min(1).max(500).describe('one sentence: what the video is'),
      scenes: z
        .array(
          z.object({
            title: z.string().min(1).max(120),
            narration: z.string().max(2000).optional().describe('draft script — prices the narration budget'),
            beats: z.string().max(400).optional().describe('what happens on screen, one line'),
          }),
        )
        .min(1)
        .max(50),
      assets: z
        .array(
          z.object({
            kind: z.enum(['image', 'video', 'audio', 'model']),
            description: z.string().min(1).max(300).describe("what it is for, in the human's terms"),
            model: z.string().optional().describe('roster name; defaults to the cheap model of that kind'),
            count: z.number().int().min(1).max(20).default(1).describe('budgeted attempts, iterations included'),
            durationSec: z
              .number()
              .positive()
              .optional()
              .describe('for models priced by length (the Seedance family): the clip length to budget for'),
            resolution: z
              .string()
              .optional()
              .describe('for models priced by frame size: the resolution to budget for'),
          }),
        )
        .max(30)
        .default([]),
      narrationTakes: z
        .number()
        .int()
        .min(0)
        .max(5)
        .default(2)
        .describe('TTS syntheses budgeted across the scene drafts; 0 = no narration'),
    }),
    async handler(ctx, { projectId, summary, scenes, assets, narrationTakes }) {
      await ctx.requireProject(projectId)

      const priced = assets.map((a) => {
        const name = a.model ?? DEFAULT_MODEL[a.kind]
        let m
        try {
          m = falModel(name)
        } catch {
          const roster = modelsOfKind(a.kind)
            .map((x) => `${x.name} (${x.credits} credits)`)
            .join(', ')
          throw new CapabilityError(
            `no model named "${name}" — for ${a.kind}, the roster is: ${roster}`,
          )
        }
        if (m.kind !== a.kind) {
          throw new CapabilityError(
            `model ${m.name} generates ${m.kind}, but the item says kind ${a.kind} — make them agree`,
          )
        }
        return {
          kind: a.kind,
          description: a.description,
          model: m.name,
          count: a.count,
          // A per-second model is priced from the item's own length when it
          // gives one. Without that the typical-call figure stands in — and it
          // underestimated a 15s Seedance 2.5 clip by a third, so the gate
          // refused the very generation the plan was proposed for.
          estCredits:
            (m.price && a.durationSec
              ? priceOf(m, {
                  prompt: '',
                  durationSec: a.durationSec,
                  ...(a.resolution ? { resolution: a.resolution } : {}),
                })
              : m.credits) * a.count,
        }
      })

      const draftCost = scenes.reduce((sum, s) => sum + ttsCost(s.narration ?? ''), 0)
      if (narrationTakes > 0 && draftCost === 0) {
        throw new CapabilityError(
          `narrationTakes is ${narrationTakes} but no scene carries a narration draft — ` +
            `the estimate is priced from the drafts, so include them (or pass narrationTakes: 0)`,
        )
      }
      const narrationEstCredits = draftCost * narrationTakes
      const proposed: ProposedPlan = {
        summary,
        scenes,
        assets: priced,
        narrationTakes,
        narrationEstCredits,
        estTotalCredits: priced.reduce((sum, a) => sum + a.estCredits, 0) + narrationEstCredits,
      }

      const { plan, decision } = await proposePlan(ctx.env, projectId, proposed)
      const chat = [
        `Here is my plan (${plan.estTotalCredits} credits of generation; rendering is priced separately at render time):`,
        '',
        formatPlan(plan),
        '',
        'Reply "approve", or tell me what to change.',
      ].join('\n')
      return said(STOP_BLOCK(decision.id, chat), { plan, decisionId: decision.id })
    },
  }),

  capability({
    name: 'get_plan',
    summary: "The project's plan: status, roster, budget remaining.",
    doc: [
      'Free. Shows the latest plan revision and, when one is approved, how much of its budget is left. While a plan is `proposed`, the human has not answered yet — keep waiting rather than generating.',
      '',
      'No plan at all in review mode means propose_plan is your next call.',
    ].join('\n'),
    args: z.object({ projectId: PROJECT_ID }),
    result: z.object({
      reviewMode: z.boolean().describe('true while the gate is on'),
      plans: z
        .array(
          z.looseObject({
            id: z.string(),
            revision: z.number(),
            status: z.string().describe('proposed | approved | rejected | superseded'),
            estTotalCredits: z.number().describe('server-priced; the ceiling this plan approves'),
            decisionId: z.string().nullish().describe('the open question, while `proposed`'),
          }),
        )
        .describe(
          'every revision, OLDEST FIRST — the last entry is the latest, and the approved one ' +
            '(which may not be the latest) is the budget in force.',
        ),
    }),
    async handler(ctx, { projectId }) {
      await ctx.requireProject(projectId)
      const reviewMode = await reviewModeOf(ctx.env, projectId)
      const { plans } = await listPlans(ctx.env, projectId)
      const mode = `review mode ${reviewMode ? 'ON — paid generation needs an approved plan' : 'off'}`
      if (plans.length === 0) {
        return said(
          `${mode}\nno plan yet${reviewMode ? ' — call propose_plan before generating' : ''}`,
          { reviewMode, plans: [] },
        )
      }
      // Non-empty is guaranteed by the early return above.
      const latest = plans[plans.length - 1]!
      const active = plans.find((p) => p.status === 'approved')
      const lines = [mode, formatPlan(latest)]
      if (active && active.id !== latest.id) {
        lines.push(
          `active budget is rev ${active.revision}: ${planRemaining(active)} of ` +
            `${active.estTotalCredits} credits left`,
        )
      }
      if (latest.status === 'proposed') {
        lines.push(`awaiting the human (decision ${latest.decisionId}) — do not generate yet`)
      }
      if (plans.length > 1) {
        lines.push(`${plans.length - 1} earlier revision(s)`)
      }
      return said(lines.join('\n'), { reviewMode, plans })
    },
  }),

  capability({
    name: 'request_review',
    summary: 'Put generated assets in front of the human for approval.',
    doc: [
      'Free. Creates a review the human answers in the editor or in chat — the same decision mechanism ask_user uses, so first answer wins and provenance is recorded. Approval is what unlocks placing the asset (add_image, add_video, import_mesh, add_audio_clip); a rejection carries the note you iterate against.',
      '',
      '**One verdict covers the whole batch**, so group only files that stand or fall together — one asset per review when in doubt.',
      '',
      'The response ends with a ready-to-paste block that links each file. Present it and STOP until they answer; record their answer with record_answer (optionId "approve", or "request_changes" with their feedback as the note). A rejected file stays in the project as history — regenerate with `revises` pointing at it and request review on the new one.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      assetIds: z.array(z.string().min(1)).min(1).max(10),
      note: z.string().max(500).optional().describe('context for the human — what to look for'),
    }),
    async handler(ctx, { projectId, assetIds, note }) {
      await ctx.requireProject(projectId)
      const files: { id: string; path: string; kind: string; bytes: number }[] = []
      for (const id of assetIds) {
        // Ownership, not project membership: a review is about the file, and
        // assets are user-owned with project links (plans/010 phase 4).
        const asset = await requireAsset(ctx.env, id, ctx.userId).catch((e: unknown) => {
          if (e instanceof AccessError) throw new CapabilityError(e.message, e.status)
          throw e
        })
        if (asset.review_status === 'approved') {
          throw new CapabilityError(
            `asset ${id} (${asset.path}) is already approved — place it directly`,
          )
        }
        if (asset.review_status === 'rejected') {
          throw new CapabilityError(
            `asset ${id} (${asset.path}) was already rejected` +
              (asset.review_note ? ` — "${asset.review_note}"` : '') +
              `. Regenerate with revises: "${id}" and request review on the new file instead.`,
          )
        }
        files.push({ id, path: asset.path ?? id, kind: asset.kind, bytes: asset.bytes })
      }

      const lines = files.map(
        (f) => `${f.path} (${f.kind}, ${Math.round(f.bytes / 1024)}KB) — ${ctx.origin}/api/assets/${f.id}`,
      )
      const res = await projectStub(ctx.env, projectId).fetch('https://do/decisions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // The DO caps a question at 400 characters; the full list, with
          // links, is in `detail` either way.
          question: clip(`Review ${files.length} file(s): ${files.map((f) => f.path).join(', ')}`, 400),
          detail: (note ? `${note}\n\n` : '') + lines.join('\n'),
          options: [
            { id: 'approve', label: 'Approve', detail: 'unlocks placing these in the video' },
            {
              id: 'request_changes',
              label: 'Request changes',
              detail: 'add a note saying what to change',
            },
          ],
          refs: { assetIds },
        }),
      })
      if (!res.ok) {
        // The DO says *why* (a schema refusal names the field); dropping that
        // left "could not open the review (400)", which no caller can act on.
        const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string }
        throw new CapabilityError(
          `could not open the review (${res.status}): ${body.error ?? 'unknown'}` +
            (body.detail ? ` — ${body.detail.slice(0, 300)}` : ''),
          502,
        )
      }
      const { decision } = (await res.json()) as { decision: Decision }
      const chat = [
        `Please review ${files.length === 1 ? 'this file' : 'these files'}:`,
        ...lines.map((l) => `  - ${l}`),
        ...(note ? ['', note] : []),
        '',
        'Reply "approve", or tell me what to change.',
      ].join('\n')
      return said(
        [
          'STOP — WAITING ON THE HUMAN.',
          'Present this review in your next reply and wait. Do not place these',
          'assets, and do not choose for them.',
          '',
          '--- paste from here ---',
          chat,
          '--- to here ---',
          '',
          `When they answer, call record_answer(decisionId: "${decision.id}") with`,
          'optionId "approve", or "request_changes" plus their feedback as the note.',
        ].join('\n'),
        { decisionId: decision.id, assetIds },
      )
    },
  }),

  capability({
    name: 'set_review_mode',
    summary: 'Turn the plan/approval gate on or off for a project.',
    doc: [
      'Free. While ON (the default for every project), paid generation must fit a human-approved plan — see propose_plan. OFF removes that gate; nothing else changes.',
      '',
      '**Turning it off is the human\'s call, not yours.** Do it only when they have said so; the gate exists precisely so spending is theirs to authorize.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      enabled: z.boolean().describe('true = generation requires an approved plan'),
    }),
    async handler(ctx, { projectId, enabled }) {
      await ctx.requireProject(projectId)
      await setReviewMode(ctx.env, projectId, enabled)
      return said(
        enabled
          ? 'review mode ON — paid generation now requires an approved plan (propose_plan)'
          : 'review mode off — paid generation is ungated for this project',
        { projectId, reviewMode: enabled },
      )
    },
  }),
]
