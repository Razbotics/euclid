import { z } from 'zod'
import { spatialTools } from './tools-3d'
import { animTools } from './tools-anim'
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
]

const BY_NAME = new Map(ALL.map((c) => [c.name, c]))

if (BY_NAME.size !== ALL.length) {
  throw new Error('duplicate capability name in the catalog')
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
