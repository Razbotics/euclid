import { z } from 'zod'
import { formatMoments, keyMoments, type EuclidDoc, type KeyMoment } from '@euclid/dsl'
import { PROJECT_ID } from './schemas'
import { capability, CapabilityError, type CapabilityResult } from './types'
import type { Env } from '../env'

/** Default for local dev; production points this at the render backend. */
const DEFAULT_PREVIEW_ORIGIN = 'http://localhost:8790'

/**
 * Hard cap on tiles.
 *
 * Images are the most context-expensive thing a tool can return, and a tool
 * that is cheap to call and returns pictures gets called reflexively. Twelve
 * tiles at 480px is about 1.1k tokens; the same frames read individually would
 * be roughly 15k. The cap is what keeps the first number true.
 */
const MAX_TILES = 16

async function capture(
  env: Env,
  path: '/preview' | '/frame',
  body: unknown,
): Promise<{ base64: string; bytes: number; ink: number[] }> {
  const origin = env.PREVIEW_ORIGIN ?? DEFAULT_PREVIEW_ORIGIN
  let res: Response
  try {
    res = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': env.INTERNAL_API_KEY },
      body: JSON.stringify(body),
    })
  } catch (e) {
    throw new CapabilityError(
      `the preview backend at ${origin} is not reachable (${(e as Error).message}). ` +
        `It renders the frames, and nothing else can: start the render backend ` +
        `with \`pnpm --filter @euclid/renderer exec tsx src/render-worker.ts\` ` +
        `(it serves preview and drains the render queue), or point PREVIEW_ORIGIN ` +
        `at a running one.`,
      503,
    )
  }
  if (!res.ok) throw new CapabilityError(`preview capture failed: ${await res.text()}`, 502)

  let ink: number[] = []
  try {
    ink = JSON.parse(res.headers.get('x-preview-ink') ?? '[]') as number[]
  } catch {
    // A backend that does not report ink is usable; it just cannot warn.
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  let binary = ''
  for (let i = 0; i < buf.length; i += 8192) {
    binary += String.fromCharCode(...buf.subarray(i, i + 8192))
  }
  return { base64: btoa(binary), bytes: buf.length, ink }
}

export const previewTools = [
  capability({
    name: 'preview_frames',
    summary: 'See the video: one labeled contact sheet of the moments that matter. Free.',
    doc: [
      '**Free, and the only way you can see what you are making.** Every other capability reports on the *document*; this one shows the picture. Use it while building, not once at the end — it costs nothing and takes a second or two, where a render costs credits and minutes.',
      '',
      'With no arguments it captures the moments the document says matter: each scene opening (where static layout errors live — two nodes overlapping, a label off-centre), each morph sampled across its span, each highlight at full strength, each write mid-reveal. Pass `at` to capture exact times instead (global seconds).',
      '',
      'You get **one image**, tiled and labeled `[index] time  what`. Read the tiles; if one looks wrong, call again with `full` set to that index for the frame at full resolution.',
      '',
      'These are real export frames, not an approximation — the same renderer, so what you see is what the MP4 will contain.',
      '',
      '**Stills mislead about motion.** A mid-morph frame can look catastrophic and still be a fine half-second in motion. Sampling a morph at 25/50/75% shows the trajectory, but if you draw a conclusion from frames, say that it came from frames.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      at: z
        .array(z.number().min(0))
        .max(MAX_TILES)
        .optional()
        .describe('exact global seconds; defaults to the document key moments'),
      columns: z.number().int().min(1).max(6).default(4),
      full: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('drill into one tile by its [index], at full resolution'),
      max: z
        .number()
        .int()
        .min(1)
        .max(MAX_TILES)
        .default(12)
        .describe('cap on tiles when using key moments'),
    }),
    async handler(ctx, { projectId, at, columns, full, max }): Promise<CapabilityResult> {
      const { doc } = await ctx.getDoc(projectId)
      if (doc.scenes.length === 0) {
        throw new CapabilityError(
          `project ${projectId} has no scenes yet — there is nothing to see. Add one with add_scene.`,
        )
      }

      const moments: KeyMoment[] = at?.length ? [] : keyMoments(doc, { max })
      const tiles = at?.length
        ? at.map((t) => ({ t, label: 'requested' }))
        : moments.map((m) => ({ t: m.t, label: `${m.kind} ${m.label}` }))

      if (tiles.length === 0) {
        throw new CapabilityError('no moments to capture — pass `at` with explicit times')
      }

      if (full !== undefined) {
        const tile = tiles[full]
        if (!tile) {
          throw new CapabilityError(
            `full: ${full} is out of range — this sheet has tiles 0..${tiles.length - 1}`,
          )
        }
        const image = await capture(ctx.env, '/frame', { doc: doc as EuclidDoc, t: tile.t })
        return {
          text:
            `full-resolution frame at t=${tile.t.toFixed(2)}s (${tile.label}), ` +
            `${doc.canvas.width}x${doc.canvas.height}`,
          data: { t: tile.t, label: tile.label, bytes: image.bytes },
          image: { base64: image.base64, mimeType: 'image/png' },
        }
      }

      const image = await capture(ctx.env, '/preview', {
        doc: doc as EuclidDoc,
        tiles,
        columns,
      })
      // A capture failure and a legitimately dark frame both come back as a
      // valid PNG of the right size. Telling them apart is the backend's job
      // (it has the pixels); saying so is this one's, because handing an agent
      // a black image without comment invites it to conclude the *video* is
      // broken.
      const blank = image.ink.map((v, i) => ({ v, i })).filter((x) => x.v < 0.0002)
      if (image.ink.length > 0 && blank.length === image.ink.length) {
        throw new CapabilityError(
          `every frame came back empty, which is a capture fault rather than a verdict on ` +
            `the video — do not conclude anything about the project from it. The preview ` +
            `backend rendered ${tiles.length} frame(s) and all were blank.`,
          502,
        )
      }

      const listing = at?.length
        ? tiles.map((t, i) => `[${i}] t=${t.t.toFixed(2)}s`).join('\n')
        : formatMoments(moments)
      const emptyNote = blank.length
        ? `\n\nTile(s) ${blank.map((b) => `[${b.i}]`).join(' ')} are empty. That is ` +
          `normal before a write-on begins or after a node is removed, but if you expected ` +
          `something there, check the node's timing.`
        : ''
      return {
        text:
          `${tiles.length} frame(s) of "${doc.name}", ${columns} per row, ` +
          `labeled [index] in the image:\n${listing}\n\n` +
          `These are real export frames. If a tile looks wrong, call again with ` +
          `full: <index> for that frame at full resolution. Remember stills cannot ` +
          `show motion — a mid-morph frame always looks worse than it plays.` +
          emptyNote,
        data: { tiles, moments, bytes: image.bytes, ink: image.ink },
        image: { base64: image.base64, mimeType: 'image/png' },
      }
    },
  }),
]
