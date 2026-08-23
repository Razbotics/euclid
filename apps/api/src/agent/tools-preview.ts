import { z } from 'zod'
import {
  DEFAULT_CAMERA_DISTANCE,
  formatMoments,
  keyMoments,
  type EuclidDoc,
  type KeyMoment,
  type Vec2,
} from '@euclid/dsl'
import { resolveScene, screenPoint, type ResolvedNode } from '@euclid/engine'
import { NODE_ID, PROJECT_ID, SCENE_ID } from './schemas'
import { capability, said, CapabilityError, type CapabilityResult } from './types'
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

/** One number, short enough to read in a line of a hundred of them. */
function r(n: number): string {
  return (Math.round(n * 100) / 100).toString()
}

function xy(p: Vec2): string {
  return `(${r(p.x)}, ${r(p.y)})`
}

/**
 * One resolved node as a line.
 *
 * Everything here is *post*-resolution: the world position has every ancestor
 * group's transform composed in, a follower is already on its path, and the
 * screen point has the camera applied. Which is the point — each of those is a
 * step a caller would otherwise redo by hand, and run 8 got exactly that
 * arithmetic wrong.
 */
function sampleLine(
  n: ResolvedNode,
  camera: Parameters<typeof screenPoint>[1],
  canvas: EuclidDoc['canvas'],
  indent: string,
  /**
   * Whether the sampler would have projected this node at all. Only unpinned
   * root nodes in a spatial scene are, so a null projection means "behind the
   * camera" for those and "never projected" for everyone else — and reporting
   * the wrong one of those sends a caller hunting a depth bug in a 2D node.
   */
  projectable: boolean,
): { line: string; visible: boolean } {
  const src = n.source
  // Projection replaces the anchor's scene position in a spatial scene, so it
  // is what the camera transform must be fed.
  const scenePos = n.projection ? { x: n.projection.x, y: n.projection.y } : n.world
  const screen = screenPoint(scenePos, camera, canvas)
  const opacity = (n.props.opacity as number) ?? 1

  const bits: string[] = [`${xy(n.world)}`]
  if (screen.x !== n.world.x || screen.y !== n.world.y) bits.push(`screen=${xy(screen)}`)
  if (n.projection) {
    bits.push(`depth=${r(n.projection.depth)}`, `persp=${r(n.projection.scale)}x`)
  } else if (!projectable && (src.z !== undefined || src.type === 'mesh' || src.type.endsWith('3'))) {
    // A spatial node the sampler never projects — inside a group, or pinned.
    // Saying so beats leaving a gap where the depth numbers would be, and it
    // names the cause, which is the fix.
    bits.push(src.fixed ? 'pinned (not projected)' : 'in a group (not projected)')
  }
  if (opacity !== 1) bits.push(`opacity=${r(opacity)}`)
  if (n.worldScale !== 1) bits.push(`scale=${r(n.worldScale)}`)
  if (n.worldRotation !== 0) bits.push(`rot=${r(n.worldRotation)}rad`)
  if (n.writeProgress !== null) bits.push(`write=${Math.round(n.writeProgress * 100)}%`)
  if (n.highlight) {
    bits.push(`highlight=${n.highlight.style} ${Math.round(n.highlight.strength * 100)}%`)
  }
  if (n.texMorph) {
    bits.push(`morph=${Math.round(n.texMorph.progress * 100)}% → "${n.texMorph.toTex}"`)
  }
  if (n.cellMorph) bits.push(`cellMorph=${Math.round(n.cellMorph.progress * 100)}%`)
  if (n.arrow) bits.push(`from=${xy(n.arrow.from)} to=${xy(n.arrow.to)}`)

  // "Nothing is drawn" has three unrelated causes and they look identical in a
  // frame — this is the read that tells them apart.
  const hidden =
    opacity <= 0.001
      ? 'INVISIBLE (opacity 0)'
      : n.writeProgress === 0
        ? 'INVISIBLE (write has not started)'
        : projectable && n.projection === null
          ? 'INVISIBLE (at or behind the camera — lower its z, or move the camera back)'
          : ''
  // Only for things that draw. A group's anchor is a pivot, not a picture: a
  // group at (0, 0) holding children spread across the canvas is entirely
  // visible, and flagging it would send a caller hunting a layout bug that is
  // not there.
  const off =
    !hidden &&
    src.type !== 'group' &&
    (screen.x < 0 || screen.y < 0 || screen.x > canvas.width || screen.y > canvas.height)
      ? 'OFF-FRAME'
      : ''
  if (hidden) bits.push(hidden)
  if (off) bits.push(off)

  return {
    line: `${indent}${src.type} ${src.id} ${bits.join(' ')}`,
    visible: !hidden && !off,
  }
}

