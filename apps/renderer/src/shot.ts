/**
 * Dev tool: screenshot arbitrary timeline moments of the demo doc through the
 * real export surface (render.html). Verifies the full Pixi + MathJax path.
 *   pnpm --filter @euclid/renderer exec tsx src/shot.ts 1.0 7.0
 */
import './load-env'
import { chromium } from 'playwright'
import { demoDoc } from '../../web/src/demo'

const RENDER_PAGE_URL = process.env.RENDER_PAGE_URL ?? 'http://localhost:5173/render.html'
const times = process.argv.slice(2).map(Number)
if (times.length === 0) times.push(1.0)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
page.on('console', (m) => console.log(`[page:${m.type()}]`, m.text()))
page.on('pageerror', (e) => console.error('[pageerror]', e.message))
await page.goto(RENDER_PAGE_URL, { waitUntil: 'networkidle' })
await page.evaluate((d) => window.__euclid.load(d), demoDoc as unknown)

for (const t of times) {
  await page.evaluate((tt) => window.__euclid.renderFrame(tt), t)
  const path = `frame-${t.toFixed(2)}s.png`
  await page.locator('#euclid-canvas').screenshot({ path })
  console.log(`wrote ${path}`)
}
await browser.close()
