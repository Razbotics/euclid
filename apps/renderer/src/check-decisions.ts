/**
 * Agent → human → agent question loop.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-decisions.ts
 *
 * Free — no credits. Needs `dev:api`, `dev:mcp`, and `render-worker.ts` (the
 * composition-review section captures real frames). Deliberately no browser:
 * chat is the surface a question is asked on and the system may run headless,
 * so this drives the loop the way a shell-less client would — which is also
 * why the contact sheet has to travel as a content block rather than as
 * something the human is told to go and look at.
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

const PREVIEW = process.env.PREVIEW_ORIGIN ?? 'http://localhost:8790'
if (!(await fetch(`${PREVIEW}/health`).catch(() => null))?.ok) {
  console.error(
    `preview backend not running at ${PREVIEW} — the composition-review section captures ` +
      `real frames.\n  pnpm --filter @euclid/renderer exec tsx src/render-worker.ts`,
  )
  process.exit(1)
}

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

type Block = { type: string; text?: string; data?: string; mimeType?: string }

/** Every content block, for the calls whose point is that there are two. */
async function callBlocks(name: string, args: Record<string, unknown>): Promise<Block[]> {
  const r = await rpc('tools/call', { name, arguments: args })
  if (r.error) throw new Error(`${name}: ${r.error.message}`)
  const blocks = (r.result?.content ?? []) as Block[]
  if (r.result?.isError) throw new Error(`${name}: ${blocks[0]?.text ?? ''}`)
  return blocks
}

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  return (await callBlocks(name, args))[0]?.text ?? ''
}

/**
 * Run a catalog capability. Only `ask_user` is still a tool of its own — it is
 * a protocol act, not a request/response call — so everything else, including
 * the `record_answer` that closes a question, goes through the executor.
 */
const run = (name: string, args: Record<string, unknown>) => call('execute', { name, args })

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
const toolNames = tools.map((x) => x.name)
// Asking stays native; answering does not. Elicitation is a server→client
// request and the fallback controls the agent's next reply, neither of which
// survives being flattened into `execute`.
assert.ok(toolNames.includes('ask_user'), 'ask_user must stay a tool of its own')
assert.ok(toolNames.includes('execute'), 'record_answer is reached through execute')
// get_answer was removed: polling had no path left once ask_user either
// elicited the answer or told the agent to relay it. Its absence is asserted
// so it cannot drift back in as a "cheap to keep" convenience.
assert.ok(!toolNames.includes('get_answer'), 'get_answer should be gone')

/** Read decisions straight from the API — the state the tools write to. */
const decisions = async (): Promise<any[]> => {
  const r = await fetch(`${API_URL}/api/projects/${project.id}/decisions`, {
    headers: { 'x-internal-key': KEY, 'x-user-id': 'dev-user' },
  })
  assert.ok(r.ok, `decisions fetch failed: ${r.status}`)
  return ((await r.json()) as { decisions: any[] }).decisions
}

const project = {
  id: (await run('create_project', { name: 'Decision Check' })).match(/created project (\S+)/)![1]!,
}
const sceneOne = (await run('add_scene', { projectId: project.id, name: 'One', duration: 6 }))
  .match(/scene (\S+)/)![1]!

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
// The instruction has to name the tool that actually exists now.
assert.match(asked, /execute\(name="record_answer"\)/, 'it names how to close the question')
// With get_answer gone, record_answer is the only thing that closes a
// question and nothing will chase it — so the result has to say that
// continuing regardless is a decision, not an oversight.
assert.match(asked, /Nothing else closes this question/, 'it names the only way to close it')
assert.match(asked, /decided it yourself/, 'it names the cost of continuing without an answer')

const decisionId = asked.match(/STOP — WAITING ON THE HUMAN \(([^)]+)\)/)![1]!
console.log(`asked ${decisionId}`)

// ---------- 2. the question is open and stored ----------
const open = (await decisions()).find((d) => d.id === decisionId)
assert.equal(open.status, 'open', 'the question is recorded as open')
assert.equal(open.options.length, 3, 'options are stored with it')

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

const settled = (await decisions()).find((d) => d.id === decisionId)
assert.equal(settled.status, 'answered', 'the answer is recorded')
assert.equal(settled.answer.optionId, 'opt1', 'the chosen option is kept')
assert.equal(settled.answer.via, 'editor', 'provenance says which surface answered')

// ---------- 4. answering twice is refused ----------
await assert.rejects(
  () => run('record_answer', { projectId: project.id, decisionId, optionId: 'opt2' }),
  /already answered/,
  'a second answer must be rejected, not silently overwrite',
)

// ---------- 5. the chat path: the agent relays what it was told ----------
const second = await call('ask_user', {
  projectId: project.id,
  question: 'Should the end card hold longer?',
  options: [{ label: 'Yes' }, { label: 'No' }],
})
const secondId = second.match(/STOP — WAITING ON THE HUMAN \(([^)]+)\)/)![1]!
const relayed = await run('record_answer', {
  projectId: project.id,
  decisionId: secondId,
  note: 'hold it about two seconds longer',
})
// `agent` provenance is the point: this answer is the agent's interpretation,
// unlike an elicited (`chat`) or clicked (`editor`) one.
assert.match(relayed, /answered via agent/, 'a relayed answer is marked as such')
assert.match(relayed, /hold it about two seconds/, 'free text is kept verbatim')

