/**
 * Dev check: the editor's two entry points load cleanly.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-app.ts
 *
 * `/` lists projects (needs dev:api for a populated list; degrades to a
 * readable note without it) and `?demo=1` opens the offline demo editor.
 */
import assert from 'node:assert'
import { chromium } from 'playwright'

const WEB_URL = process.env.WEB_URL ?? 'http://localhost:5173'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const errors: string[] = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
})

// ---------- the list ----------
await page.goto(`${WEB_URL}/`, { waitUntil: 'networkidle' })
await page.waitForSelector('.project-list', { timeout: 5000 })
const list = await page.evaluate(() => ({
  items: Array.from(document.querySelectorAll('.project-list li a')).map((a) => ({
    href: a.getAttribute('href'),
    title: a.querySelector('.project-title')?.textContent ?? '',
    meta: a.querySelector('.project-meta')?.textContent ?? '',
  })),
  note: document.querySelector('.list-note')?.textContent?.trim() ?? null,
  // The list must never silently render the demo document.
  hasCanvas: document.querySelector('canvas') !== null,
}))
assert.equal(list.hasCanvas, false, 'the list is not the editor')
assert.ok(list.note, 'the list always says something, even when empty')
for (const item of list.items) {
  assert.match(item.href!, /^\?project=/, 'each row links straight into that project')
  assert.ok(item.title.length > 0, 'each row shows a name')
  assert.ok(item.meta.length > 0, 'each row shows when it was made')
}
await page.screenshot({ path: 'project-list.png' })

// Clicking a row must land in the editor on that project.
if (list.items.length > 0) {
  await page.locator('.project-list li a').first().click()
  await page.waitForSelector('canvas', { timeout: 8000 })
  assert.match(page.url(), /\?project=/, 'clicking a project opens it')
  assert.equal(
    await page.evaluate(() => document.querySelector('.badge.offline') !== null),
    false,
    'a real project must not be flagged as the offline demo',
  )
  assert.ok(
    await page.evaluate(() => document.querySelector('header .back') !== null),
    'the editor offers a way back to the list',
  )
}

// ---------- the demo editor ----------
await page.goto(`${WEB_URL}/?demo=1`, { waitUntil: 'networkidle' })
await page.waitForSelector('canvas', { timeout: 8000 })
await page.waitForTimeout(2000)
assert.ok(
  await page.evaluate(() => document.querySelector('.badge.offline') !== null),
  'the demo says plainly that it is not a real project',
)
await page.screenshot({ path: 'editor.png' })
await browser.close()

if (errors.length) {
  console.error('ERRORS:\n' + errors.join('\n'))
  process.exit(1)
}
console.log(
  `app OK — ${list.items.length} project(s) listed and openable, demo editor loads; ` +
    `no console/page errors. wrote project-list.png, editor.png`,
)
