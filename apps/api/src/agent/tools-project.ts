import { z } from 'zod'
import {
  CANVAS_PRESETS,
  LIMITS,
  effectsPastEnd,
  formatOverruns,
  newId,
  op,
  outlineDoc,
} from '@euclid/dsl'
import { createProject, deleteProject, listProjects, projectContents } from '../services/projects'
import { projectStub } from '../shared'
import { reviewModeOf } from '../services/plan'
import { PROJECT_ID, SCENE_ID, COLOR } from './schemas'
import { capability, said, CapabilityError } from './types'

/**
 * An envelope's op kinds as one readable phrase.
 *
 * Counted rather than listed: a single envelope can carry up to 50 ops, and a
 * history line reading `node.add, node.add, node.add, …` says less than
 * `3x node.add` does in a quarter of the width.
 */
function summariseKinds(kinds: string[]): string {
  const counts = new Map<string, number>()
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1)
  return [...counts]
    .map(([k, n]) => (n > 1 ? `${n}x ${k}` : k))
    .join(', ')
}

export const projectTools = [
  capability({
    name: 'list_projects',
    summary: 'List your video projects (id, name, created).',
    doc: 'Returns every project you own, newest first. Free. The id is what every other capability takes as `projectId`.',
    args: z.object({}),
    async handler(ctx) {
      const projects = await listProjects(ctx.env, ctx.userId)
      if (projects.length === 0) {
        return said('no projects yet — call create_project to start one', { projects: [] })
      }
      return said(
        projects.map((p) => `${p.id}  "${p.name}"`).join('\n'),
        { projects },
      )
    },
  }),

  capability({
    name: 'create_project',
    summary: 'Create a new video project. Pick a shape — landscape, portrait, square.',
    doc: [
      'Creates an empty project and its document. Free. Returns the project id — hold on to it; every other capability needs it. Add scenes with add_scene before adding any nodes.',
      '',
      '**The shape is a decision, and it is easier to make now than later.** Coordinates are canvas pixels, so a layout built for 1920x1080 does not survive being reshaped to 1080x1920 — every node would need moving.',
      '',
      Object.entries(CANVAS_PRESETS)
        .map(([k, v]) => `- \`${k}\` — ${v.width}x${v.height}, ${v.note}`)
        .join('\n'),
      '',
      'They all cost the same to render: the ceiling is a **pixel budget**, not a resolution, so any arrangement within it is equally cheap. `width`/`height` override the preset for anything unusual — both must be even, since H.264 cannot encode an odd size.',
    ].join('\n'),
    args: z.object({
      name: z.string().min(1),
      shape: z.enum(['landscape', 'portrait', 'square', 'vertical_4_5']).default('landscape'),
      width: z.number().int().optional().describe('overrides the preset'),
      height: z.number().int().optional().describe('overrides the preset'),
      fps: z.union([z.literal(30), z.literal(60)]).default(60),
    }),
    async handler(ctx, { name, shape, width, height, fps }) {
      if (!name.trim()) throw new CapabilityError('name cannot be blank')
      const preset = CANVAS_PRESETS[shape]
      const canvas = { width: width ?? preset.width, height: height ?? preset.height, fps }
      // Checked here so the refusal names the argument, rather than surfacing
      // as a document-validation error from two layers down.
      if (canvas.width % 2 !== 0 || canvas.height % 2 !== 0) {
        throw new CapabilityError(
          `${canvas.width}x${canvas.height} has an odd dimension; H.264 cannot encode one. ` +
            `Round both to even numbers.`,
        )
      }
      if (canvas.width * canvas.height > LIMITS.maxCanvasPixels) {
        throw new CapabilityError(
          `${canvas.width}x${canvas.height} is ${((canvas.width * canvas.height) / 1e6).toFixed(1)}M ` +
            `pixels, over the ${(LIMITS.maxCanvasPixels / 1e6).toFixed(1)}M budget. Any shape fits ` +
            `within it — 1920x1080, 1080x1920 and 1440x1440 all cost the same.`,
        )
      }
      const project = await createProject(ctx.env, name, ctx.userId, canvas)
      return said(
        `created project ${project.id} "${project.name}" — ${canvas.width}x${canvas.height} @ ${fps}fps ` +
          `(centre is ${canvas.width / 2}, ${canvas.height / 2})`,
        { ...project, canvas },
      )
    },
  }),

  capability({
    name: 'delete_project',
    summary: 'Delete a project and everything it owns. IRREVERSIBLE — needs confirm: true.',
    doc: [
      'Free, and **permanent**. Removes the document, every scene, all narration audio and render outputs, and the event log itself. `revert_to_version` cannot help here — it replays that log, and this destroys it. Nothing brings any of it back.',
      '',
      'Called without `confirm: true` it deletes nothing and instead reports what the project holds — scenes, duration, assets, renders. Read that back before confirming; a project that took credits to narrate and render cannot be recreated by re-running anything.',
      '',
      'If you are tidying up after yourself, delete only projects you created in this session. When in doubt about whose work a project is, ask_user instead of guessing.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      confirm: z
        .boolean()
        .default(false)
        .describe('must be true to actually delete; false reports what would be lost'),
    }),
    async handler(ctx, { projectId, confirm }) {
      await ctx.requireProject(projectId)
      const contents = await projectContents(ctx.env, projectId)
      const holds =
        `"${contents.name}" holds ${contents.scenes} scene(s), ` +
        `${contents.durationSec.toFixed(1)}s, ${contents.assets} asset(s), ` +
        `${contents.renders} render(s)`
      if (!confirm) {
        return said(
          `NOT DELETED — ${holds}. This is permanent, and the one thing revert_to_version cannot undo. ` +
            `Call again with confirm: true if that is really what you want.`,
          { ...contents, deleted: false },
        )
      }
      const gone = await deleteProject(ctx.env, projectId, ctx.userId)
      return said(`deleted ${holds}, and ${gone.objectsDeleted} stored file(s)`, {
        ...gone,
        deleted: true,
      })
    },
  }),

  capability({
    name: 'get_project',
    summary: 'Compact outline of a project: scenes, timings, nodes, animations, pacing.',
    doc: [
      'The cheap read — call it freely while iterating, it costs nothing.',
      '',
      'Includes pacing: total silence as a percentage, and per scene `speech=`/`tail=`.',
      'A tail over 2s is marked `(long)` — that is dead air, and fit_scene_to_narration is the one-call fix.',
      '',
      'This is an outline, not the document. For a scene\'s exact keyframes and transitions, use get_scene.',
    ].join('\n'),
    args: z.object({ projectId: PROJECT_ID }),
    // `doc` is named rather than enumerated on purpose. It is the document as
    // @euclid/dsl defines it, and inlining that (recursive) schema into every
    // describe would cost more than it teaches — a pointer to the contract
    // that actually governs it stays true when the DSL moves.
    result: z.object({
      doc: z
        .unknown()
        .describe(
          'the full EuclidDoc — canvas, scenes[], each with nodes[]/tracks/transitions/narration. ' +
            'The text is an OUTLINE of this; the data is the whole thing.',
        ),
      reviewMode: z.boolean().describe('true while paid generation needs an approved plan'),
    }),
    async handler(ctx, { projectId }) {
      const { doc } = await ctx.getDoc(projectId)
      // Stated on the cheap read too, not only in orientation: an agent that
      // joined mid-thread should meet the gate before its first refused call.
      const gated = await reviewModeOf(ctx.env, projectId)
      const banner = gated
        ? 'review mode ON — paid generation needs an approved plan (get_plan / propose_plan)\n'
        : ''
      return said(banner + outlineDoc(doc), { doc, reviewMode: gated })
    },
  }),

  capability({
    name: 'get_history',
    summary: 'Every version of this project and what changed — what revert_to_version can go back to.',
    doc: [
      'Free. Every edit any writer has made, newest last: version number, who made it, and which ops it carried. This is the list `revert_to_version` takes a number from.',
      '',
      '`historyFrom` is where restorable history begins. For a project created since versioning landed that is 0 — the empty document. A project that predates it has no snapshot of its original state (a canvas arrives when the project is created, not as an op, so it cannot be reconstructed from the log), and its history starts at whatever version it was on when it was next edited. Everything before that is listed but not restorable.',
      '',
      'A revert appears here like any other edit, marked with the version it restored. Going back does not erase anything — the version only ever goes up, so a revert can itself be reverted.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      limit: z.number().int().min(1).max(200).default(40).describe('most recent N'),
    }),
    result: z.object({
      version: z.number().describe('what the project is at now'),
      historyFrom: z
        .number()
        .nullable()
        .describe('lowest restorable version; null means no snapshot exists yet'),
      entries: z
        .array(
          z.object({
            version: z.number(),
            at: z.number().describe('epoch ms'),
            actor: z.object({ type: z.string(), id: z.string().optional() }),
            kinds: z.array(z.string()).describe('op kinds this version carried'),
            restoredFrom: z
              .number()
              .optional()
              .describe('present when this version was itself a revert'),
          }),
        )
        .describe('oldest first, truncated to `limit` from the END (most recent)'),
    }),
    async handler(ctx, { projectId, limit }) {
      await ctx.requireProject(projectId)
      const res = await projectStub(ctx.env, projectId).fetch('https://do/history')
      if (!res.ok) throw new CapabilityError(`history unavailable: ${await res.text()}`, 502)
      const { version, historyFrom, entries } = (await res.json()) as {
        version: number
        historyFrom: number | null
        entries: {
          version: number
          at: number
          actor: { type: string; id?: string }
          kinds: string[]
          restoredFrom?: number
        }[]
      }
      const shown = entries.slice(-limit)
      const lines = shown.map((e) => {
        const what = e.restoredFrom !== undefined
          ? `reverted to version ${e.restoredFrom}`
          : summariseKinds(e.kinds)
        const restorable = historyFrom !== null && e.version >= historyFrom
        return (
          `  v${e.version}${restorable ? '' : ' (not restorable)'} by ${e.actor.type} — ${what}`
        )
      })
      return said(
        `project ${projectId} is at version ${version}, ${entries.length} edit(s) recorded` +
          (shown.length < entries.length ? `, showing the last ${shown.length}` : '') +
          (historyFrom === null
            ? '\n  no restorable history yet — make one edit and it starts from there'
            : historyFrom > 0
              ? `\n  restorable from v${historyFrom} (this project predates version history)`
              : '') +
          `\n${lines.join('\n')}\n` +
          (historyFrom === null
            ? `Nothing here can be restored yet — the snapshot revert replays from is written on ` +
              `the next edit, and history runs from there.`
            : `Go back with revert_to_version. The revert is itself a new version, so nothing is lost.`),
        { version, historyFrom, entries: shown },
      )
    },
  }),

  capability({
    name: 'revert_to_version',
    summary: 'Put the document back to an earlier version. The revert is itself a new version.',
    doc: [
      'Free, and **not destructive**: reverting appends rather than rewinds, so the version goes UP and everything you reverted away from is still in the history. A revert can be reverted.',
      '',
      'This is the cheap way out of a wrong turn. Rebuilding a scene by hand costs dozens of calls and loses every transition bound to the node ids you delete; this is one call, and the document comes back exactly as it was — ids, tracks, transitions and all.',
      '',
      'Call `get_history` for the version numbers. `version` is the state you want *back*, not the number of steps to undo: reverting to v12 from v20 makes v21 identical to v12.',
      '',
      'Every open editor sees it immediately — it broadcasts on the same channel as any other edit, so nobody is left looking at a document that no longer exists.',
      '',
      '**It restores the document, not the world around it.** Assets, credits already spent, render jobs and the review plan are not part of the document and do not move. Reverting past the point where a generated image was placed removes the node, not the file — the asset is still in the project, and `add_image` will put it back without paying again.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      version: z.number().int().min(0).describe('the version to restore, from get_history'),
    }),
    async handler(ctx, { projectId, version }) {
      await ctx.requireProject(projectId)
      const res = await projectStub(ctx.env, projectId).fetch('https://do/revert', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version, actor: { type: 'agent', id: ctx.userId } }),
      })
      if (!res.ok) {
        const { detail, error } = (await res.json().catch(() => ({}))) as {
          detail?: string
          error?: string
        }
        // The DO's refusals already name the remedy (the valid range, where
        // history starts, why a replay cannot be trusted) — passing them
        // through beats restating them worse.
        throw new CapabilityError(
          `${detail ?? error ?? 'revert failed'} Call get_history for what is available.`,
          res.status === 422 ? 422 : 400,
        )
      }
      const { version: now, wasVersion } = (await res.json()) as {
        version: number
        wasVersion: number
      }
      const { doc } = await ctx.getDoc(projectId)
      return said(
        `restored version ${version} — the project was at v${wasVersion} and is now at v${now}, ` +
          `whose document is identical to v${version}. Nothing was destroyed: v${wasVersion} is ` +
          `still in the history, so revert_to_version ${wasVersion} undoes this.\n` +
          outlineDoc(doc),
        { version: now, restoredFrom: version, wasVersion, doc },
      )
    },
  }),

  capability({
    name: 'get_scene',
    summary: 'Full JSON of one scene, for detailed inspection.',
    doc: 'Everything in the scene — nodes, tracks, transitions, narration — as JSON. Free, but far larger than get_project: reach for it when an outline is not enough to explain what you are seeing.',
    args: z.object({ projectId: PROJECT_ID, sceneId: SCENE_ID }),
    result: z.object({
      scene: z
        .unknown()
        .describe(
          'one EuclidDoc scene: id, name, duration, nodes[], transitions[], narration, camera. ' +
            'Here the text and the data are the same JSON — this is the one capability where ' +
            'reading `text` and parsing it yourself is not wrong, only wasteful.',
        ),
    }),
    async handler(ctx, { projectId, sceneId }) {
      const { doc } = await ctx.getDoc(projectId)
      const scene = ctx.sceneOrThrow(doc, sceneId)
      return said(JSON.stringify(scene, null, 2), { scene })
    },
  }),

  capability({
    name: 'add_scene',
    summary: 'Append a scene (name, duration, background).',
    doc: 'Appends to the end of the timeline; scenes play in sequence. Scene time starts at 0 — every `start` you pass later is scene-local, not global. Coordinates are canvas pixels, origin top-left, and a 1920x1080 canvas centres at (960, 540).',
    args: z.object({
      projectId: PROJECT_ID,
      name: z.string().min(1),
      duration: z.number().positive().describe('seconds'),
      background: COLOR.default('#101418'),
    }),
    async handler(ctx, { projectId, name, duration, background }) {
      const id = newId('sc')
      await ctx.submit(projectId, [op.addScene({ id, name, duration, background, nodes: [] })])
      return said(`created scene ${id} "${name}" (${duration}s)`, { sceneId: id })
    },
  }),

  capability({
    name: 'update_scene',
    summary: "Patch a scene's name, duration or background.",
    doc: 'Extending `duration` is the usual fix when generate_narration reports that speech overruns the scene. Shortening a scene does not delete anything — nodes and keyframes past the new end simply stop being reached, which means an animation still running at the old end is silently truncated and every frame still looks plausible. The response names anything a shorter duration cuts.',
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      name: z.string().min(1).optional(),
      duration: z.number().positive().optional().describe('seconds'),
      background: COLOR.optional(),
    }),
    async handler(ctx, { projectId, sceneId, name, duration, background }) {
      const patch = Object.fromEntries(
        Object.entries({ name, duration, background }).filter(([, v]) => v !== undefined),
      )
      if (Object.keys(patch).length === 0) {
        throw new CapabilityError('nothing to update — pass at least one of name, duration, background')
      }
      const { doc } = await ctx.getDoc(projectId)
      const scene = ctx.sceneOrThrow(doc, sceneId)
      // Only a shorter scene can orphan anything; a longer one just adds air.
      const cut =
        duration !== undefined && duration < scene.duration
          ? effectsPastEnd(scene, duration)
          : []
      await ctx.submit(projectId, [op.updateScene(sceneId, patch)])
      return said(
        `updated scene ${sceneId}: ${JSON.stringify(patch)}` +
          (duration !== undefined ? formatOverruns(cut, duration) : ''),
        { sceneId, patch, cut },
      )
    },
  }),
]
