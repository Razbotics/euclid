/**
 * MCP tool surface, driven the way a real client drives it.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-mcp-tools.ts
 *
 * Free — no credits. Needs `dev:api` and `dev:mcp` running.
 *
 * Exists because of a bug the Phase 5 milestone hit: `animate`'s `to` param is
 * union-typed, which becomes `anyOf` in the tool's JSON Schema, and at least
 * one real MCP client sends such values as strings. `1.12` arrived as "1.12"
 * and failed validation, forcing the agent to bypass its own tools. Typecheck
 * cannot catch that — only calling the worker the way a client does can.
 */
import './load-env'
import assert from 'node:assert'

const MCP_URL = process.env.MCP_URL ?? 'http://localhost:8788/mcp'
const API_URL = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'

const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
let sessionId: string | null = null
let rpcId = 0

/**
 * Streamable HTTP: the worker answers over SSE and keeps the stream open for
 * ~10s after sending the response event. `await res.text()` therefore blocks
 * for that whole window — 15 calls would take two and a half minutes and look
 * exactly like a hang. A real client reads the first `data:` event and stops,
 * which is what this does.
 */
async function rpc(method: string, params?: unknown): Promise<Record<string, any>> {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: sessionId ? { ...HEADERS, 'mcp-session-id': sessionId } : HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  sessionId ??= res.headers.get('mcp-session-id')
  if (!res.body) return JSON.parse(await res.text())

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      // Only consume newline-terminated lines: a chunk can split mid-JSON
      // ("data: {\"jsonr"), and parsing that fragment throws.
      let nl: number
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, nl)
        buffered = buffered.slice(nl + 1)
        if (line.startsWith('data: ')) return JSON.parse(line.slice(6))
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return JSON.parse(buffered)
}

/** Returns the tool's text, or throws with the validation error a client would see. */
async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await rpc('tools/call', { name, arguments: args })
  if (r.error) throw new Error(`${name}: ${r.error.message}`)
  const text = r.result?.content?.[0]?.text ?? ''
  if (r.result?.isError) throw new Error(`${name}: ${text}`)
  return text
}

console.log('connecting to', MCP_URL)
const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'check-mcp-tools', version: '0' },
})
assert.equal(init.result?.serverInfo?.name, 'euclid', 'MCP worker should identify as euclid')
await fetch(MCP_URL, {
  method: 'POST',
  headers: { ...HEADERS, 'mcp-session-id': sessionId! },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
})

console.log('initialized')

// ---------- the surface itself ----------
const tools = (await rpc('tools/list')).result.tools as { name: string; description: string }[]
const names = tools.map((t) => t.name)
for (const required of ['animate', 'update_scene', 'generate_narration', 'set_narration', 'render_video']) {
  assert.ok(names.includes(required), `tool ${required} must be registered`)
}
// Credit-spending tools must say so — the agent decides what to call from this text alone.
for (const paid of ['generate_narration', 'render_video']) {
  assert.match(
    tools.find((t) => t.name === paid)!.description,
    /COSTS CREDITS/,
    `${paid} must announce that it spends credits`,
  )
}

console.log(`${tools.length} tools listed`)
const project = JSON.parse(await call('create_project', { name: 'MCP Tool Check' })) as { id: string }
const sceneId = (await call('add_scene', { projectId: project.id, name: 'S', duration: 5 })).match(
  /scene (\S+)/,
)![1]!
const nodeId = (
  await call('add_text', { projectId: project.id, sceneId, textContent: 'hi', x: 960, y: 540 })
).match(/node (\S+)/)![1]!

console.log('fixture ready:', project.id)

// ---------- animate: union-typed `to` ----------
const animate = (property: string, to: unknown) =>
  call('animate', { projectId: project.id, sceneId, nodeId, property, to, start: 0, duration: 1 })

// Accepted: native forms, and the stringified forms a real client sends.
await animate('opacity', 1.12)
await animate('opacity', '1.12')
await animate('position', { x: 100, y: 200 })
await animate('position', { x: '100', y: '200' })
await animate('fill', '#ff0000')
await animate('rotation', '-0.5')

console.log('accepted forms OK')

// Rejected: a colour must not be coerced to a number, and nonsense must not
// become 0. This is why the fix is a regex, not z.coerce.number().
for (const bad of ['abc', '', true, null, []]) {
  await assert.rejects(
    () => animate('opacity', bad),
    `animate should reject ${JSON.stringify(bad)} rather than coerce it`,
  )
}

console.log('rejected forms OK')

// ---------- what actually landed in the document ----------
// The real risk of coercion is a string reaching a keyframe, where the sampler
// would interpolate it as NaN and fail silently at render time.
const docRes = await fetch(`${API_URL}/api/projects/${project.id}/doc`, {
  headers: { 'x-internal-key': KEY, 'x-user-id': 'dev-user' },
})
const { doc } = (await docRes.json()) as {
  doc: { scenes: { nodes: { tracks: { property: string; keyframes: { value: unknown }[] }[] }[] }[] }
}
const tracks = doc.scenes[0]!.nodes[0]!.tracks
const byProp = Object.fromEntries(tracks.map((t) => [t.property, t.keyframes.at(-1)!.value]))

assert.strictEqual(byProp.opacity, 1.12, 'stringified number must be stored as a number')
assert.deepStrictEqual(byProp.position, { x: 100, y: 200 }, 'stringified coords must be stored as numbers')
assert.strictEqual(typeof (byProp.position as { x: unknown }).x, 'number', 'x must not stay a string')
assert.strictEqual(byProp.fill, '#ff0000', 'colours must stay strings, not be coerced')
assert.strictEqual(byProp.rotation, -0.5, 'negative stringified numbers must parse')

console.log(
  `mcp tools OK — ${tools.length} registered; animate accepts native and stringified ` +
    `numbers/coords, rejects "abc"/""/true/null/[], and stores real numbers in the document`,
)