/** Is any requested node under this one? Keeps a filtered listing's groups. */
function subtreeHas(n: ResolvedNode, want: Set<string>): boolean {
  return n.children.some((c) => want.has(c.source.id) || subtreeHas(c, want))
}

export const previewTools = [
  capability({
    name: 'sample_at',
    summary: 'Where everything actually is at one moment — resolved positions, no pixels. Free.',
    doc: [
      '**The answer preview_frames makes you eyeball.** Rendering is a pure function of (document, time), and this runs that function without drawing: it reports where every node *ends up* at scene-local second `t`, after tracks, group transforms, path-following and the camera have all had their say.',
      '',
      'Use it when the question is a number rather than a picture — when does this reach that, do these two overlap yet, is that node on screen at all. A real run computed a crossing time by arithmetic over its own keyframes, got it wrong, and only caught it from a contact sheet; this answers it exactly and costs nothing.',
      '',
      'Each line is one node, deepest-first by group, reporting the ones that differ from the boring answer:',
      '',
      '- the **scene position** — the composed world position, with every ancestor group folded in, and with a `flow_along` follower already moved onto its path',
      '- `screen=` — where that lands in canvas pixels once the camera has framed it. Absent when there is no camera, because then they are the same number',
      '- `depth=`/`persp=` in an orbited scene, `write=`, `highlight=`, `morph=`, and an arrow\'s resolved endpoints',
      '- `INVISIBLE` with the reason (opacity 0, write not started, behind the camera) and `OFF-FRAME` when the anchor falls outside the canvas',
      '',
      '**It reports anchors, not extents.** A path\'s anchor is its origin, not its curve; text and LaTeX are sized by the renderer, not the document. So this answers "where is this node" exactly and "do these two overlap" only roughly — for extents, look with preview_frames.',
      '',
      '`t` is SCENE-LOCAL seconds, like every other time in this surface. The reply states the global time as well, which is what preview_frames takes.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      sceneId: SCENE_ID,
      t: z.number().min(0).describe('scene-local seconds'),
      nodeIds: z
        .array(NODE_ID)
        .max(200)
        .optional()
        .describe('only these nodes (and their groups); default every node'),
    }),
    // The capability a sweep is most likely to loop over — twenty samples and
    // a comparison in code is the shape this exists for — so what the numbers
    // *are* is worth stating rather than leaving to be inferred from prose.
    result: z.object({
      sceneId: z.string(),
      t: z.number().describe('scene-local seconds, as asked for'),
      globalT: z.number().describe('the same moment on the whole-video timeline'),
      spatial: z.boolean().describe('true once the scene projects — a camera yaw/pitch or any z'),
      camera: z.unknown().nullable().describe('the resolved camera, or null when the scene has none'),
      nodes: z.array(
        z.object({
          id: z.string(),
          type: z.string(),
          world: z
            .object({ x: z.number(), y: z.number() })
            .describe('composed scene position: group transforms folded in, follows applied'),
          screen: z
            .object({ x: z.number(), y: z.number() })
            .describe('where that lands in canvas pixels once the camera has framed it'),
          opacity: z.number(),
          scale: z.unknown(),
          rotation: z.number().describe('radians'),
          writeProgress: z.number().optional(),
          projection: z.unknown().optional().describe('depth/perspective, in an orbited scene'),
          highlight: z.unknown().optional(),
          visible: z
            .boolean()
            .describe('drawn at this moment — false covers opacity 0, unwritten, behind camera'),
        }),
      )
        .describe('anchors, NOT extents — a node\'s size is not knowable from here'),
    }),
    async handler(ctx, { projectId, sceneId, t, nodeIds }) {
      const { doc } = await ctx.getDoc(projectId)
      const scene = ctx.sceneOrThrow(doc, sceneId)
      const sceneStart = doc.scenes.slice(0, doc.scenes.findIndex((s) => s.id === sceneId)).reduce(
        (s, sc) => s + sc.duration,
        0,
      )

      const resolved = resolveScene(scene, t, doc.canvas)
      const want = nodeIds?.length ? new Set(nodeIds) : null
      const lines: string[] = []
      let shown = 0
      let visible = 0
      const data: unknown[] = []

      const walk = (nodes: ResolvedNode[], indent: string, root: boolean): void => {
        for (const n of nodes) {
          // A group is kept when a requested node is somewhere under it, so the
          // hierarchy that explains a child's world position stays readable.
          const kept = !want || want.has(n.source.id) || subtreeHas(n, want)
          // Matches resolveScene: only unpinned root nodes are projected.
          const projectable = resolved.spatial && root && !n.source.fixed
          if (kept) {
            const { line, visible: v } = sampleLine(n, resolved.camera, doc.canvas, indent, projectable)
            lines.push(line)
            shown++
            if (v) visible++
            data.push({
              id: n.source.id,
              type: n.source.type,
              world: n.world,
              screen: screenPoint(
                n.projection ? { x: n.projection.x, y: n.projection.y } : n.world,
                resolved.camera,
                doc.canvas,
              ),
              opacity: n.props.opacity ?? 1,
              scale: n.worldScale,
              rotation: n.worldRotation,
              writeProgress: n.writeProgress,
              projection: n.projection,
              highlight: n.highlight,
              visible: v,
            })
          }
          if (n.source.type === 'group') walk(n.children, indent + '  ', false)
        }
      }
      walk(resolved.nodes, '  ', true)

      if (want && shown === 0) {
        throw new CapabilityError(
          `none of ${[...want].join(', ')} are in scene ${sceneId}. get_scene lists what is.`,
          404,
        )
      }

      const cam = resolved.camera
      const camLine = cam
        ? `  camera @${xy(cam.position)} zoom=${r(cam.zoom)}` +
          (cam.rotation !== 0 ? ` roll=${r(cam.rotation)}rad` : '') +
          (resolved.spatial ? ` yaw=${r(cam.yaw)} pitch=${r(cam.pitch)} dist=${r(cam.distance)}` : '')
        : // A scene holding a depth still projects — head-on, through a default
          // camera the sampler invents. Reporting "no camera" flat would leave
          // the depth/persp columns below looking like they came from nowhere.
          resolved.spatial
          ? '  no camera, but this scene has depth — projected head-on from the canvas centre, ' +
            `dist=${DEFAULT_CAMERA_DISTANCE}. Scene coordinates are screen coordinates.`
          : '  no camera — scene coordinates are screen coordinates'
      const past =
        t > scene.duration + 1e-6
          ? `\nNOTE: t=${r(t)}s is past this scene's ${r(scene.duration)}s end, so this moment is ` +
            `never rendered. Tracks hold their last keyframe there, which is why it still ` +
            `reports numbers.`
          : ''

      return said(
        `scene ${sceneId} "${scene.name}" at t=${r(t)}s (global ${r(sceneStart + t)}s), ` +
          `${shown} node(s), ${visible} drawn:\n` +
          camLine +
          `\n${lines.join('\n')}` +
          `\nPositions are anchors, resolved after tracks, groups, follows and the camera. ` +
          `They cannot tell you a node's size — use preview_frames for that.` +
          past,
        { sceneId, t, globalT: sceneStart + t, spatial: resolved.spatial, camera: cam, nodes: data },
      )
    },
  }),

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
      const allBlank = image.ink.length > 0 && blank.length === image.ink.length
      // Only a fault when the times came from key moments: the document said
      // something was happening at every one of them, so all-blank means the
      // capture failed. An explicitly requested time is a question, and "empty"
      // is a legitimate answer to it — a node that has not been written on yet,
      // or a camera framing part of the scene where nothing is. Erroring there
      // would tell the agent its backend is broken when its framing is wrong,
      // which is the exact confusion this guard exists to prevent.
      if (allBlank && !at?.length) {
        throw new CapabilityError(
          `every frame came back empty, which is a capture fault rather than a verdict on ` +
            `the video — do not conclude anything about the project from it. The preview ` +
            `backend rendered ${tiles.length} frame(s) at moments the document says are ` +
            `busy, and all were blank.`,
          502,
        )
      }

      const listing = at?.length
        ? tiles.map((t, i) => `[${i}] t=${t.t.toFixed(2)}s`).join('\n')
        : formatMoments(moments)
      const emptyNote = blank.length
        ? `\n\n${allBlank ? 'EVERY frame is' : `Tile(s) ${blank.map((b) => `[${b.i}]`).join(' ')} are`} ` +
          `empty. That is normal before a write-on begins or after a node is removed, but if ` +
          `you expected something there, check the node's timing, its position, and — if the ` +
          `scene has a camera — whether the camera is framing it (get_project shows \`cam@\`).`
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
