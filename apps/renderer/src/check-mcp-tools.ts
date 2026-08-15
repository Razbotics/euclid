/**
 * MCP surface, driven the way a real client drives it.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-mcp-tools.ts
 *
 * Free — no credits. Needs `dev:api` and `dev:mcp`.
 *
 * The surface is now a gateway (plans/008): five fixed tools over the API
 * worker's capability catalog. So what this proves has shifted. It is no longer
 * "are the 26 tools registered" but the two claims the gateway is built on:
 *
 *  1. The tool list is small and STABLE — no capability may leak back in as a
 *     tool of its own, or the client-restart problem returns.
 *  2. Nothing was lost in the move. `animate`'s argument coercion is checked
 *     here rather than only in check-gateway because the bug it exists for was
 *     a *client* behaviour — a real MCP client sending `1.12` as "1.12" — and
 *     only driving the worker over JSON-RPC exercises that path end to end.
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

/** Returns the tool's text, or throws with the error a client would see. */
async function tool(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await rpc('tools/call', { name, arguments: args })
  if (r.error) throw new Error(`${name}: ${r.error.message}`)
  const text = r.result?.content?.[0]?.text ?? ''
  if (r.result?.isError) throw new Error(`${name}: ${text}`)
  return text
}

/** Run a free capability through the gateway's executor. */
const run = (name: string, args: Record<string, unknown>) => tool('execute', { name, args })

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

// ---------- the surface must stay small and stable ----------
const tools = (await rpc('tools/list')).result.tools as { name: string; description: string }[]
const names = tools.map((t) => t.name).sort()
assert.deepStrictEqual(
  names,
  ['ask_user', 'describe', 'execute', 'execute_paid', 'instructions'],
  'the gateway must expose exactly these five tools — a capability leaking back in as its ' +
    'own tool would reinstate the client-restart problem the gateway exists to remove',
)

// The bootstrap has to be discoverable from the tool list alone: nothing forces
// a client to call `instructions`, so the descriptions must say to.
assert.match(
  tools.find((t) => t.name === 'instructions')!.description,
  /READ THIS FIRST/,
  'instructions must announce itself as the first call of a thread',
)
// Credit-spending work must be visible as such from the tool list, because
// that list is what a permission prompt is built from.
assert.match(
  tools.find((t) => t.name === 'execute_paid')!.description,
  /SPENDS CREDITS/,
  'execute_paid must announce that it spends credits',
)
console.log(`${tools.length} tools listed — ${names.join(', ')}`)

// ---------- tool 1: the capability list arrives through MCP ----------
const instructions = await tool('instructions', {})
for (const required of ['create_project', 'animate', 'morph_latex', 'render_video']) {
  assert.ok(instructions.includes(required), `instructions must list ${required}`)
}
assert.match(instructions, /execute_paid/, 'instructions must route paid work correctly')

// ---------- tool 2: describe reaches the catalog prose ----------
const described = await tool('describe', { names: ['animate', 'update_node'] })
assert.match(described, /sampled from the document/, 'animate keeps its start-value contract')
assert.match(described, /the track wins/, 'update_node keeps the shadowing warning')

// ---------- tool 3: execute, with the argument coercion that forced it ----------
// Every capability answers in compact text, so the ids come out of the lines
// they return — which is itself worth checking: an agent has nothing else.
const projectId = (await run('create_project', { name: 'MCP Gateway Check' })).match(
  /created project (\S+)/,
)![1]!
const sceneId = (await run('add_scene', { projectId, name: 'S', duration: 5 })).match(
  /scene (\S+)/,
)![1]!
const nodeId = (
  await run('add_text', { projectId, sceneId, textContent: 'hi', x: 960, y: 540 })
).match(/node (\S+)/)![1]!

console.log('fixture ready:', projectId)

const animate = (property: string, to: unknown) =>
  run('animate', { projectId, sceneId, nodeId, property, to, start: 0, duration: 1 })

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

// ---------- the credit gate, over the wire ----------
// A standing approval on `execute` must not be able to spend anything.
await assert.rejects(
  () => run('render_video', { projectId }),
  /execute_paid/,
  'a paid capability must refuse the free executor and name the paid one',
)

// ---------- what actually landed in the document ----------
// The real risk of coercion is a string reaching a keyframe, where the sampler
// would interpolate it as NaN and fail silently at render time.
const docRes = await fetch(`${API_URL}/api/projects/${projectId}/doc`, {
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

// Passing runs leave nothing behind; a failure keeps the fixture to inspect.
await run('delete_project', { projectId, confirm: true })

console.log(
  `mcp gateway OK — 5 stable tools; instructions and describe reach the catalog, execute ` +
    `accepts native and stringified numbers/coords, rejects "abc"/""/true/null/[], stores real ` +
    `numbers in the document, and refuses to spend credits`,
)
