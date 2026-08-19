import { z } from 'zod'
import {
  anchorableWords,
  describeMedia,
  clipPlaySec,
  docDuration,
  effectsPastEnd,
  formatOverruns,
  buildAssetTree,
  documentCues,
  op,
  toSRT,
  toVTT,
  LIMITS,
  type AssetFolder,
} from '@euclid/dsl'
import {
  AssetInUse,
  AssetPathTaken,
  deleteAsset,
  listProjectAssets,
  moveAsset,
} from '../services/assets'
import { NarrationError, generateSceneNarration } from '../services/narration'
import { RenderError, listRenderJobs, startRender } from '../services/render'
import { PROJECT_ID, SCENE_ID } from './schemas'
import { capability, said, CapabilityError } from './types'

/** Service errors carry the remedy already; re-throwing keeps it intact. */
function asCapabilityError(e: unknown): never {
  if (e instanceof NarrationError || e instanceof RenderError) {
    const extra = Object.entries(e.extra)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')
    throw new CapabilityError(`${e.message}${extra ? ` (${extra})` : ''}`, e.status)
  }
  throw e
}

/** Random enough for a document id, short enough to read in an outline. */
const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`

export const mediaTools = [
  capability({
    name: 'set_narration',
    summary: "Set a scene's narration script. Free — writes text only.",
    doc: 'Writes the script into the document without synthesizing anything. Free, so iterate on wording here as much as you like. Captions already work from this text alone (estimated timing); call generate_narration when you want real audio and exact word timings.',
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      narrationText: z.string(),
      voiceId: z.string().optional(),
    }),
    async handler(ctx, { projectId, sceneId, narrationText, voiceId }) {
      const { doc } = await ctx.getDoc(projectId)
      ctx.sceneOrThrow(doc, sceneId)
      await ctx.submit(projectId, [op.setNarration(sceneId, { text: narrationText, voiceId })])
      const words = narrationText.trim() ? narrationText.trim().split(/\s+/).length : 0
      return said(`narration set for ${sceneId} (${words} words)`, { sceneId, words })
    },
  }),

  capability({
    name: 'generate_narration',
    summary: 'Synthesize a scene\'s narration to speech. SPENDS CREDITS.',
    doc: [
      '**Costs credits**, priced by script length. Everything else about narration is free — set the text with set_narration and iterate there first.',
      '',
      'Stores the audio as a project asset and writes word-level timings into the document, which makes captions exact and gives you real timings to animate against.',
      '',
      'Reports — but does not reject — speech longer than its scene. That mismatch is only knowable after synthesis, so refusing would bin audio you just paid for. Fix it with fit_scene_to_narration.',
    ].join('\n'),
    costsCredits: true,
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      text: z.string().optional().describe("overrides the scene's existing narration text"),
      voiceId: z.string().optional(),
    }),
    async handler(ctx, { projectId, sceneId, text, voiceId }) {
      const r = await generateSceneNarration(ctx.env, projectId, sceneId, ctx.userId, {
        text,
        voiceId,
      }).catch(asCapabilityError)
      return said(
        `generated narration for ${sceneId}: ${r.durationSec.toFixed(2)}s, ${r.words} words, ` +
          `cost ${r.cost} credits (asset ${r.assetId})` +
          (r.warning ? `\nWARNING: ${r.warning}` : ''),
        r,
      )
    },
  }),

  capability({
    name: 'fit_scene_to_narration',
    summary: 'Set a scene\'s duration to its speech plus a held tail.',
    doc: [
      'Free. The one-call fix for the dead air get_project flags as `(long)`, and for speech that overruns its scene. The tail is deliberate breathing room — pass more for a beat you want to land, less to keep things tight. Requires generated narration, since it needs the real audio duration.',
      '',
      '**Shortening a scene truncates whatever was still running at the old end** — an animation or a camera move past the new end simply never finishes on screen, and every frame still looks plausible, so it is easy to ship. The response names anything this cuts; re-time those effects, or fit again with a longer tail.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      tailSec: z
        .number()
        .min(0)
        .max(10)
        .default(0.8)
        .describe('silence held after the last word'),
    }),
    async handler(ctx, { projectId, sceneId, tailSec }) {
      const { doc } = await ctx.getDoc(projectId)
      const scene = ctx.sceneOrThrow(doc, sceneId)
      const audio = scene.narration?.audio
      if (!audio) {
        throw new CapabilityError(
          `scene ${sceneId} has no generated narration — call generate_narration first ` +
            `(that is the step that produces a real duration to fit to)`,
        )
      }
      const duration = Math.round((audio.durationSec + tailSec) * 100) / 100
      // Read the overruns before submitting: the question is what the *new*
      // duration cuts, and the scene in hand is the one that still has them.
      const cut = effectsPastEnd(scene, duration)
      await ctx.submit(projectId, [op.updateScene(sceneId, { duration })])
      return said(
        `scene ${sceneId}: ${scene.duration}s → ${duration}s ` +
          `(${audio.durationSec.toFixed(2)}s speech + ${tailSec}s tail)` +
          formatOverruns(cut, duration),
        { sceneId, was: scene.duration, duration, speechSec: audio.durationSec, tailSec, cut },
      )
    },
  }),

  capability({
    name: 'get_narration_timing',
    summary: "When each word of a scene's narration is spoken. Free.",
    doc: [
      'Free. Lists the words of a generated narration with the second each begins, which is what `atWord` on write_on and highlight anchors to.',
      '',
      'Repeated words are numbered, so `atWordOccurrence: 2` has something to name. Words are shown stripped of punctuation, which is how they are matched — asking for "equation" finds "equation." — and case is ignored.',
      '',
      '**Requires generated narration.** A script that has only been set with set_narration has no timings yet, because timings come from the synthesis. Anchors written before then are kept and resolve the moment generate_narration runs.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      contains: z
        .string()
        .optional()
        .describe('only words containing this, for finding one in a long script'),
    }),
    async handler(ctx, { projectId, sceneId, contains }) {
      const { doc } = await ctx.getDoc(projectId)
      const scene = ctx.sceneOrThrow(doc, sceneId)
      const words = anchorableWords(scene.narration?.audio?.words)
      if (words.length === 0) {
        throw new CapabilityError(
          `scene ${sceneId} has no generated narration, so there are no word timings. ` +
            `set_narration writes the script; generate_narration is what produces the timings ` +
            `(and costs credits). An anchor written now will resolve as soon as it has.`,
        )
      }
      const needle = contains?.toLowerCase()
      const shown = needle ? words.filter((w) => w.word.includes(needle)) : words
      if (shown.length === 0) {
        return said(
          `no word containing "${contains}" is spoken in ${sceneId}. ` +
            `The script says: ${(scene.narration?.text ?? '').slice(0, 200)}`,
          { words: [] },
        )
      }
      return said(
        shown
          .map(
            (w) =>
              `${w.start.toFixed(2)}s  ${w.word}` +
              (w.occurrence > 1 ? `  (occurrence ${w.occurrence})` : ''),
          )
          .join('\n'),
        { words: shown },
      )
    },
  }),

  capability({
    name: 'get_captions',
    summary: 'SRT/VTT subtitles for the whole project.',
    doc: 'Free — derived from the document, so always current. Cues are word-accurate where TTS timings exist and estimated from text length elsewhere; `format: "json"` marks which is which per cue.',
    args: z.object({
      projectId: PROJECT_ID,
      format: z.enum(['srt', 'vtt', 'json']).default('srt'),
    }),
    async handler(ctx, { projectId, format }) {
      const { doc } = await ctx.getDoc(projectId)
      const cues = documentCues(doc)
      if (cues.length === 0) return said('no narration yet — no cues to emit', { cues: [] })
      const body = format === 'vtt' ? toVTT(cues) : format === 'srt' ? toSRT(cues) : JSON.stringify(cues, null, 2)
      return said(body, { cues, estimated: cues.some((q) => q.estimated) })
    },
  }),

  capability({
    name: 'list_assets',
    summary: "The project's files as a tree, marked in-use or unused.",
    doc: 'Free. Paths are virtual — folders are derived, so there is nothing to mkdir. Each file is marked `[in use]` or `[unused]`, which is what makes a leftover from a regenerated scene visible; those in use are the ones remove_asset refuses to delete.',
    args: z.object({ projectId: PROJECT_ID }),
    async handler(ctx, { projectId }) {
      await ctx.requireProject(projectId)
      const assets = await listProjectAssets(ctx.env, projectId, ctx.userId)
      if (assets.length === 0) return said('no assets in this project', { assets: [] })

      const used = new Map(assets.map((a) => [a.id, a.usedBy]))
      const lines: string[] = []
      const walk = (folder: AssetFolder, depth: number) => {
        const pad = '  '.repeat(depth)
        for (const f of folder.folders) {
          lines.push(`${pad}${f.name}/`)
          walk(f, depth + 1)
        }
        for (const file of folder.files) {
          const kb = `${Math.round(file.bytes / 1024)}KB`
          const media = describeMedia(file)
          const mark = used.get(file.id) ? ' [in use]' : ' [unused]'
          lines.push(`${pad}${file.name}  ${kb}${media ? `  ${media}` : ''}${mark}  ${file.id}`)
        }
      }
      walk(buildAssetTree(assets), 0)
      const unused = assets.filter((a) => !a.usedBy).length
      return said(
        `${assets.length} file(s)${unused ? `, ${unused} unused` : ''}\n${lines.join('\n')}`,
        { assets },
      )
    },
  }),

  capability({
    name: 'move_asset',
    summary: 'Rename or move a file by writing a new virtual path.',
    doc: 'Free. Folders are implicit in the path — they appear when a file names them and disappear when empty, so there is nothing to create or clean up. Paths must stay inside the project (no traversal).',
    args: z.object({
      projectId: PROJECT_ID,
      assetId: z.string().min(1),
      path: z.string().min(1).describe('e.g. /narration/hook.mp3'),
    }),
    async handler(ctx, { projectId, assetId, path }) {
      await ctx.requireProject(projectId)
      try {
        const out = await moveAsset(ctx.env, assetId, path, ctx.userId)
        return said(`moved ${assetId} → ${out.path}`, out)
      } catch (e) {
        if (e instanceof AssetPathTaken) {
          throw new CapabilityError(
            `${e.path} is already used by asset ${e.assetId} — pick another name`,
            409,
          )
        }
        throw new CapabilityError(`could not move ${assetId}: ${(e as Error).message}`)
      }
    },
  }),

  capability({
    name: 'remove_asset',
    summary: 'Delete a file. Refuses if the document still references it.',
    doc: 'Free. A scene must never point at nothing, so a referenced file is refused and the refusal names the scenes. Re-generate or repoint that scene first, or pass `force: true` to delete anyway and accept the broken reference.',
    args: z.object({
      projectId: PROJECT_ID,
      assetId: z.string().min(1),
      force: z.boolean().default(false),
    }),
    async handler(ctx, { projectId, assetId, force }) {
      await ctx.requireProject(projectId)
      try {
        const out = await deleteAsset(ctx.env, assetId, force, ctx.userId)
        return said(
          `deleted ${assetId}${out.wasInUse ? ' (was in use — a scene now points at nothing)' : ''}`,
          out,
        )
      } catch (e) {
        if (e instanceof AssetInUse) {
          throw new CapabilityError(
            `${assetId} is still used by: ${e.scenes.join(', ') || 'the document'}. ` +
              (e.isRenderOutput ? 'A finished render job still serves this file. ' : '') +
              'Re-generate or repoint that scene first, or call again with force: true.',
            409,
          )
        }
        throw new CapabilityError(`could not delete ${assetId}: ${(e as Error).message}`)
      }
    },
  }),

  capability({
    name: 'render_video',
    summary: 'Render the project to MP4. SPENDS CREDITS. Returns a job id.',
    doc: [
      '**Costs credits**, priced per second of video at the project resolution. Narration is billed separately by generate_narration and is not charged again here.',
      '',
      'Returns a job id immediately; the render worker completes it asynchronously. Poll get_render_status for the download URL.',
      '',
      'A failed job refunds its credits automatically, so a failure costs nothing but time.',
    ].join('\n'),
    costsCredits: true,
    args: z.object({ projectId: PROJECT_ID }),
    async handler(ctx, { projectId }) {
      const r = await startRender(ctx.env, projectId, ctx.userId).catch(asCapabilityError)
      return said(
        `queued render ${r.jobId} — ${r.seconds}s of video, ${r.cost} credits. ` +
          `Poll get_render_status for the download URL.`,
        r,
      )
    },
  }),

  capability({
    name: 'get_render_status',
    summary: 'Recent render jobs; a done job carries downloadUrl.',
    doc: [
      'Free. Lists the last 20 jobs newest first, with how long each has been in its current state.',
      'A `done` job carries `downloadUrl` for the MP4; a `failed` job has already had its credits refunded.',
      '',
      '**A job sitting in `queued` means no render worker is running.** `queued` means accepted and priced, not started — a worker has to claim it. The age is shown for exactly this reason: minutes in `queued` with no `rendering` means nothing is draining the queue, and re-submitting will only spend credits again. Report that rather than waiting indefinitely; the document is unaffected and `preview_frames` shows the same frames the render would.',
    ].join('\n'),
    args: z.object({ projectId: PROJECT_ID }),
    async handler(ctx, { projectId }) {
      await ctx.requireProject(projectId)
      const jobs = await listRenderJobs(ctx.env, projectId, ctx.origin)
      if (jobs.length === 0) return said('no render jobs yet', { jobs: [] })
      const now = Date.now()
      const age = (ms: number) => {
        const s = Math.max(0, Math.round((now - ms) / 1000))
        return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`
      }
      // A queued job that nothing is draining is indistinguishable from a busy
      // one without this: run 5 waited ten minutes and then had to guess.
      const stalled = jobs.filter((j) => j.status === 'queued' && now - j.created_at > 120_000)
      return said(
        jobs
          .map(
            (j) =>
              `${j.id}  ${j.status.padEnd(9)} ${j.cost} credits  ${age(j.created_at)} old` +
              (j.downloadUrl ? `  ${j.downloadUrl}` : ''),
          )
          .join('\n') +
          (stalled.length
            ? `\n\n${stalled.length} job(s) have been queued for minutes without starting — ` +
              `no render worker is claiming them, which is not the same as busy. ` +
              `Re-submitting would spend credits again for the same result. The document ` +
              `is unaffected, and preview_frames shows the same frames the render would.`
            : ''),
        { jobs },
      )
    },
  }),

  capability({
    name: 'add_audio_track',
    summary: 'Add a music or effects lane to the video. Free.',
    doc: [
      'Audio tracks are **document-level**: a clip is placed in global time and plays across cuts, which is what a music bed is for. Narration stays scene-scoped and is not managed here.',
      '',
      'Muting a track is part of the document and therefore part of the export — an agent muting a lane is choosing what the render contains.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      name: z.string().describe('what the lane is called on the timeline'),
      kind: z.enum(['music', 'sfx', 'voice']).default('music'),
      gain: z.number().min(0).max(1).optional().describe('lane level, 0–1 (attenuation only)'),
    }),
    async handler(ctx, { projectId, name, kind, gain }) {
      const { doc } = await ctx.getDoc(projectId)
      if ((doc.audio?.length ?? 0) >= LIMITS.maxAudioTracks) {
        throw new CapabilityError(`a project may hold ${LIMITS.maxAudioTracks} audio tracks`, 400)
      }
      const track = { id: rid('track'), name, kind, gain, clips: [] }
      await ctx.submit(projectId, [op.addAudioTrack(track)])
      return said(`added audio track "${name}" (${track.id})`, { trackId: track.id })
    },
  }),

  capability({
    name: 'add_audio_clip',
    summary: 'Place an audio asset on a track at a given second. Free.',
    doc: [
      'Places an existing asset — generated with generate_music, uploaded, or already in the project — on an audio track. `list_assets` is where the assetId comes from.',
      '',
      "The clip's length is read from the asset registry. A file stored without a duration cannot be measured server-side without decoding it, so pass `durationSec` yourself in that case; the error says so.",
      '',
      'A clip is cut at the end of the video, exactly as narration is cut at the end of its scene: audio past the last frame is silence nobody hears.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      trackId: z.string(),
      assetId: z.string(),
      startSec: z.number().min(0).default(0).describe('where it starts on the global timeline'),
      durationSec: z.number().positive().optional().describe("only needed when the asset has no recorded length"),
      sourceInSec: z.number().min(0).optional().describe('trim from the head of the file'),
      playSec: z.number().positive().optional().describe('how much to play; default is the rest of it'),
      gain: z.number().min(0).max(1).optional(),
      fadeInSec: z.number().min(0).optional(),
      fadeOutSec: z.number().min(0).optional(),
      name: z.string().optional(),
    }),
    async handler(ctx, args) {
      const { doc } = await ctx.getDoc(args.projectId)
      const track = doc.audio?.find((t) => t.id === args.trackId)
      if (!track) {
        const known = (doc.audio ?? []).map((t) => t.id).join(', ') || 'none yet'
        throw new CapabilityError(`no audio track ${args.trackId} (have: ${known})`, 404)
      }
      const assets = await listProjectAssets(ctx.env, args.projectId, ctx.userId)
      const asset = assets.find((a) => a.id === args.assetId)
      if (!asset) throw new CapabilityError(`no asset ${args.assetId} in this project`, 404)
      const durationSec = args.durationSec ?? asset.durationSec ?? 0
      if (!durationSec) {
        throw new CapabilityError(
          `asset ${args.assetId} (${asset.path}) has no recorded duration — pass durationSec`,
          400,
        )
      }
      const clip = {
        id: rid('clip'),
        assetId: args.assetId,
        startSec: args.startSec,
        durationSec,
        sourceInSec: args.sourceInSec,
        playSec: args.playSec,
        gain: args.gain,
        fadeInSec: args.fadeInSec,
        fadeOutSec: args.fadeOutSec,
        name: args.name ?? asset.path.slice(asset.path.lastIndexOf('/') + 1),
      }
      await ctx.submit(args.projectId, [op.addAudioClip(track.id, clip)])
      // Say what it will actually do, not what was asked for: the difference
      // between the two is the clip running past the end of the video.
      const total = docDuration(doc)
      const plays = Math.min(clipPlaySec(clip), Math.max(0, total - clip.startSec))
      const cut = plays < clipPlaySec(clip) ? ` (cut at the end of the video, ${total}s)` : ''
      return said(
        `placed ${clip.name} on "${track.name}" at ${clip.startSec}s for ${plays.toFixed(2)}s${cut}`,
        { clipId: clip.id, trackId: track.id, playSec: plays },
      )
    },
  }),

  capability({
    name: 'update_audio',
    summary: 'Re-time, re-level, mute or remove an audio clip or track. Free.',
    doc: [
      'One verb for every edit to an existing lane or clip, because they are the same act: deciding what the mix contains.',
      '',
      'Pass `clipId` to change a clip, or only `trackId` to change the lane itself. `remove: true` deletes whichever you addressed — a track takes its clips with it.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      trackId: z.string(),
      clipId: z.string().optional(),
      remove: z.boolean().optional(),
      startSec: z.number().min(0).optional(),
      sourceInSec: z.number().min(0).optional(),
      playSec: z.number().positive().optional(),
      gain: z.number().min(0).max(1).optional(),
      fadeInSec: z.number().min(0).optional(),
      fadeOutSec: z.number().min(0).optional(),
      muted: z.boolean().optional().describe('track only — and it changes the export'),
      name: z.string().optional(),
    }),
    async handler(ctx, args) {
      const { projectId, trackId, clipId, remove, muted, ...rest } = args
      const { doc } = await ctx.getDoc(projectId)
      const track = doc.audio?.find((t) => t.id === trackId)
      if (!track) throw new CapabilityError(`no audio track ${trackId}`, 404)

      if (remove) {
        if (clipId) {
          await ctx.submit(projectId, [op.removeAudioClip(trackId, clipId)])
          return said(`removed clip ${clipId} from "${track.name}"`, { trackId, clipId })
        }
        await ctx.submit(projectId, [op.removeAudioTrack(trackId)])
        return said(`removed track "${track.name}" and its ${track.clips.length} clip(s)`, { trackId })
      }

      if (clipId) {
        if (!track.clips.some((c) => c.id === clipId)) {
          throw new CapabilityError(`no clip ${clipId} on track ${trackId}`, 404)
        }
        const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined))
        if (Object.keys(patch).length === 0) throw new CapabilityError('nothing to change', 400)
        await ctx.submit(projectId, [op.updateAudioClip(trackId, clipId, patch)])
        return said(`updated clip ${clipId}: ${Object.keys(patch).join(', ')}`, { trackId, clipId })
      }

      const patch: Record<string, unknown> = {}
      if (muted !== undefined) patch.muted = muted
      if (rest.gain !== undefined) patch.gain = rest.gain
      if (rest.name !== undefined) patch.name = rest.name
      if (Object.keys(patch).length === 0) throw new CapabilityError('nothing to change', 400)
      await ctx.submit(projectId, [op.updateAudioTrack(trackId, patch)])
      return said(
        `updated track "${track.name}": ${Object.keys(patch).join(', ')}` +
          (patch.muted === true ? ' — this lane is now silent in the export' : ''),
        { trackId },
      )
    },
  }),
]
