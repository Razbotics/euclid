/**
 * Dev check: the editor shell's entry points load cleanly.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-app.ts
 *
 * There is no listing page any more: `/` auto-opens the newest project (needs
 * dev:api; degrades to a readable landing note without it), the sidebar's
 * hover flyout is the project list, and `?demo=1` opens the offline demo. The
 * right side starts closed and its panels are toggled from the header's ⋯
 * menu, stacking as they open.
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

// ---------- the demo editor, and the closed-by-default shell ----------
await page.goto(`${WEB_URL}/?demo=1`, { waitUntil: 'networkidle' })
await page.waitForSelector('canvas', { timeout: 8000 })
await page.waitForTimeout(2000)
assert.ok(
  await page.evaluate(() => document.querySelector('.badge.offline') !== null),
  'the demo says plainly that it is not a real project',
)
// A fresh profile has no saved layout: the right side must start closed —
// closed is the default, not a remembered preference.
assert.equal(
  await page.evaluate(() => document.querySelector('.stack') !== null),
  false,
  'the panel stack starts closed',
)

// The ⋯ menu is the door to the right side; each option adds a panel to the
// stack, in the order clicked.
await page.click('.options-btn')
await page.waitForSelector('.options-menu', { timeout: 3000 })
await page.locator('.options-menu button', { hasText: 'Files' }).click()
await page.locator('.options-menu button', { hasText: 'Scene' }).click()
const stack = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.stack-panel .stack-head > span:first-child')).map(
    (h) => h.textContent?.trim() ?? '',
  ),
)
assert.deepEqual(stack, ['Files', 'Scene'], 'toggled panels stack in the order opened')
// The menu is modal (its backdrop swallows the page); close it before
// touching anything else.
await page.click('.menu-backdrop')

// Layout regression guard: the stack is fixed-width, so long content in it can
// never squeeze the canvas. This throws no error and logs nothing when it
// breaks — it just looks like the video went small.
const layout = await page.evaluate(() => ({
  canvasW: document.querySelector('canvas')?.getBoundingClientRect().width ?? 0,
  stackW: document.querySelector('.stack')?.getBoundingClientRect().width ?? 0,
  railW: document.querySelector('.side-rail')?.getBoundingClientRect().width ?? 0,
  viewport: window.innerWidth,
}))
assert.ok(
  layout.stackW > 0 && layout.stackW < layout.viewport * 0.35,
  `the stack must stay a column, got ${layout.stackW}px of ${layout.viewport}px`,
)
assert.ok(layout.railW > 0 && layout.railW < 60, 'the sidebar rail is a thin fixed strip')
assert.ok(
  layout.canvasW > layout.viewport * 0.5,
  `canvas must keep most of the width, got ${layout.canvasW}px of ${layout.viewport}px`,
)
await page.screenshot({ path: 'editor.png' })

// ---------- the sidebar flyout is the project list ----------
await page.hover('.side-rail')
await page.waitForSelector('.side-flyout.open', { timeout: 3000 })
const flyout = await page.evaluate(() => ({
  items: Array.from(document.querySelectorAll('.side-item[href^="?project="]')).map((a) => ({
    href: a.getAttribute('href'),
    name: a.querySelector('.side-item-name')?.textContent ?? '',
    when: a.querySelector('.side-item-when')?.textContent ?? '',
  })),
  note: document.querySelector('.side-note')?.textContent?.trim() ?? null,
}))
assert.ok(
  flyout.items.length > 0 || flyout.note,
  'the flyout lists projects, or says why it cannot',
)
for (const item of flyout.items) {
  assert.ok(item.name.length > 0, 'each row shows a name')
  assert.ok(item.when.length > 0, 'each row shows when it was made')
}
await page.screenshot({ path: 'project-flyout.png' })

// Clicking a row must land in the editor on that project.
if (flyout.items.length > 0) {
  await page.locator('.side-item[href^="?project="]').first().click()
  await page.waitForSelector('canvas', { timeout: 8000 })
  await page.waitForTimeout(1000)
  assert.match(page.url(), /\?project=/, 'clicking a project opens it')
  assert.equal(
    await page.evaluate(() => document.querySelector('.badge.offline') !== null),
    false,
    'a real project must not be flagged as the offline demo',
  )
}

// ---------- bare `/` auto-opens the newest project ----------
await page.goto(`${WEB_URL}/`, { waitUntil: 'networkidle' })
if (flyout.items.length > 0) {
  await page.waitForSelector('canvas', { timeout: 8000 })
  assert.equal(
    new URL(page.url()).searchParams.get('project'),
    new URL(flyout.items[0]!.href!, WEB_URL).searchParams.get('project'),
    'bare / lands on the newest project',
  )
} else {
  // No API (or no projects): the shell still renders, and says so.
  await page.waitForSelector('.landing', { timeout: 5000 })
  assert.ok(
    await page.evaluate(() => (document.querySelector('.landing')?.textContent ?? '').length > 0),
    'the landing view always says something',
  )
}

await browser.close()

if (errors.length) {
  console.error('ERRORS:\n' + errors.join('\n'))
  process.exit(1)
}
console.log(
  `app OK — demo loads with the stack closed, ⋯ menu stacks Files+Scene, ` +
    `${flyout.items.length} project(s) in the flyout, bare / ${
      flyout.items.length > 0 ? 'opens the newest project' : 'shows the landing note'
    }; no console/page errors. wrote editor.png, project-flyout.png`,
)
