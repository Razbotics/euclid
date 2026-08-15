import { z } from 'zod'
import { newId, op, outlineDoc } from '@euclid/dsl'
import { createProject, deleteProject, listProjects, projectContents } from '../services/projects'
import { PROJECT_ID, SCENE_ID, COLOR } from './schemas'
import { capability, said, CapabilityError } from './types'

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
    summary: 'Create a new video project (1920x1080 @ 60fps).',
    doc: 'Creates an empty project and its document. Free. Returns the project id — hold on to it; every other capability needs it. Add scenes with add_scene before adding any nodes.',
    args: z.object({ name: z.string().min(1) }),
    async handler(ctx, { name }) {
      if (!name.trim()) throw new CapabilityError('name cannot be blank')
      const project = await createProject(ctx.env, name, ctx.userId)
      return said(`created project ${project.id} "${project.name}"`, project)
    },
  }),

  capability({
    name: 'delete_project',
    summary: 'Delete a project and everything it owns. IRREVERSIBLE — needs confirm: true.',
    doc: [
      'Free, and **permanent**. Removes the document, every scene, all narration audio and render outputs, and the event log the history lives in. There is no undo capability, and no other capability can bring any of it back.',
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
          `NOT DELETED — ${holds}. This is permanent and there is no undo. ` +
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
    async handler(ctx, { projectId }) {
      const { doc } = await ctx.getDoc(projectId)
      return said(outlineDoc(doc), { doc })
    },
  }),

  capability({
    name: 'get_scene',
    summary: 'Full JSON of one scene, for detailed inspection.',
    doc: 'Everything in the scene — nodes, tracks, transitions, narration — as JSON. Free, but far larger than get_project: reach for it when an outline is not enough to explain what you are seeing.',
    args: z.object({ projectId: PROJECT_ID, sceneId: SCENE_ID }),
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
    doc: 'Extending `duration` is the usual fix when generate_narration reports that speech overruns the scene. Shortening a scene does not delete anything — nodes and keyframes past the new end simply stop being reached.',
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
      ctx.sceneOrThrow(doc, sceneId)
      await ctx.submit(projectId, [op.updateScene(sceneId, patch)])
      return said(`updated scene ${sceneId}: ${JSON.stringify(patch)}`, { sceneId, patch })
    },
  }),
]
