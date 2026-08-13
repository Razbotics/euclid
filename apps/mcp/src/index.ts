import { McpAgent } from 'agents/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  newId,
  op,
  outlineDoc,
  findNode,
  type Easing,
  type EuclidDoc,
  type EuclidNode,
  type Op,
  type Track,
  type Transition,
  type Vec2,
} from '@euclid/dsl'
import { resolveNode } from '@euclid/engine'

interface Env {
  MCP_OBJECT: DurableObjectNamespace
  API: Fetcher
  INTERNAL_API_KEY: string
}

/** Set by the OAuth layer once wired; dev fallback below. */
type Props = { userId?: string }

const EASING = z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'smooth']).default('smooth')
const COLOR = z.string().regex(/^#[0-9a-fA-F]{6}$/)

/**
 * The agent-facing sugar layer. Tools speak in intents (animate, morph_latex,
 * write_on); everything compiles down to DSL ops submitted to the project's
 * Durable Object through the API worker. Iterating here is free — credits are
 * only spent by render_video / TTS.
 */
export class EuclidMcpAgent extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: 'euclid', version: '0.1.0' })

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

  private async getDoc(projectId: string): Promise<{ doc: EuclidDoc; version: number }> {
    const res = await this.api(`/api/projects/${projectId}/doc`)
    if (!res.ok) throw new Error(`get doc failed (${res.status}): ${await res.text()}`)
    return (await res.json()) as { doc: EuclidDoc; version: number }
  }

  /** Submit ops with fetch-version → apply → retry-on-409 rebase (3 attempts). */
  private async submit(projectId: string, ops: Op[]): Promise<{ version: number; doc: EuclidDoc }> {
    let lastError = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      const { version } = await this.getDoc(projectId)
      const res = await this.api(`/api/projects/${projectId}/ops`, {
        method: 'POST',
        body: JSON.stringify({
          id: crypto.randomUUID(),
          baseVersion: version,
          actor: { type: 'agent', id: this.userId },
          ops,
        }),
      })
      if (res.ok) {
        const { doc } = await this.getDoc(projectId)
        return { version: ((await res.json()) as { version: number }).version, doc }
      }
      lastError = await res.text()
      if (res.status !== 409) break
    }
    throw new Error(`ops rejected: ${lastError}`)
  }

  private findNodeOrThrow(doc: EuclidDoc, sceneId: string, nodeId: string): EuclidNode {
    const scene = doc.scenes.find((s) => s.id === sceneId)
    if (!scene) throw new Error(`scene ${sceneId} not found`)
    const hit = findNode(scene.nodes, nodeId)
    if (!hit) throw new Error(`node ${nodeId} not found in scene ${sceneId}`)
    return hit.node
  }

  async init(): Promise<void> {
    const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
    const baseNode = (position: Vec2) => ({
      position,
      scale: 1,
      rotation: 0,
      opacity: 1,
      tracks: [] as Track[],
      transitions: [] as Transition[],
    })

    this.server.tool('list_projects', 'List your Euclid video projects.', {}, async () => {
      const res = await this.api('/api/projects')
      return text(await res.text())
    })

    this.server.tool(
      'create_project',
      'Create a new video project (1920x1080 @ 60fps by default).',
      { name: z.string().min(1) },
      async ({ name }) => {
        const res = await this.api('/api/projects', { method: 'POST', body: JSON.stringify({ name }) })
        return text(await res.text())
      },
    )

    this.server.tool(
      'get_project',
      'Compact outline of a project: scenes, timings, nodes, animations. Cheap — call freely while iterating.',
      { projectId: z.string() },
      async ({ projectId }) => text(outlineDoc((await this.getDoc(projectId)).doc)),
    )

    this.server.tool(
      'get_scene',
      'Full JSON of one scene, for detailed inspection.',
      { projectId: z.string(), sceneId: z.string() },
      async ({ projectId, sceneId }) => {
        const { doc } = await this.getDoc(projectId)
        const scene = doc.scenes.find((s) => s.id === sceneId)
        if (!scene) throw new Error(`scene ${sceneId} not found`)
        return text(JSON.stringify(scene, null, 2))
      },
    )

    this.server.tool(
      'add_scene',
      'Append a scene. Coordinates are canvas pixels, origin top-left; scene time starts at 0.',
      {
        projectId: z.string(),
        name: z.string(),
        duration: z.number().positive().describe('seconds'),
        background: COLOR.default('#101418'),
      },
      async ({ projectId, name, duration, background }) => {
        const id = newId('sc')
        await this.submit(projectId, [
          op.addScene({ id, name, duration, background, nodes: [] }),
        ])
        return text(`created scene ${id}`)
      },
    )

    this.server.tool(
      'add_latex',
      'Add a LaTeX equation node (rendered like 3b1b math). Anchored at its center.',
      {
        projectId: z.string(),
        sceneId: z.string(),
        tex: z.string().min(1),
        x: z.number(),
        y: z.number(),
        fontSize: z.number().positive().default(64),
        color: COLOR.default('#ffffff'),
      },
      async ({ projectId, sceneId, tex, x, y, fontSize, color }) => {
        const id = newId('eq')
        await this.submit(projectId, [
          op.addNode(sceneId, { ...baseNode({ x, y }), id, type: 'latex', tex, color, fontSize }),
        ])
        return text(`created latex node ${id}`)
      },
    )

    this.server.tool(
      'add_text',
      'Add a text node, anchored at its center.',
      {
        projectId: z.string(),
        sceneId: z.string(),
        textContent: z.string(),
        x: z.number(),
        y: z.number(),
        fontSize: z.number().positive().default(48),
        fill: COLOR.default('#ffffff'),
        fontFamily: z.string().default('Georgia, serif'),
      },
      async ({ projectId, sceneId, textContent, x, y, fontSize, fill, fontFamily }) => {
        const id = newId('txt')
        await this.submit(projectId, [
          op.addNode(sceneId, {
            ...baseNode({ x, y }),
            id,
            type: 'text',
            text: textContent,
            fontSize,
            fill,
            fontFamily,
          }),
        ])
        return text(`created text node ${id}`)
      },
    )

    this.server.tool(
      'add_shape',
      'Add a rect, circle or line. Rect/circle are anchored at their center; line points are relative to position.',
      {
        projectId: z.string(),
        sceneId: z.string(),
        shape: z.enum(['rect', 'circle', 'line']),
        x: z.number(),
        y: z.number(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        radius: z.number().positive().optional(),
        x2: z.number().optional().describe('line end x, relative to position'),
        y2: z.number().optional().describe('line end y, relative to position'),
        fill: COLOR.default('#58c4dd'),
        stroke: COLOR.optional(),
        strokeWidth: z.number().min(0).default(4),
      },
      async ({ projectId, sceneId, shape, x, y, width, height, radius, x2, y2, fill, stroke, strokeWidth }) => {
        const id = newId(shape)
        let node: EuclidNode
        if (shape === 'rect') {
          node = {
            ...baseNode({ x, y }),
            id,
            type: 'rect',
            width: width ?? 200,
            height: height ?? 120,
            fill,
            cornerRadius: 0,
            stroke,
            strokeWidth,
          }
        } else if (shape === 'circle') {
          node = { ...baseNode({ x, y }), id, type: 'circle', radius: radius ?? 80, fill, stroke, strokeWidth }
        } else {
          node = {
            ...baseNode({ x, y }),
            id,
            type: 'line',
            from: { x: 0, y: 0 },
            to: { x: x2 ?? 100, y: y2 ?? 0 },
            stroke: stroke ?? fill,
            strokeWidth: Math.max(1, strokeWidth),
          }
        }
        await this.submit(projectId, [op.addNode(sceneId, node)])
        return text(`created ${shape} node ${id}`)
      },
    )

    this.server.tool(
      'update_node',
      'Shallow-patch node properties (position, opacity, fill, tex, text, fontSize...). id/type are immutable.',
      { projectId: z.string(), sceneId: z.string(), nodeId: z.string(), patch: z.record(z.any()) },
      async ({ projectId, sceneId, nodeId, patch }) => {
        await this.submit(projectId, [op.updateNode(sceneId, nodeId, patch)])
        return text(`updated ${nodeId}`)
      },
    )

    this.server.tool(
      'remove_node',
      'Delete a node from a scene.',
      { projectId: z.string(), sceneId: z.string(), nodeId: z.string() },
      async ({ projectId, sceneId, nodeId }) => {
        await this.submit(projectId, [op.removeNode(sceneId, nodeId)])
        return text(`removed ${nodeId}`)
      },
    )

    this.server.tool(
      'animate',
      'Animate one property from its current value (sampled at `start`) to `to`, over `duration` seconds. Properties: position {x,y}, scale/rotation/opacity/width/height/radius/fontSize/strokeWidth (number), fill/stroke/color (#rrggbb). Existing keyframes after `start` on that property are replaced.',
      {
        projectId: z.string(),
        sceneId: z.string(),
        nodeId: z.string(),
        property: z.enum([
          'position', 'scale', 'rotation', 'opacity', 'fill', 'stroke', 'color',
          'width', 'height', 'radius', 'fontSize', 'strokeWidth',
        ]),
        to: z.union([z.number(), z.object({ x: z.number(), y: z.number() }), COLOR]),
        start: z.number().min(0).describe('scene-local seconds'),
        duration: z.number().positive(),
        easing: EASING,
      },
      async ({ projectId, sceneId, nodeId, property, to, start, duration, easing }) => {
        const { doc } = await this.getDoc(projectId)
        const node = this.findNodeOrThrow(doc, sceneId, nodeId)
        const current = resolveNode(node, start).props[property]
        if (current === undefined) {
          throw new Error(`property ${property} does not exist on ${node.type} node ${nodeId}`)
        }
        const existing = node.tracks.find((t) => t.property === property)
        const keep = existing ? existing.keyframes.filter((k) => k.t < start) : []
        const track: Track = {
          property,
          keyframes: [
            ...keep,
            { t: start, value: current, easing: 'linear' },
            { t: start + duration, value: to, easing: easing as Easing },
          ],
        }
        await this.submit(projectId, [op.setTrack(sceneId, nodeId, track)])
        return text(`animating ${nodeId}.${property} → ${JSON.stringify(to)} over [${start}s, ${start + duration}s]`)
      },
    )

    this.server.tool(
      'morph_latex',
      'Morph a latex node to a new equation (the signature 3b1b move). Chains: multiple morphs on one node run in start-time order.',
      {
        projectId: z.string(),
        sceneId: z.string(),
        nodeId: z.string(),
        toTex: z.string().min(1),
        start: z.number().min(0),
        duration: z.number().positive().default(1),
        easing: EASING,
      },
      async ({ projectId, sceneId, nodeId, toTex, start, duration, easing }) => {
        const { doc } = await this.getDoc(projectId)
        const node = this.findNodeOrThrow(doc, sceneId, nodeId)
        if (node.type !== 'latex') throw new Error(`${nodeId} is a ${node.type}, not latex`)
        const transitions: Transition[] = [
          ...node.transitions,
          { type: 'texMorph', start, duration, toTex, easing: easing as Easing },
        ]
        await this.submit(projectId, [op.updateNode(sceneId, nodeId, { transitions })])
        return text(`morphing ${nodeId} → "${toTex}" over [${start}s, ${start + duration}s]`)
      },
    )

    this.server.tool(
      'write_on',
      'Draw-on reveal (left to right), like writing an equation by hand. Node is invisible before `start`.',
      {
        projectId: z.string(),
        sceneId: z.string(),
        nodeId: z.string(),
        start: z.number().min(0),
        duration: z.number().positive().default(1.5),
      },
      async ({ projectId, sceneId, nodeId, start, duration }) => {
        const { doc } = await this.getDoc(projectId)
        const node = this.findNodeOrThrow(doc, sceneId, nodeId)
        const transitions: Transition[] = [
          ...node.transitions.filter((t) => t.type !== 'write'),
          { type: 'write', start, duration },
        ]
        await this.submit(projectId, [op.updateNode(sceneId, nodeId, { transitions })])
        return text(`write-on ${nodeId} over [${start}s, ${start + duration}s]`)
      },
    )

    this.server.tool(
      'set_narration',
      'Set the narration script for a scene. TTS audio is generated at render time (word timestamps become sync anchors).',
      { projectId: z.string(), sceneId: z.string(), narrationText: z.string(), voiceId: z.string().optional() },
      async ({ projectId, sceneId, narrationText, voiceId }) => {
        await this.submit(projectId, [
          op.setNarration(sceneId, { text: narrationText, voiceId }),
        ])
        return text(`narration set for ${sceneId} (${narrationText.split(/\s+/).length} words)`)
      },
    )

    this.server.tool(
      'render_video',
      'Render the project to MP4. COSTS CREDITS (per second of video + TTS minutes). Returns a job id.',
      { projectId: z.string() },
      async ({ projectId }) => {
        const res = await this.api(`/api/projects/${projectId}/render`, { method: 'POST' })
        return text(await res.text())
      },
    )

    this.server.tool(
      'get_render_status',
      'Status of recent render jobs for a project.',
      { projectId: z.string() },
      async ({ projectId }) => {
        const res = await this.api(`/api/projects/${projectId}/renders`)
        return text(await res.text())
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
