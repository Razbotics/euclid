/**
 * Contact sheet of a real project, at the moments the document says matter.
 *   pnpm --filter @euclid/renderer exec tsx src/preview.ts <projectId> [t...]
 *
 * Free — no credits, no render job. Needs `dev:api` + `dev:web`.
 *
 * With no times it uses `keyMoments(doc)`; with times it captures exactly those.
 * `FULL=<index>` additionally writes that tile at full canvas resolution.
 * This is the developer-facing half of plans/007 — the same capture the
 * `preview_frames` capability serves to an agent that has no shell.
 */
import './load-env'
import { writeFileSync } from 'node:fs'
import { formatMoments, keyMoments, type EuclidDoc } from '@euclid/dsl'
import { PreviewCapturer } from './sheet'

const API_URL = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const OUT = process.env.OUT_DIR ?? '.'

const projectId = process.argv[2]
if (!projectId) {
  console.error('usage: tsx src/preview.ts <projectId> [t...]')
  process.exit(1)
}
const explicit = process.argv.slice(3).map(Number).filter((n) => Number.isFinite(n))

const res = await fetch(`${API_URL}/api/projects/${projectId}/doc`, {
  headers: { 'x-internal-key': KEY, 'x-user-id': 'dev-user' },
})
if (!res.ok) {
  console.error(`could not load project: ${res.status} ${await res.text()}`)
  process.exit(1)
}
const { doc } = (await res.json()) as { doc: EuclidDoc }

const tiles = explicit.length
  ? explicit.map((t) => ({ t, label: 'requested' }))
  : keyMoments(doc).map((m) => ({ t: m.t, label: `${m.kind} ${m.label}` }))

if (tiles.length === 0) {
  console.error('nothing to capture — the document has no scenes')
  process.exit(1)
}
if (!explicit.length) console.log(formatMoments(keyMoments(doc)))

const cap = new PreviewCapturer()
const started = Date.now()
const { png, ink } = await cap.sheet(doc, tiles, { columns: Number(process.env.COLUMNS ?? 4) })
const sheetPath = `${OUT}/preview-${projectId.slice(0, 8)}.png`
writeFileSync(sheetPath, png)
console.log(
  `\nwrote ${sheetPath} — ${tiles.length} tiles, ${(png.byteLength / 1024).toFixed(0)}KB, ` +
    `${((Date.now() - started) / 1000).toFixed(1)}s\n` +
    `ink per tile: ${ink.map((v) => `${(v * 100).toFixed(1)}%`).join(' ')}`,
)

if (process.env.FULL !== undefined) {
  const i = Number(process.env.FULL)
  const tile = tiles[i]
  if (!tile) {
    console.error(`FULL=${i} is out of range (0..${tiles.length - 1})`)
  } else {
    const full = await cap.frame(doc, tile.t)
    const fullPath = `${OUT}/preview-${projectId.slice(0, 8)}-full-${i}.png`
    writeFileSync(fullPath, full)
    console.log(`wrote ${fullPath} — t=${tile.t.toFixed(2)}s at full resolution`)
  }
}

await cap.close()
