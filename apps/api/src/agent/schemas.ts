import { z } from 'zod'

export const PROJECT_ID = z.string().min(1).describe('project id from create_project/list_projects')
export const SCENE_ID = z.string().min(1).describe('scene id, e.g. sc_1a2b3c4d')
export const NODE_ID = z.string().min(1).describe('node id, e.g. eq_1a2b3c4d')

export const COLOR = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a hex colour like #58c4dd')

export const EASING = z
  .enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'smooth'])
  .default('smooth')

/**
 * A number, or a string that is unambiguously one.
 *
 * Kept from the MCP layer even though args no longer travel as a typed tool
 * schema: the habit that caused it is the client's, not the schema's. A real
 * client sent `1.12` as `"1.12"`, which a plain `z.number()` rejected and which
 * forced an agent to bypass its own tools.
 *
 * Deliberately a regex rather than `z.coerce.number()`: coercion accepts `""`,
 * `true`, `null` and `[]` as 0 or 1, which would animate to a silently wrong
 * value instead of reporting a bad argument.
 */
export const NUMBERISH = z.union([
  z.number(),
  z
    .string()
    .regex(/^-?(\d+\.?\d*|\.\d+)$/)
    .transform(Number),
])

export const SECONDS = z.number().min(0).describe('scene-local seconds')
