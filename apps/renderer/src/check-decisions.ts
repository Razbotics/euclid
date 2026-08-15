/**
 * Agent → human → agent question loop.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-decisions.ts
 *
 * Free — no credits. Needs `dev:api` and `dev:mcp`. Deliberately no browser:
 * chat is the surface a question is asked on and the system may run headless,
 * so this drives the loop the way a shell-less client would.
 *
 * The editor's answer endpoint is still exercised directly. It remains a
 * valid surface for anyone with a browser open; it just isn't where the
 * asking happens, and no UI mirrors questions any more.
 */
import './load-env'
import assert from 'node:assert'

const MCP_URL = process.env.MCP_URL ?? 'http://localhost:8788/mcp'
const API_URL = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
let sessionId: string | null = null
let rpcId = 0

/** Reads the first SSE `data:` event; the worker holds the stream open ~10s. */
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

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await rpc('tools/call', { name, arguments: args })
  if (r.error) throw new Error(`${name}: ${r.error.message}`)
  const t = r.result?.content?.[0]?.text ?? ''
  if (r.result?.isError) throw new Error(`${name}: ${t}`)
  return t
}

await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'check-decisions', version: '0' },
})
await fetch(MCP_URL, {
  method: 'POST',
  headers: { ...HEADERS, 'mcp-session-id': sessionId! },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
})

const tools = (await rpc('tools/list')).result.tools as { name: string }[]
for (const t of ['ask_user', 'get_answer', 'record_answer']) {
  assert.ok(tools.map((x) => x.name).includes(t), `${t} must be registered`)
}

const project = JSON.parse(await call('create_project', { name: 'Decision Check' })) as { id: string }
await call('add_scene', { projectId: project.id, name: 'One', duration: 6 })

// ---------- 1. the agent asks ----------
const asked = await call('ask_user', {
  projectId: project.id,
  question: 'The narration overruns this scene by 1.9s. How should I resolve it?',
  detail: 'Speech runs 3.2s; the scene is 1.3s.',
  options: [
    { label: 'Extend the scene', detail: 'grow it to 3.2s so nothing is cut' },
    { label: 'Shorten the script', detail: 'rewrite and regenerate — costs credits' },
    { label: 'Let it cut', detail: 'keep the timing, lose the tail' },
  ],
  atSec: 4.2,
})

// This client doesn't advertise elicitation, so it must get the fallback —
// the path that has to keep working everywhere, including headless.
assert.match(asked, /STOP — WAITING ON THE HUMAN/, 'the result instructs, it does not just receipt')
assert.match(asked, /NEXT reply/, 'it says to relay the question immediately')
assert.match(asked, /do not (continue building|pick a default)/i, 'it forbids guessing on')
// The block has to be written for a human to answer, not for the agent to file.
assert.match(asked, /Reply with a number/, 'the block is answerable in chat')
for (const label of ['Extend the scene', 'Shorten the script', 'Let it cut']) {
  assert.ok(asked.includes(label), `the pasteable block names option "${label}"`)
}
assert.match(asked, /1→opt1/, 'it maps reply numbers back to option ids for record_answer')
assert.match(asked, /headless/, 'it warns not to wait on a browser')

const decisionId = asked.match(/STOP — WAITING ON THE HUMAN \(([^)]+)\)/)![1]!
console.log(`asked ${decisionId}`)

// ---------- 2. polling keeps saying "blocked" ----------
// Quietly returning [open] and letting the agent carry on is the same failure
// as never asking, one step later.
const polled = await call('get_answer', { projectId: project.id, decisionId })
assert.match(polled, /^\[open\]/m, 'the question reads as open')
assert.match(polled, /STILL WAITING on \d+ question/, 'polling repeats that it is blocking')

// ---------- 3. the editor surface still answers ----------
const viaEditor = await fetch(
  `${API_URL}/api/projects/${project.id}/decisions/${decisionId}/answer`,
  {
    method: 'POST',
    headers: { 'x-internal-key': KEY, 'x-user-id': 'dev-user', 'content-type': 'application/json' },
    body: JSON.stringify({ optionId: 'opt1', via: 'editor' }),
  },
)
assert.ok(viaEditor.ok, `editor answer endpoint failed: ${viaEditor.status}`)

const answer = await call('get_answer', { projectId: project.id, decisionId })
assert.match(answer, /^\[answered\]/m, 'the agent sees the resolved status')
assert.match(answer, /answered via editor: Extend the scene/, 'which option, and from where')
assert.ok(!/STILL WAITING/.test(answer), 'nothing blocks once it is answered')

// ---------- 4. answering twice is refused ----------
await assert.rejects(
  () => call('record_answer', { projectId: project.id, decisionId, optionId: 'opt2' }),
  /already_answered/,
  'a second answer must be rejected, not silently overwrite',
)

// ---------- 5. the chat path: the agent relays what it was told ----------
const second = await call('ask_user', {
  projectId: project.id,
  question: 'Should the end card hold longer?',
  options: [{ label: 'Yes' }, { label: 'No' }],
})
const secondId = second.match(/STOP — WAITING ON THE HUMAN \(([^)]+)\)/)![1]!
const relayed = await call('record_answer', {
  projectId: project.id,
  decisionId: secondId,
  note: 'hold it about two seconds longer',
})
// `agent` provenance is the point: this answer is the agent's interpretation,
// unlike an elicited (`chat`) or clicked (`editor`) one.
assert.match(relayed, /answered via agent/, 'a relayed answer is marked as such')
assert.match(relayed, /hold it about two seconds/, 'free text is kept verbatim')

// ---------- 6. bad input ----------
await assert.rejects(
  () => call('ask_user', { projectId: project.id, question: 'One option?', options: [{ label: 'Yes' }] }),
  'a single option is not a choice',
)

const all = await call('get_answer', { projectId: project.id })
assert.equal((all.match(/^\[answered\]/gm) ?? []).length, 2, 'both questions read as answered')

console.log(
  'decisions OK — pasteable block asked over MCP, polling stays blocking, editor endpoint ' +
    'and chat relay answer with distinct provenance, double-answer refused',
)
