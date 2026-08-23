import { z } from 'zod'
import { spatialTools } from './tools-3d'
import { animTools } from './tools-anim'
import { batchTools } from './tools-batch'
import { cameraTools } from './tools-camera'
import { decisionTools } from './tools-decision'
import { flowTools } from './tools-flow'
import { genTools } from './tools-gen'
import { gridTools } from './tools-grid'
import { mediaTools } from './tools-media'
import { nodeTools } from './tools-node'
import { planTools } from './tools-plan'
import { previewTools } from './tools-preview'
import { projectTools } from './tools-project'
import type { Capability } from './types'

const ALL: Capability[] = [
  ...projectTools,
  ...planTools,
  ...nodeTools,
  ...gridTools,
  ...spatialTools,
  ...flowTools,
  ...animTools,
  ...cameraTools,
  ...mediaTools,
  ...genTools,
  ...previewTools,
  ...decisionTools,
  ...batchTools,
]

const BY_NAME = new Map(ALL.map((c) => [c.name, c]))

if (BY_NAME.size !== ALL.length) {
  throw new Error('duplicate capability name in the catalog')
}

/**
 * Argument names that are settled, and the spellings that must not come back.
 *
 * Every one of these was a real wrong guess in a milestone run. Three separate
 * runs reached for `text` — on `add_text` and on `set_narration` — and were
 * wrong both times, which is the strongest evidence available for what the
 * name *should* be: the catalog was disagreeing with itself, and the agent was
 * right. Run 4 wrote `colour`.
 *
 * Only true synonyms live here — one idea with one right spelling. `fill` is
 * absent on purpose: on a shape it is half of a `fill`/`stroke` pair and means
 * something `color` does not, so banning it would be wrong. The line this
 * draws is that a *single ink* is `color`; an area with an outline has both.
 *
 * Checked at module load, like the duplicate-name check above and `ref()` in
 * the orientation block: a convention nothing enforces is a convention that
 * has already rotted somewhere nobody has looked.
 */
const BANNED_ARGS: Record<string, string> = {
  textContent: 'text',
  narrationText: 'text',
  textValue: 'text',
  colour: 'color',
  nodeID: 'nodeId',
  sceneID: 'sceneId',
  projectID: 'projectId',
}

for (const cap of ALL) {
  if (!(cap.args instanceof z.ZodObject)) continue
  for (const arg of Object.keys(cap.args.shape)) {
    const canonical = BANNED_ARGS[arg]
    if (canonical) {
      throw new Error(
        `capability "${cap.name}" declares \`${arg}\`, which is a second spelling of ` +
          `\`${canonical}\`. One idea, one name — an agent that learned the name on ` +
          `another capability must be able to reuse it here. Rename it, or, if this ` +
          `really is a different idea, give it a name that says so.`,
      )
    }
  }
}

export const capabilities: readonly Capability[] = ALL

export function getCapability(name: string): Capability | undefined {
  return BY_NAME.get(name)
}

export function capabilityNames(): string[] {
  return ALL.map((c) => c.name)
}

/**
 * Changes whenever the catalog does.
 *
 * The point of the gateway is that a tool edit is live immediately — the MCP
 * tool list never changes, so no client has to reconnect. The cost is that an
 * agent mid-thread may be holding a `describe` from before the edit. Stamping
 * every response lets a validation failure say "the schema moved" instead of
 * looking like the agent got the call wrong.
 */
export const CATALOG_REVISION = ALL.map((c) => `${c.name}:${c.summary.length}`)
  .join('|')
  .split('')
  .reduce((h, ch) => ((h << 5) - h + ch.charCodeAt(0)) | 0, 0)
  .toString(36)

/**
 * JSON Schema for one capability's args — the contract `describe` hands back.
 *
 * `io: 'input'` so defaults and coercions are described as the caller may send
 * them, not as they come out the far side: an agent building an args object
 * needs to know `easing` is optional, not that it is always present after
 * parsing.
 */
export function argsSchemaOf(cap: Capability): unknown {
  return z.toJSONSchema(cap.args, { io: 'input', unrepresentable: 'any' })
}

/**
 * JSON Schema for one capability's `data`, on the capabilities that declare it.
 *
 * `io: 'output'` here, the mirror of `argsSchemaOf` — this describes what comes
 * back rather than what may be sent, so a field with a default is *present*,
 * and a caller writing `result["scenes"]` should be told so.
 */
export function resultSchemaOf(cap: Capability): unknown {
  if (!cap.result) return undefined
  return z.toJSONSchema(cap.result, { io: 'output', unrepresentable: 'any' })
}
