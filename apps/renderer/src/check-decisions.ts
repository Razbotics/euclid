/**
 * Agent → human → agent question loop, end to end.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-decisions.ts
 *
 * Free — no credits. Needs `dev:api`, `dev:mcp` and `dev:web`.
 *
 * The whole point of routing questions through the project rather than the
 * chat is that the human answers where they can see the video. So this drives
 * the real loop: the agent asks over MCP, a browser receives it live over the
 * WebSocket, a human clicks a button, and the agent reads the answer back.
 */
import './load-env'
import assert from 'node:assert'
import { chromium } from 'playwright'

const MCP_URL = process.env.MCP_URL ?? 'http://localhost:8788/mcp'
const WEB_URL = process.env.WEB_URL ?? 'http://localhost:5173'
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
console.log(`project ${project.id}`)

// Editor is opened BEFORE the question is asked, so arrival must come over the
// WebSocket rather than the initial fetch — that is what is being tested.
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const errors: string[] = []
page.on('pageerror', (e) => errors.push(String(e.message)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
await page.goto(`${WEB_URL}/?project=${project.id}`, { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)
assert.equal(
  await page.evaluate(() => document.querySelector('.decision') !== null),
  false,
  'no questions yet, so no panel',
)

// ---------- 1. agent asks ----------
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
const decisionId = asked.match(/asked \(([^)]+)\)/)![1]!
console.log(`asked ${decisionId}`)

// ---------- 2. it reaches the open editor live ----------
await page.waitForSelector('.decision.open', { timeout: 6000 })
const shown = await page.evaluate(() => ({
  question: document.querySelector('.decision-question')?.textContent ?? null,
  detail: document.querySelector('.decision-detail')?.textContent ?? null,
  options: Array.from(document.querySelectorAll('.decision-options button')).map(
    (b) => b.childNodes[0]?.textContent?.trim() ?? '',
  ),
  badge: document.querySelector('.decision-badge')?.textContent ?? null,
  seek: document.querySelector('.decision-seek')?.textContent ?? null,
}))
console.log('editor shows:', JSON.stringify(shown, null, 2))
assert.match(shown.question!, /overruns this scene/, 'question text arrived over the WebSocket')
assert.deepEqual(shown.options, ['Extend the scene', 'Shorten the script', 'Let it cut'])
assert.match(shown.badge!, /waiting/, 'open questions are counted')
assert.match(shown.seek!, /4\.2s/, 'a question about a moment offers to seek there')

// A long question must not widen the side column and squeeze the canvas.
// This is a layout regression that throws no error and looks like nothing is
// wrong until you notice the video is a sliver — so it is asserted, not eyeballed.
await call('ask_user', {
  projectId: project.id,
  question:
    'Should the end card hold in silence after the last words, and if so for how long, ' +
    'given the finale narration ends mid-phrase and the scene currently cuts the tail?',
  detail: 'A deliberately long question, to keep the side panel from stretching across the window.',
  options: [{ label: 'Tight — about one second' }, { label: 'Contemplative — four seconds or so' }],
})
await page.waitForTimeout(500)
const layout = await page.evaluate(() => {
  const canvas = document.querySelector('canvas')?.getBoundingClientRect()
  const side = document.querySelector('.side')?.getBoundingClientRect()
  return { canvasW: canvas?.width ?? 0, sideW: side?.width ?? 0, viewport: window.innerWidth }
})
console.log('layout:', JSON.stringify(layout))
assert.ok(
  layout.sideW > 0 && layout.sideW < layout.viewport * 0.35,
  `side panel must stay a column, got ${layout.sideW}px of ${layout.viewport}px`,
)
assert.ok(
  layout.canvasW > layout.viewport * 0.5,
  `canvas must keep most of the width, got ${layout.canvasW}px of ${layout.viewport}px`,
)

// The agent must see it as still open while waiting.
assert.match(await call('get_answer', { projectId: project.id, decisionId }), /^\[open\]/m)

// ---------- 3. the human answers in the editor ----------
await page.locator('.decision-options button').first().click()
await page.waitForSelector('.decision.answered', { timeout: 6000 })
await page.screenshot({ path: '/tmp/decision-answered.png' })

// ---------- 4. the agent reads it back ----------
const answer = await call('get_answer', { projectId: project.id, decisionId })
console.log('agent sees:', answer.split('\n').filter((l) => l.includes('answered')).join(''))
assert.match(answer, /^\[answered\]/m, 'agent sees the resolved status')
assert.match(answer, /answered via editor: Extend the scene/, 'agent sees which option and where from')

// ---------- 5. answering twice is refused, not silently overwritten ----------
await assert.rejects(
  () => call('record_answer', { projectId: project.id, decisionId, optionId: 'opt2' }),
  /already_answered/,
  'a second answer must be rejected — two surfaces can answer at once',
)

// ---------- 6. the chat path: agent relays what the human told it ----------
const second = await call('ask_user', {
  projectId: project.id,
  question: 'Should the end card hold longer?',
  options: [{ label: 'Yes' }, { label: 'No' }],
})
const secondId = second.match(/asked \(([^)]+)\)/)![1]!
const relayed = await call('record_answer', {
  projectId: project.id,
  decisionId: secondId,
  note: 'hold it about two seconds longer',
})
assert.match(relayed, /answered via agent/, 'provenance distinguishes chat answers from editor ones')
assert.match(relayed, /hold it about two seconds/, 'free-text answers are kept verbatim')

// It must reach the editor too, so the human sees what the agent recorded.
await page.waitForFunction(
  () => document.querySelectorAll('.decision.answered').length === 2,
  null,
  { timeout: 6000 },
)

// ---------- 7. bad input is rejected ----------
await assert.rejects(
  () => call('ask_user', { projectId: project.id, question: 'One option only?', options: [{ label: 'Yes' }] }),
  'a single option is not a choice',
)

const all = await call('get_answer', { projectId: project.id })
assert.equal((all.match(/^\[answered\]/gm) ?? []).length, 2, 'the two answered questions are listed as answered')

await browser.close()
if (errors.length) {
  console.error('PAGE ERRORS:\n' + errors.join('\n'))
  process.exit(1)
}
console.log('decisions OK — asked over MCP, arrived live in the editor, answered by click, read back by the agent; chat-relay and double-answer paths correct')
