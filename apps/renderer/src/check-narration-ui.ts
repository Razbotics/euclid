/**
 * Editor narration preview: audio loads, captions render, overrun is offered a fix.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-narration-ui.ts
 *
 * SPENDS CREDITS (two short TTS calls). Needs a running API and web dev server.
 *
 * The load assertion is the point: narration audio is served from a different
 * origin than the editor and is owner-scoped, so the <audio> elements carry
 * crossOrigin="use-credentials". If CORS or the cookie path is wrong the
 * element fails silently — the UI looks fine and simply never makes a sound.
 */
import './load-env'
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { op } from '@euclid/dsl'

const API_URL = process.env.API_URL ?? 'http://localhost:8787'
const WEB_URL = process.env.WEB_URL ?? 'http://localhost:5173'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const USER = 'dev-user'
const as = { 'x-internal-key': KEY, 'x-user-id': USER, 'content-type': 'application/json' }

async function jsonOrThrow<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

execFileSync('pnpm', [
  'exec', 'wrangler', 'd1', 'execute', 'euclid', '--local', '--command',
  `INSERT INTO credits (user_id, balance) VALUES ('${USER}', 1000)
   ON CONFLICT(user_id) DO UPDATE SET balance = 1000`,
], { cwd: new URL('../../api', import.meta.url).pathname, stdio: 'pipe' })

const { id: projectId } = await jsonOrThrow<{ id: string }>(
  await fetch(`${API_URL}/api/projects`, {
    method: 'POST', headers: as, body: JSON.stringify({ name: 'Narration UI Check' }),
  }),
  'create project',
)

const { version } = await jsonOrThrow<{ version: number }>(
  await fetch(`${API_URL}/api/projects/${projectId}/doc`, { headers: as }),
  'get doc',
)
await jsonOrThrow(
  await fetch(`${API_URL}/api/projects/${projectId}/ops`, {
    method: 'POST',
    headers: as,
    body: JSON.stringify({
      id: crypto.randomUUID(),
      baseVersion: version,
      actor: { type: 'user', id: USER },
      ops: [
        // u1 fits comfortably; u2 is short so its narration must overrun.
        op.addScene({ id: 'u1', name: 'Fits', duration: 6, background: '#101418', nodes: [] }),
        op.addScene({ id: 'u2', name: 'Overruns', duration: 1, background: '#101418', nodes: [] }),
        op.setNarration('u1', { text: 'Consider the equation.' }),
        op.setNarration('u2', { text: 'We rearrange both sides and simplify carefully.' }),
      ],
    }),
  }),
  'submit ops',
)

for (const sceneId of ['u1', 'u2']) {
  const gen = await jsonOrThrow<{ durationSec: number; fits: boolean }>(
    await fetch(`${API_URL}/api/projects/${projectId}/scenes/${sceneId}/narration/generate`, {
      method: 'POST', headers: as, body: '{}',
    }),
    `generate ${sceneId}`,
  )
  console.log(`  ${sceneId}: ${gen.durationSec.toFixed(2)}s (fits=${gen.fits})`)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const errors: string[] = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
})

await page.goto(`${WEB_URL}/?project=${projectId}`, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)

// ---------- audio elements exist and actually loaded ----------
await page.waitForFunction(() => document.querySelectorAll('audio').length > 0, null, { timeout: 5000 })
const audio = await page.evaluate(() =>
  Array.from(document.querySelectorAll('audio')).map((a) => ({
    src: a.src,
    crossOrigin: a.crossOrigin,
    readyState: a.readyState,
    duration: Number.isFinite(a.duration) ? a.duration : null,
    networkError: a.error?.code ?? null,
  })),
)
console.log('audio elements:', JSON.stringify(audio, null, 2))

assert.equal(audio.length, 2, 'one <audio> per narrated scene')
for (const a of audio) {
  assert.match(a.src, /\/api\/assets\//, 'audio src points at the asset route')
  assert.equal(a.crossOrigin, 'use-credentials', 'owner-scoped assets need credentialed CORS')
  assert.equal(a.networkError, null, `audio failed to load (MediaError ${a.networkError})`)
  // HAVE_CURRENT_DATA or better — proves bytes really arrived across the origin.
  assert.ok(a.readyState >= 2, `audio did not load past readyState ${a.readyState}`)
  assert.ok(a.duration && a.duration > 0.5, `implausible decoded duration ${a.duration}`)
}

// ---------- captions render over the canvas ----------
// Seek into scene u1, where narration is playing and a cue must be visible.
// A real mouse, not a synthetic PointerEvent: the timeline calls
// setPointerCapture, which throws without an actual pointer.
const bar = await page.locator('.timeline-bar').boundingBox()
assert.ok(bar, 'timeline bar should be present')
await page.mouse.click(bar.x + bar.width * 0.05, bar.y + bar.height / 2)
await page.waitForTimeout(600)
const caption = await page.evaluate(() => {
  const el = document.querySelector('.caption-overlay')
  return el ? { text: el.textContent, estimated: el.classList.contains('estimated') } : null
})
console.log('caption at playhead:', JSON.stringify(caption))
assert.ok(caption, 'a caption should be visible early in the narrated scene')
assert.equal(caption.estimated, false, 'generated narration must produce exact, not estimated, cues')

// The fitting scene must NOT be flagged.
assert.equal(
  await page.evaluate(() => document.querySelector('.narration-warning') !== null),
  false,
  'a scene whose narration fits must show no overrun warning',
)

// ---------- the overrun fix is offered, and works ----------
// Seek into u2, the 1s scene holding ~3s of speech.
await page.mouse.click(bar.x + bar.width * 0.95, bar.y + bar.height / 2)
await page.waitForTimeout(600)

const warning = await page.evaluate(() => {
  const el = document.querySelector('.narration-warning')
  return el ? el.textContent : null
})
assert.ok(warning, 'a scene whose narration overruns must be flagged in the inspector')
assert.match(warning, /overruns the scene by/, 'warning states the overrun')

await page.screenshot({ path: 'editor-narration.png' })

// Clicking the fix submits an ordinary updateScene op through the normal path.
await page.locator('.narration-warning button').click()
await page.waitForTimeout(800)

const fixed = await jsonOrThrow<{ doc: { scenes: { id: string; duration: number }[] } }>(
  await fetch(`${API_URL}/api/projects/${projectId}/doc`, { headers: as }),
  'get doc after fix',
)
const u2 = fixed.doc.scenes.find((s) => s.id === 'u2')!
assert.ok(u2.duration > 1, `fit button should have extended u2 beyond 1s, got ${u2.duration}s`)
console.log(`fit button extended u2: 1s → ${u2.duration}s (persisted to the document)`)
await browser.close()

if (errors.length) {
  console.error('ERRORS:\n' + errors.join('\n'))
  process.exit(1)
}
console.log(
  `narration UI OK — ${audio.length} audio elements loaded (readyState ${audio.map((a) => a.readyState).join('/')}), ` +
    `exact caption "${caption.text}" rendered; wrote editor-narration.png` +
    (warning ? `\noverrun panel: ${warning.trim().replace(/\s+/g, ' ')}` : ''),
)