// ---------- 5b. a composition question carries its frames (plans/011 gap 5) ----------
// `request_review` puts assets in front of the human; what run 8 needed eyes on
// was the composition, and the contact sheet reached them only by being
// described in chat. So a question about how something LOOKS now carries the
// picture — and the assertion is that both halves travel, because a question
// with no image is exactly the failure this closes.
await run('add_text', {
  projectId: project.id, sceneId: sceneOne, text: 'composition', x: 960, y: 540,
})
const composed = await callBlocks('ask_user', {
  projectId: project.id,
  question: 'Does the title sit right against the diagram?',
  options: [{ label: 'Yes, keep it' }, { label: 'Move it up' }],
  previewAt: [0.5, 2, 4],
})
const composedText = composed[0]?.text ?? ''
assert.equal(composed.length, 2, `a previewAt question returns text AND an image: ${composedText}`)
assert.equal(composed[0]!.type, 'text', 'the caption comes first — an image cannot say which tile is which')
assert.equal(composed[1]!.type, 'image', 'and the contact sheet rides beside it')
assert.equal(composed[1]!.mimeType, 'image/png')
assert.ok((composed[1]!.data?.length ?? 0) > 2000, 'the sheet must be a real capture, not an empty PNG')
// The block a human reads has to place the frames in the video; a tile they
// cannot locate is a tile they cannot judge.
assert.match(composedText, /Frames above are at 0\.5s, 2\.0s, 4\.0s/, 'the block names the moments')
assert.match(composedText, /contact sheet is attached/, 'and tells the agent not to describe it away')

// The decision stores the moments, so the editor can scrub there — the surface
// where a human answers with their eyes, and the one a contact sheet cannot be.
const composedId = composedText.match(/STOP — WAITING ON THE HUMAN \(([^)]+)\)/)![1]!
const stored = (await decisions()).find((d) => d.id === composedId)
assert.deepStrictEqual(stored.refs.previewAt, [0.5, 2, 4], 'the moments are stored on the decision')
// ...and nothing else. previewAt is the one ref with no consequence: the
// others change what answering DOES, this only changes what is being looked at.
assert.ok(!stored.refs.planId, 'a preview ref must not look like a plan approval')
assert.ok(!stored.refs.assetIds, 'nor like an asset review')
await run('record_answer', { projectId: project.id, decisionId: composedId, optionId: 'opt1' })

// A capture that fails must REFUSE, not quietly ask a question about pixels
// with no pixels — that would put the human back to hunting for the frames
// without saying so, which is the whole thing this closes. A project with no
// scenes is the cheapest way to make the capture fail for a real reason.
const emptyProject = (await run('create_project', { name: 'Nothing To See' }))
  .match(/created project (\S+)/)![1]!
await assert.rejects(
  () =>
    call('ask_user', {
      projectId: emptyProject,
      question: 'How does this look?',
      options: [{ label: 'Fine' }, { label: 'Not fine' }],
      previewAt: [0.5],
    }),
  /could not capture the frames/,
  'a question about pixels is refused rather than asked without them',
)
// ...and refused BEFORE the decision exists, so there is no orphan question
// sitting open against a capture that never happened.
const emptyDecisions = await (async () => {
  const r = await fetch(`${API_URL}/api/projects/${emptyProject}/decisions`, {
    headers: { 'x-internal-key': KEY, 'x-user-id': 'dev-user' },
  })
  return ((await r.json()) as { decisions: any[] }).decisions
})()
assert.equal(emptyDecisions.length, 0, 'a failed capture must leave no decision behind')
await run('delete_project', { projectId: emptyProject, confirm: true })

// ---------- 6. bad input ----------
await assert.rejects(
  () => call('ask_user', { projectId: project.id, question: 'One option?', options: [{ label: 'Yes' }] }),
  'a single option is not a choice',
)

const all = await decisions()
assert.equal(all.filter((d) => d.status === 'answered').length, 3, 'all three questions are answered')
assert.deepEqual(
  all.map((d) => d.answer.via).sort(),
  // Two relays and one editor click: the composition question was also closed
  // through record_answer, so it carries `agent` provenance like any other
  // answer the agent interpreted rather than the human clicked.
  ['agent', 'agent', 'editor'],
  'the answers keep distinct provenance',
)

// Passing runs leave nothing behind; a failure keeps the fixture to inspect.
await run('delete_project', { projectId: project.id, confirm: true })

console.log(
  'decisions OK — pasteable block asked over MCP (native ask_user), stored open, editor ' +
    'endpoint and chat relay answer with distinct provenance via execute(record_answer), ' +
    'double-answer refused, get_answer gone. A composition question carries its frames: ' +
    'text AND image blocks, the moments named in the block and stored on the decision as a ' +
    'ref with no consequence, and a failed capture refuses without leaving a question open',
)
