import { McpAgent } from 'agents/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  formatDecision,
  formatQuestionForChat,
  newId,
  op,
  outlineDoc,
  findNode,
  type Easing,
  type Decision,
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
 * A number, or a string that is unambiguously one.
 *
 * Union-typed params become `anyOf` in the tool's JSON Schema, and at least one
 * real MCP client (Claude Code) sends their values as strings — `1.12` arrives
 * as `"1.12"` and fails a plain `z.number()`. Plain numeric params are
 * unaffected, so this is needed only inside a union.
 *
 * Deliberately a regex rather than `z.coerce.number()`: coercion accepts `""`,
 * `true`, `null` and `[]` as 0 or 1, which would animate to a silently wrong
 * value instead of reporting a bad argument.
 */
/** How long to wait for a client to collect an answer before falling back. */
const ELICIT_TIMEOUT_MS = 30_000

const NUMBERISH = z.union([
  z.number(),
  z.string().regex(/^-?(\d+\.?\d*|\.\d+)$/).transform(Number),
])

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

  /**
   * Ask the client to collect the answer, via MCP's elicitation capability.
   *
   * This is the honest path: the human answers in their own client's UI and
   * the result comes straight back here, so the agent learns the answer but
   * cannot author it. The fallback — return a block, have the agent relay
   * what the human said — works everywhere but makes the agent an
   * interpreter, which is why that provenance is recorded as `agent`.
   *
   * Returns the text to hand the agent, or null when the client can't elicit
   * and the caller should fall back.
   */
  private async elicit(projectId: string, decision: Decision): Promise<string | null> {
    if (!this.server.server.getClientCapabilities()?.elicitation) return null
    try {
      const result = await this.server.server.elicitInput({
        mode: 'form',
        message: formatQuestionForChat(decision),
        requestedSchema: {
          type: 'object',
          properties: {
            choice: {
              type: 'string',
              title: 'Choice',
              description: decision.question,
              enum: decision.options.map((o) => o.id),
              enumNames: decision.options.map((o) => o.label),
            },
            note: {
              type: 'string',
              title: 'Or in your own words',
              description: 'optional — overrides the choice above',
            },
          },
          required: ['choice'],
        },
      },
      // Bounded on purpose. A client can advertise the capability and still
      // never deliver the request — observed with a Streamable-HTTP client
      // that wasn't reading the stream server-initiated requests arrive on.
      // Without a cap, every question would stall for the default timeout
      // before falling back. Long enough for a human to pick from a short
      // list; short enough that a silent client costs seconds, not minutes.
      { timeout: ELICIT_TIMEOUT_MS },
      )

      if (result.action !== 'accept') {
        // Declined or dismissed is not an answer; leave the question open so
        // the editor still shows it and the agent still knows it is blocked.
        return (
          `The human ${result.action === 'decline' ? 'declined' : 'dismissed'} the question ` +
          `(${decision.id}). It is still open. Ask them in your reply instead:\n\n` +
          formatQuestionForChat(decision)
        )
      }

      const content = (result.content ?? {}) as { choice?: string; note?: string }
      const answered = await this.api(
        `/api/projects/${projectId}/decisions/${decision.id}/answer`,
        {
          method: 'POST',
          body: JSON.stringify({ optionId: content.choice, note: content.note, via: 'chat' }),
        },
      )
      if (!answered.ok) return null // e.g. already answered in the editor
      const { decision: settled } = (await answered.json()) as { decision: Decision }
      return `ANSWERED by the human — continue.\n${formatDecision(settled)}`
    } catch {
      // Capability advertised but the request failed or timed out; the
      // pasteable block still works, so degrade rather than fail the tool.
      return null
    }
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
      'update_scene',
      'Change a scene\'s name, duration, or background. Extending duration is the usual fix when generate_narration reports that speech overruns the scene.',
      {
        projectId: z.string(),
        sceneId: z.string(),
        name: z.string().optional(),
        duration: z.number().positive().optional().describe('seconds'),
        background: COLOR.optional(),
      },
      async ({ projectId, sceneId, name, duration, background }) => {
        const patch = Object.fromEntries(
          Object.entries({ name, duration, background }).filter(([, v]) => v !== undefined),
        )
        if (Object.keys(patch).length === 0) throw new Error('nothing to update')
        await this.submit(projectId, [op.updateScene(sceneId, patch)])
        return text(`updated scene ${sceneId}: ${JSON.stringify(patch)}`)
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
        // NUMBERISH first: a colour like "#ff0000" fails it and falls through
        // to COLOR, while "1.12" is accepted where a bare z.number() would not.
        to: z.union([NUMBERISH, z.object({ x: NUMBERISH, y: NUMBERISH }), COLOR]),
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
      'highlight',
      'Draw attention to a node, or to one term inside an equation, for a stretch of time. Free. Give `tex` to mark a sub-expression — e.g. tex="\\\\frac{b}{a}" marks just that term, located by its glyphs, so you never need screen coordinates. Styles: `color` recolours the term (default, usually the cleanest), `spotlight` dims everything else and reads strongest on a busy equation, `box` and `underline` draw a marker around it. `color`/`spotlight` need `tex` on a latex node and fall back to a box otherwise. Use it when the narration dwells on something and nothing else is moving. Sequential highlights on one node accumulate; a call whose window overlaps an existing highlight replaces it, and one highlight renders at a time.',
      {
        projectId: z.string(),
        sceneId: z.string(),
        nodeId: z.string(),
        start: z.number().min(0).describe('scene-local seconds'),
        duration: z.number().positive(),
        tex: z.string().optional().describe('sub-expression to mark; whole node if omitted'),
        style: z.enum(['box', 'underline', 'color', 'spotlight']).default('color'),
        color: COLOR.default('#e8c74a'),
      },
      async ({ projectId, sceneId, nodeId, start, duration, tex, style, color }) => {
        const { doc } = await this.getDoc(projectId)
        const node = this.findNodeOrThrow(doc, sceneId, nodeId)
        if (tex && node.type !== 'latex') {
          throw new Error(`tex targeting only works on latex nodes; ${nodeId} is a ${node.type}`)
        }
        // Sequential highlights accumulate; only a highlight overlapping the
        // new window is replaced, so re-calling to adjust one still works.
        // The engine renders one highlight at a time, so overlap-replace is
        // also what keeps the document renderable as authored.
        const transitions: Transition[] = [
          ...node.transitions.filter(
            (t) =>
              t.type !== 'highlight' ||
              t.start + t.duration <= start ||
              start + duration <= t.start,
          ),
          { type: 'highlight', start, duration, tex, style, color },
        ]
        await this.submit(projectId, [op.updateNode(sceneId, nodeId, { transitions })])
        return text(
          `highlighting ${tex ? `"${tex}" in ` : ''}${nodeId} over [${start}s, ${start + duration}s] (${style})`,
        )
      },
    )

    this.server.tool(
      'set_narration',
      'Set the narration script for a scene. Free — writes text only. Call generate_narration afterwards to synthesize the audio.',
      { projectId: z.string(), sceneId: z.string(), narrationText: z.string(), voiceId: z.string().optional() },
      async ({ projectId, sceneId, narrationText, voiceId }) => {
        await this.submit(projectId, [
          op.setNarration(sceneId, { text: narrationText, voiceId }),
        ])
        return text(`narration set for ${sceneId} (${narrationText.split(/\s+/).length} words)`)
      },
    )

    this.server.tool(
      'generate_narration',
      'Synthesize a scene\'s narration to speech. COSTS CREDITS (priced by script length). Stores the audio and writes word-level timings into the document, which makes captions exact and gives you real timings to animate against. Warns if the speech is longer than the scene.',
      {
        projectId: z.string(),
        sceneId: z.string(),
        text: z.string().optional().describe('overrides the scene\'s existing narration text'),
        voiceId: z.string().optional(),
      },
      async ({ projectId, sceneId, text: override, voiceId }) => {
        const res = await this.api(
          `/api/projects/${projectId}/scenes/${sceneId}/narration/generate`,
          { method: 'POST', body: JSON.stringify({ text: override, voiceId }) },
        )
        return text(await res.text())
      },
    )

    this.server.tool(
      'fit_scene_to_narration',
      'Set a scene\'s duration from its generated speech plus a held tail. Free. Use it to close dead air (get_project flags a long tail) or to make room when speech overruns. The tail is deliberate breathing room — pass more for a beat you want to land, less to keep things tight.',
      {
        projectId: z.string(),
        sceneId: z.string(),
        tailSec: z
          .number()
          .min(0)
          .max(10)
          .default(0.8)
          .describe('silence held after the last word'),
      },
      async ({ projectId, sceneId, tailSec }) => {
        const { doc } = await this.getDoc(projectId)
        const scene = doc.scenes.find((s) => s.id === sceneId)
        if (!scene) throw new Error(`scene ${sceneId} not found`)
        const audio = scene.narration?.audio
        if (!audio) {
          throw new Error(
            `scene ${sceneId} has no generated narration — call generate_narration first`,
          )
        }
        const duration = Math.round((audio.durationSec + tailSec) * 100) / 100
        await this.submit(projectId, [op.updateScene(sceneId, { duration })])
        return text(
          `scene ${sceneId}: ${scene.duration}s → ${duration}s ` +
            `(${audio.durationSec.toFixed(2)}s speech + ${tailSec}s tail)`,
        )
      },
    )

    this.server.tool(
      'ask_user',
      'Put a choice to the human IN CHAT and wait for their reply. Free. Use when a decision is genuinely theirs — pacing, style, how to resolve a narration overrun, whether a scene change needs explaining — not for things you can determine yourself. This is blocking by intention. If your client supports MCP elicitation you will be shown the answer directly; otherwise it returns a ready-to-paste block — put it in your very next reply and stop. Do not keep building against a guess, and do not defer the question to a summary at the end — an unanswered question that you worked around was not a question. Chat is the surface that always exists — the system may run headless with no editor open, so never wait on the browser. The question is also mirrored into the editor for anyone who does have it open, and get_answer reports that; the normal path is that they reply to you and you call record_answer.',
      {
        projectId: z.string(),
        question: z.string().min(1).describe('one clear question'),
        options: z
          .array(z.object({ label: z.string(), detail: z.string().optional() }))
          .min(2)
          .max(6)
          .describe('2-6 mutually exclusive choices; say what each one does'),
        detail: z.string().optional().describe('context they need to choose well'),
        sceneId: z.string().optional(),
        atSec: z.number().min(0).optional().describe('global seconds; the editor seeks here'),
      },
      async ({ projectId, question, options, detail, sceneId, atSec }) => {
        const res = await this.api(`/api/projects/${projectId}/decisions`, {
          method: 'POST',
          body: JSON.stringify({
            question,
            detail,
            // Stable, readable ids so the agent can refer to a choice later.
            options: options.map((o, i) => ({ id: `opt${i + 1}`, ...o })),
            context: sceneId || atSec !== undefined ? { sceneId, atSec } : undefined,
          }),
        })
        if (!res.ok) throw new Error(`ask_user failed (${res.status}): ${await res.text()}`)
        const { decision } = (await res.json()) as { decision: Decision }
        // Preferred path: have the client collect the answer itself, so the
        // human gets their own native picker and the answer travels
        // client → server with the agent never in the middle. Clients that
        // don't advertise the capability fall through to the block below.
        const elicited = await this.elicit(projectId, decision)
        if (elicited) return text(elicited)

        // Fallback. The return value is the strongest prompt surface there is
        // — the agent reads it the instant it lands. A receipt ("asked (id)")
        // gets filed and worked around; an instruction gets followed. This
        // wording exists because a real run asked a good question, scheduled a
        // wakeup, built the rest of the video against its own guess, and only
        // mentioned the unanswered question in its closing summary.
        return text(
          `STOP — WAITING ON THE HUMAN (${decision.id})\n` +
            `Paste the block below into your NEXT reply, then stop and wait. Do not ` +
            `continue building, do not pick a default, and do not save it for a ` +
            `summary later.\n\n` +
            `────────────────────────────\n` +
            `${formatQuestionForChat(decision)}\n` +
            `────────────────────────────\n\n` +
            `When they reply to you, call record_answer with optionId ${decision.options
              .map((o, i) => `${i + 1}→${o.id}`)
              .join(' ')} (or note=<their words>). If they happen to have the editor ` +
            `open they can answer there instead and get_answer will report it — but ` +
            `never rely on that: the system may be running headless.`,
        )
      },
    )

    this.server.tool(
      'get_answer',
      'Check whether the human has answered. Free — poll it. A question still open means you are still blocked: ask again in your reply rather than proceeding. With no decisionId, lists every question and its status.',
      { projectId: z.string(), decisionId: z.string().optional() },
      async ({ projectId, decisionId }) => {
        const res = await this.api(`/api/projects/${projectId}/decisions`)
        if (!res.ok) throw new Error(`get_answer failed (${res.status}): ${await res.text()}`)
        const { decisions } = (await res.json()) as { decisions: Decision[] }
        const wanted = decisionId ? decisions.filter((d) => d.id === decisionId) : decisions
        if (wanted.length === 0) {
          return text(decisionId ? `no decision ${decisionId}` : 'no questions asked yet')
        }
        // Still-open questions repeat the instruction: polling and then
        // carrying on regardless is the exact failure this guards against.
        const open = wanted.filter((d) => d.status === 'open')
        const header = open.length
          ? `STILL WAITING on ${open.length} question(s). Ask the human again in your ` +
            `reply and stop; do not proceed until they answer.\n\n`
          : ''
        return text(header + wanted.map(formatDecision).join('\n'))
      },
    )

    this.server.tool(
      'record_answer',
      "Record an answer the human gave you in conversation rather than in the editor. Free. Only for what they actually said — never guess on their behalf; if they haven't answered, keep waiting.",
      {
        projectId: z.string(),
        decisionId: z.string(),
        optionId: z.string().optional().describe('the id of the option they chose'),
        note: z.string().optional().describe('their answer verbatim, if they did not pick an option'),
      },
      async ({ projectId, decisionId, optionId, note }) => {
        const res = await this.api(
          `/api/projects/${projectId}/decisions/${decisionId}/answer`,
          { method: 'POST', body: JSON.stringify({ optionId, note, via: 'agent' }) },
        )
        if (!res.ok) throw new Error(`record_answer failed (${res.status}): ${await res.text()}`)
        const { decision } = (await res.json()) as { decision: Decision }
        return text(formatDecision(decision))
      },
    )

    this.server.tool(
      'get_captions',
      'Subtitles for the whole project (SRT or VTT). Free — derived from narration. Cues are word-accurate where TTS timings exist, and estimated from text length elsewhere.',
      { projectId: z.string(), format: z.enum(['srt', 'vtt']).default('srt') },
      async ({ projectId, format }) => {
        const res = await this.api(`/api/projects/${projectId}/captions?format=${format}`)
        return text(await res.text())
      },
    )

    this.server.tool(
      'render_video',
      'Render the project to MP4. COSTS CREDITS (per second of video; narration is billed separately by generate_narration). Returns a job id.',
      { projectId: z.string() },
      async ({ projectId }) => {
        const res = await this.api(`/api/projects/${projectId}/render`, { method: 'POST' })
        return text(await res.text())
      },
    )

    this.server.tool(
      'get_render_status',
      'Status of recent render jobs for a project. A finished job includes downloadUrl for the MP4; a failed job has had its credits refunded.',
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
