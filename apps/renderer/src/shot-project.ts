/** Screenshot arbitrary global times of a real project doc, by id. */
import './load-env'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const API = process.env.API_ORIGIN ?? 'http://localhost:8787'
const RENDER_PAGE_URL = process.env.RENDER_PAGE_URL ?? 'http://localhost:5173/render.html'
const OUT_DIR = process.env.OUT_DIR ?? '/tmp/euclid-frames'
const [projectId, ...rest] = process.argv.slice(2)
const times = rest.map(Number)

if (!projectId || !times.length || times.some(Number.isNaN)) {
  console.error('usage: shot-project <projectId> <globalSeconds...>   [OUT_DIR=<dir>]')
  process.exit(1)
}
await mkdir(OUT_DIR, { recursive: true })

const res = await fetch(`${API}/api/projects/${projectId}/doc`)
if (!res.ok) throw new Error(`doc fetch failed ${res.status}`)
const { doc } = await res.json() as { doc: unknown }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
page.on('pageerror', (e) => console.error('[pageerror]', e.message))
await page.goto(RENDER_PAGE_URL, { waitUntil: 'networkidle' })
await page.evaluate((d) => window.__euclid.load(d), doc)

for (const t of times) {
  await page.evaluate((tt) => window.__euclid.renderFrame(tt), t)
  const path = `${OUT_DIR}/frame-${t.toFixed(2)}s.png`
  await page.locator('#euclid-canvas').screenshot({ path })
  console.log(`wrote ${path}`)
}
await browser.close()
