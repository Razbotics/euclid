import { z } from 'zod'
import { LIMITS } from '@euclid/dsl'
import { capability, CapabilityError, type CapabilityResult } from './types'

const BATCH = 'execute_batch'

export const batchTools = [
  capability({
    name: BATCH,
    summary: 'Run several free capabilities in order, in one round trip. Stops at the first error.',
    doc: [
      'One call carrying a list of calls. `calls` is `[{name, args}, …]`, each exactly what you would pass to a single `execute`, and they run **in the order given** — so a later call sees what an earlier one changed.',
      '',
      `**It saves round trips, not work.** Every call runs through the same executor, the same validation and the same handlers as a single \`execute\`, and each still reads the document and submits its own edit — measured side by side, twelve calls take the same time either way. What collapses is the number of times you stop and wait for an answer: twelve turns become one. Building a single scene took roughly a dozen calls and three scenes about forty. Up to ${LIMITS.maxBatchCalls} calls.`,
      '',
      '**It is NOT a transaction.** Each call reads the document and submits its own edit — that is exactly what lets call 5 see call 4\'s work — so a failure partway leaves everything before it applied. The response says which calls ran, and a wrong turn is one call to undo: `get_history` then `revert_to_version`.',
      '',
      '**Every argument must already be known.** A batch returns once, at the end, so an id produced *inside* it is not available to a later call in the same batch — you cannot write a `sceneId` you have not been told yet. Create the scene in one call, then populate it with a batch. That is still three scenes in six calls rather than forty.',
      '',
      '**Free capabilities only.** Anything that spends credits is refused here, before any call runs, and belongs in `execute_paid` one at a time — the paid door is separate so that approving free edits can never approve a charge, and a batch that could reach it would be a way around that. `execute_batch` also cannot contain itself.',
      '',
      'Errors are unchanged: the failing call reports exactly what it would have reported on its own, with its position in the list, so a batch is never a worse teacher than the calls inside it.',
    ].join('\n'),
    args: z.object({
      calls: z
        .array(
          z.object({
            name: z.string().min(1).describe('capability name, as for execute'),
            args: z.record(z.string(), z.any()).default({}),
          }),
        )
        .min(1)
        .max(LIMITS.maxBatchCalls)
        .describe('run in this order; a later call sees earlier calls\' changes'),
    }),
    result: z.object({
      ran: z.number().describe('how many calls completed'),
      failed: z
        .number()
        .nullable()
        .describe('0-based index of the call that failed, or null if all ran'),
      results: z
        .array(z.object({ name: z.string(), text: z.string(), data: z.unknown() }))
        .describe('one entry per call that COMPLETED, in order — not per call submitted'),
      error: z.string().nullable().describe('the failing call\'s message, verbatim'),
    }),
    async handler(ctx, { calls }) {
      // Structural checks over the WHOLE list before anything runs. A paid or
      // misspelled name found halfway through would mean refusing after having
      // already changed the document, and for the paid case that is worse than
      // useless: the refusal is the feature.
      for (const [i, c] of calls.entries()) {
        if (c.name === BATCH) {
          throw new CapabilityError(
            `call [${i}] is ${BATCH} — a batch cannot contain itself. Put its calls in this list.`,
          )
        }
        const info = ctx.capabilityInfo(c.name)
        if (!info.exists) {
          throw new CapabilityError(
            `call [${i}] names "${c.name}", which is not a capability. Nothing was run — ` +
              `check the list against instructions and send it again.`,
            404,
            'unknown_capability',
          )
        }
        if (info.costsCredits) {
          throw new CapabilityError(
            `call [${i}] is ${c.name}, which spends credits, and a batch runs only free ` +
              `capabilities. Nothing was run. Take it out and call it on its own through ` +
              `execute_paid — the split exists so approving free edits can never approve a charge.`,
            403,
            'wrong_executor',
          )
        }
      }

      const results: { name: string; text: string; data: unknown }[] = []
      // Only one image can travel back, so the last one wins — a batch that
      // ends in preview_frames is the shape this is for ("do these, then let
      // me look"), and an earlier picture is of a document that no longer
      // exists by the time the batch returns.
      let image: CapabilityResult['image']
      let imageFrom = -1

      for (const [i, c] of calls.entries()) {
        try {
          const out = await ctx.runCapability(c.name, c.args)
          results.push({ name: out.name, text: out.text, data: out.data })
          if (out.image) {
            image = out.image
            imageFrom = i
          }
        } catch (e) {
          if (!(e instanceof CapabilityError)) throw e
          // The failing call's own message, verbatim and in full. A batch that
          // summarised it would be a worse teacher than the same call made
          // alone, which would defeat the point of having one executor.
          const done = results.length
            ? `Calls [0..${results.length - 1}] ran and are still applied:\n` +
              results.map((r, n) => `  [${n}] ${r.name}: ${firstLine(r.text)}`).join('\n') +
              `\nThey are not rolled back — a batch is not a transaction. ` +
              `get_history and revert_to_version undo them in one call if you want to start over.`
            : 'Nothing ran.'
          throw new CapabilityError(
            `call [${i}] ${c.name} failed, and the batch stopped there.\n\n${e.message}\n\n${done}`,
            e.status,
            e.kind,
          )
        }
      }

      return {
        data: { ran: results.length, failed: null, results, error: null },
        text:
          `${results.length} call(s) ran:\n` +
          results.map((r, n) => `  [${n}] ${r.name}: ${firstLine(r.text)}`).join('\n') +
          (imageFrom >= 0 ? `\nThe image is from call [${imageFrom}].` : ''),
        ...(image ? { image } : {}),
      }
    },
  }),
]

/**
 * One line per call in the summary.
 *
 * A batch of forty full responses is longer than the forty replies it replaced,
 * which would make the tool cost what it was built to save. The first line is
 * the part that carries the id and the outcome; anything a call needed to warn
 * about at length is still worth its own `execute`.
 */
function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}
