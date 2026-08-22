/**
 * Dev check: editor ↔ backend live sync. Opens the editor on a real project,
 * then mutates the doc from OUTSIDE the browser (like the MCP agent does) and
 * asserts the change appears via the WebSocket without a reload.
 *   pnpm --filter @euclid/renderer exec tsx src/check-live.ts <projectId>
 */
import './load-env'
import { chromium } from 'playwright'

const projectId = process.argv[2]
if (!projectId) throw new Error('usage: check-live.ts <projectId>')
const API = process.env.API_URL ?? 'http://localhost:8787'
const HEADERS = {
  'content-type': 'application/json',
  'x-internal-key': process.env.INTERNAL_API_KEY ?? 'dev-internal-key',
  'x-user-id': 'dev-user',
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const errors: string[] = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(`http://localhost:5173/?project=${projectId}`, { waitUntil: 'networkidle' })

const name = await page.locator('.project-name').textContent()
console.log(`loaded project: "${name}"`)
if (await page.locator('.badge.offline').count()) throw new Error('editor fell back to offline demo')

// external mutation, as the agent would do it
const { version } = (await (await fetch(`${API}/api/projects/${projectId}/doc`, { headers: HEADERS })).json()) as {
  version: number
}
const newName = `Live Sync ${version}`
const res = await fetch(`${API}/api/projects/${projectId}/ops`, {
  method: 'POST',
  headers: HEADERS,
  body: JSON.stringify({
    id: crypto.randomUUID(),
    baseVersion: version,
    actor: { type: 'agent', id: 'check-live' },
    ops: [{ kind: 'project.rename', name: newName }],
  }),
})
if (!res.ok) throw new Error(`ops rejected: ${await res.text()}`)

await page.locator('.project-name', { hasText: newName }).waitFor({ timeout: 5000 })
console.log(`rename arrived over WebSocket: "${newName}"`)

/**
 * ...and so does an undo (plans/011 gap 4).
 *
 * `revert_to_version` claims every open editor sees it immediately. That is
 * only true because a restore is an *op*: it rides the same broadcast and the
 * editor puts it through the same shared reducer, with no code in the editor
 * that knows undo exists. This is the check that the claim is real rather than
 * a reasonable-sounding consequence — a revert that left an open editor
 * showing a document the server no longer has is the failure mode.
 */
const atName = (await (await fetch(`${API}/api/projects/${projectId}/doc`, { headers: HEADERS })).json()) as {
  version: number
}
const laterName = `Live Sync ${atName.version} (later)`
await fetch(`${API}/api/projects/${projectId}/ops`, {
  method: 'POST',
  headers: HEADERS,
  body: JSON.stringify({
    id: crypto.randomUUID(),
    baseVersion: atName.version,
    actor: { type: 'agent', id: 'check-live' },
    ops: [{ kind: 'project.rename', name: laterName }],
  }),
})
await page.locator('.project-name', { hasText: laterName }).waitFor({ timeout: 5000 })

const revert = await fetch(`${API}/api/projects/${projectId}/revert`, {
  method: 'POST',
  headers: HEADERS,
  body: JSON.stringify({ version: atName.version, actor: { type: 'agent', id: 'check-live' } }),
})
if (!revert.ok) throw new Error(`revert rejected: ${await revert.text()}`)
// Back to the previous name, live, with no reload — and the editor never
// learned what a revert is.
await page.locator('.project-name', { hasText: newName }).waitFor({ timeout: 5000 })
console.log(`revert arrived over WebSocket too: "${laterName}" → "${newName}", no reload`)

await page.screenshot({ path: 'editor-live.png' })
await browser.close()

if (errors.length) {
  console.error('page errors:\n' + errors.join('\n'))
  process.exit(1)
}
console.log('live sync OK — wrote editor-live.png')
