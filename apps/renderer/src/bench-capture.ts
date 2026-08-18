/**
 * Where does export time actually go — rasterising, or getting the pixels out?
 *   pnpm --filter @euclid/renderer exec tsx src/bench-capture.ts
 *
 * plans/003 §4 proposes replacing `page.screenshot()` with WebCodecs, on the
 * grounds that the PNG round-trip dominates. That was measured on macOS with a
 * real GPU. In a GPU-less container Pixi's WebGL falls back to **SwiftShader**
 * software rasterisation, and 003 names the risk plainly: if rasterising is the
 * bottleneck there, WebCodecs is the wrong fix and the answer is bigger
 * instances or moving compositing to ffmpeg.
 *
 * So this times the two halves of the capture loop separately — `renderFrame`
 * (Pixi, WebGL) against `canvas.screenshot()` (PNG encode + CDP transfer) —
 * and reports the split. Run it on the host and again inside the Linux image;
 * the comparison is the whole point.
 *
 *   RENDER_PAGE_URL=http://host.docker.internal:5173/render.html   (in a container)
 *   FRAMES=120  WORKLOAD=demo|mesh|both
 */
import './load-env'
import { chromium } from 'playwright'
import { SCHEMA_VERSION, type EuclidDoc } from '@euclid/dsl'

const PAGE = process.env.RENDER_PAGE_URL ?? 'http://localhost:5173/render.html'
const FRAMES = Number(process.env.FRAMES ?? 120)
const WORKLOAD = process.env.WORKLOAD ?? 'both'

/**
 * Both documents are built here rather than imported from apps/web, because
 * the container image copies only `packages` and `apps/renderer` — a bench
 * that cannot run in the environment being measured is no bench at all.
 */
const node = (extra: Record<string, unknown>) => ({
  scale: 1, rotation: 0, opacity: 1, tracks: [], transitions: [], ...extra,
})
const scene = (id: string, nodes: unknown[], camera?: unknown) => ({
  id, name: id, duration: 6, background: '#0d1117', nodes, ...(camera ? { camera } : {}),
})
const doc = (name: string, scenes: unknown[]): EuclidDoc =>
  ({
    schema: SCHEMA_VERSION, id: 'bench', name,
    canvas: { width: 1920, height: 1080, fps: 60 },
    scenes,
  }) as unknown as EuclidDoc

/** Vector art and type — what the renderer has always drawn. */
const vectorDoc = doc('vector bench', [
  scene('sc_vec', [
    node({ id: 'r1', type: 'rect', position: { x: 600, y: 400 }, width: 500, height: 320, fill: '#58c4dd', cornerRadius: 24, strokeWidth: 0 }),
    node({ id: 'c1', type: 'circle', position: { x: 1300, y: 600 }, radius: 240, fill: '#e8c74a', strokeWidth: 0 }),
    node({ id: 't1', type: 'text', position: { x: 960, y: 160 }, text: 'capture benchmark', fontSize: 72, fill: '#e6edf3', fontFamily: 'sans-serif' }),
    node({ id: 'q1', type: 'latex', position: { x: 960, y: 900 }, tex: 'e^{i\\pi} + 1 = 0', fontSize: 88, color: '#ffffff' }),
  ]),
])

/** A solid: thousands of filled triangles a frame, which is CPU-bound
 *  differently from vector art and is what the mesh work added. */
const meshDocument = doc('mesh bench', [
  scene(
    'sc_mesh',
    [
      node({
        id: 'm1', type: 'mesh', position: { x: 960, y: 540 }, z: 0,
        geometry: { kind: 'sphere', radius: 380, segments: 64 },
        fill: '#58c4dd', shading: 'flat', ambient: 0.25, cull: true, strokeWidth: 1,
      }),
    ],
    { position: { x: 960, y: 540 }, zoom: 1, rotation: 0, yaw: 0.6, pitch: 0.35, distance: 2000, tracks: [] },
  ),
])

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
page.on('pageerror', (e) => console.error('[pageerror]', e.message))
await page.goto(PAGE, { waitUntil: 'networkidle' })

// What is actually rasterising — a real GPU, or SwiftShader?
const gpu = await page.evaluate(() => {
  const c = document.createElement('canvas')
  const gl = c.getContext('webgl2') ?? c.getContext('webgl')
  if (!gl) return { renderer: 'no webgl', vendor: '' }
  const dbg = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info')
  const g = gl as WebGLRenderingContext
  return {
    renderer: dbg ? String(g.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(g.getParameter(g.RENDERER)),
    vendor: dbg ? String(g.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : String(g.getParameter(g.VENDOR)),
  }
})
console.log(`page:     ${PAGE}`)
console.log(`webgl:    ${gpu.renderer} (${gpu.vendor})`)
console.log(`frames:   ${FRAMES} at 1920x1080\n`)

const workloads: [string, EuclidDoc][] = []
if (WORKLOAD === 'demo' || WORKLOAD === 'both') workloads.push(['vector + latex', vectorDoc])
if (WORKLOAD === 'mesh' || WORKLOAD === 'both') workloads.push(['mesh (sphere, 4096 tri)', meshDocument])

for (const [label, doc] of workloads) {
  const meta = await page.evaluate((d) => window.__euclid.load(d), doc as unknown)
  const canvas = page.locator('#euclid-canvas')

  // One warm frame: the first pays for shader compilation and texture upload,
  // which is setup rather than per-frame cost.
  await page.evaluate((t) => window.__euclid.renderFrame(t), 0)
  await canvas.screenshot({ type: 'png' })

  let renderMs = 0
  let shotMs = 0
  let bytes = 0
  const started = performance.now()
  for (let f = 0; f < FRAMES; f++) {
    const t = (f / meta.fps) % 5
    let s = performance.now()
    await page.evaluate((tt) => window.__euclid.renderFrame(tt), t)
    renderMs += performance.now() - s
    s = performance.now()
    const png = await canvas.screenshot({ type: 'png' })
    shotMs += performance.now() - s
    bytes += png.byteLength
  }
  const total = performance.now() - started
  const pct = (v: number) => `${((v / total) * 100).toFixed(0)}%`
  console.log(
    `${label}\n` +
      `  render  ${(renderMs / FRAMES).toFixed(1).padStart(6)} ms/frame  ${pct(renderMs).padStart(4)}\n` +
      `  screenshot ${(shotMs / FRAMES).toFixed(1).padStart(3)} ms/frame  ${pct(shotMs).padStart(4)}  ` +
      `(${(bytes / FRAMES / 1024).toFixed(0)}KB/frame)\n` +
      `  total   ${(total / FRAMES).toFixed(1).padStart(6)} ms/frame  → ` +
      `${(1000 / (total / FRAMES)).toFixed(1)} fps  ` +
      `(${((1000 / (total / FRAMES)) / meta.fps).toFixed(2)}x realtime at ${meta.fps}fps)\n`,
  )
}

await browser.close()
