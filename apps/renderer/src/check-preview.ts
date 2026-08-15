/**
 * Agent sight (plans/007): key moments → contact sheet → full-res drill-down.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-preview.ts
 *
 * Free — no credits. Needs `dev:api`, `dev:web`, and `preview-server.ts`.
 *
 * The thing being proved is that an agent with **no shell** can see its own
 * output. So the sheet is fetched the way that agent gets it — through the
 * gateway, as base64 in a tool result — and the bytes are checked to be a real
 * PNG of the expected shape, not merely a 200. Every quality bug in three
 * milestone runs was found by looking at a picture from a terminal; this is
 * that loop without the terminal.
 */
import './load-env'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { keyMoments, type EuclidDoc } from '@euclid/dsl'

const API = process.env.API_URL ?? 'http://localhost:8787'
const PREVIEW = process.env.PREVIEW_ORIGIN ?? 'http://localhost:8790'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const H = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-user-id': 'dev-user' }
const OUT = process.env.OUT_DIR ?? '/tmp'

const health = await fetch(`${PREVIEW}/health`).catch(() => null)
if (!health?.ok) {
  console.error(
    `preview backend not running at ${PREVIEW}\n` +
      '  pnpm --filter @euclid/renderer exec tsx src/preview-server.ts',
  )
  process.exit(1)
}

const run = async (name: string, args: Record<string, unknown>) => {
  const res = await fetch(`${API}/api/agent/tools/${name}/execute?format=json`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(args),
  })
  return { status: res.status, body: await res.text() }
}
const ok = async (name: string, args: Record<string, unknown>) => {
  const r = await run(name, args)
  assert.equal(r.status, 200, `${name} failed: ${r.body}`)
  return JSON.parse(r.body) as {
    text: string
    data: any
    image?: { base64: string; mimeType: string }
  }
}

/** PNG magic plus the IHDR dimensions — proves real pixels, not an empty 200. */
function pngSize(buf: Buffer): { width: number; height: number } {
  assert.deepEqual(
    [...buf.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'the payload must be a real PNG',
  )
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

// ---------- a document with something worth looking at ----------
const projectId = (await ok('create_project', { name: 'Preview Check' })).data.id
const sceneId = (await ok('add_scene', { projectId, name: 'One', duration: 8 })).data.sceneId
const eqId = (await ok('add_latex', { projectId, sceneId, tex: 'a^2 + b^2', x: 960, y: 480 })).data
  .nodeId
await ok('morph_latex', { projectId, sceneId, nodeId: eqId, toTex: 'c^2', start: 2, duration: 2 })
await ok('highlight', { projectId, sceneId, nodeId: eqId, start: 5, duration: 2, tex: 'c' })
await ok('add_scene', { projectId, name: 'Two', duration: 4 })

// ---------- the moments are derived, not guessed ----------
const { doc } = (await (
  await fetch(`${API}/api/projects/${projectId}/doc`, { headers: H })
).json()) as { doc: EuclidDoc }
const moments = keyMoments(doc)
assert.ok(
  moments.some((m) => m.kind === 'texMorph') && moments.some((m) => m.kind === 'highlight'),
  'the document knows where its own effects are',
)
assert.ok(
  moments.some((m) => m.sceneId !== moments[0]!.sceneId && m.t >= 8),
  'moments in later scenes are lifted to global time',
)

// ---------- the sheet, exactly as an agent receives it ----------
const sheet = await ok('preview_frames', { projectId })
assert.ok(sheet.image, 'preview_frames must return something to look at')
assert.equal(sheet.image!.mimeType, 'image/png')
const sheetBuf = Buffer.from(sheet.image!.base64, 'base64')
const sheetSize = pngSize(sheetBuf)

const tiles = sheet.data.tiles.length as number
const columns = 4
const expectedRows = Math.ceil(tiles / columns)
assert.equal(sheetSize.width, columns * 480, `sheet should be ${columns} tiles wide`)
assert.equal(
  sheetSize.height,
  expectedRows * (270 + 26),
  `sheet should be ${expectedRows} rows tall`,
)
// The caption is what makes the tiles addressable; an image alone cannot say
// which tile is which.
assert.match(sheet.text, /\[index\]/, 'the caption must explain the tile labels')
assert.match(sheet.text, /stills cannot\s+show motion/, 'and must caveat what a still can prove')

writeFileSync(`${OUT}/check-preview-sheet.png`, sheetBuf)
// Blankness is measured where the pixels are — in the browser, per tile — and
// reported back. A PNG cannot be asked cheaply: row filtering turns flat
// regions into zero bytes, which made an earlier byte-level guard rate a
// correct busy frame (0.74%) as emptier than an all-black one (1.99%), and
// wave two real capture bugs straight through.
const ink = sheet.data.ink as number[]
assert.equal(ink.length, tiles, 'every tile must be measured')
assert.ok(
  ink.some((v) => v > 0.001),
  `the sheet is blank — lit fractions ${ink.map((v) => (v * 100).toFixed(2)).join(', ')}%`,
)

// And blank-after-a-second-load specifically: rendering a *different* document
// through the same warm backend is what leaked a stale canvas and returned
// black frames for every project after the first.
const otherId = (await ok('create_project', { name: 'Preview Second Doc' })).data.id
const otherScene = (await ok('add_scene', { projectId: otherId, name: 'Only', duration: 4 })).data
  .sceneId
await ok('add_text', {
  projectId: otherId, sceneId: otherScene, textContent: 'SECOND', x: 960, y: 540, fontSize: 140,
})
const second = await ok('preview_frames', { projectId: otherId, at: [1] })
const secondInk = (second.data.ink as number[])[0]!
assert.ok(
  secondInk > 0.001,
  `a second document rendered blank (${(secondInk * 100).toFixed(2)}% lit) — the capture ` +
    'backend is serving a stale canvas from the previous load',
)
await ok('delete_project', { projectId: otherId, confirm: true })

// ---------- a path reveals along its length ----------
// The generic write-on sweeps a mask by x-position; a curve has to be drawn
// along its arc instead, or a steep section appears all at once. Measured
// rather than eyeballed: the lit fraction must grow monotonically through the
// reveal, which a mask sweep of a *steep* curve would not do evenly.
const pathScene = (await ok('add_scene', { projectId, name: 'Curve', duration: 6 })).data.sceneId
const samples = Array.from({ length: 50 }, (_, i) => ({ x: i * 14, y: -(((i / 49) * 2) ** 2) * 180 }))
const curveId = (
  await ok('add_path', { projectId, sceneId: pathScene, points: samples, x: 300, y: 900, strokeWidth: 6 })
).data.nodeId
await ok('write_on', { projectId, sceneId: pathScene, nodeId: curveId, start: 0, duration: 4 })

// Global time: this scene starts after the first one.
const base = 8 + 4 // scene 1 is 8s, plus the 4s "Two" scene added earlier
const reveal = await ok('preview_frames', {
  projectId,
  at: [base + 0.5, base + 2, base + 3.9],
  columns: 3,
})
const revealInk = reveal.data.ink as number[]
assert.equal(revealInk.length, 3, 'three points across the reveal')
assert.ok(revealInk[0]! > 0, 'the curve has started early in the write')
assert.ok(
  revealInk[1]! > revealInk[0]!,
  `the reveal must grow: ${revealInk.map((v) => v.toFixed(4)).join(' < ')}`,
)
assert.ok(revealInk[2]! > revealInk[1]!, 'and keep growing to the end')
writeFileSync(`${OUT}/check-preview-path.png`, Buffer.from(reveal.image!.base64, 'base64'))
console.log(
  `path reveal OK — lit fraction ${revealInk.map((v) => (v * 100).toFixed(2) + '%').join(' → ')}`,
)

// ---------- explicit times, and the drill-down ----------
const at = await ok('preview_frames', { projectId, at: [0.5, 3], columns: 2 })
assert.equal(pngSize(Buffer.from(at.image!.base64, 'base64')).width, 2 * 480, 'columns are honoured')

const full = await ok('preview_frames', { projectId, at: [3], full: 0 })
const fullSize = pngSize(Buffer.from(full.image!.base64, 'base64'))
assert.equal(fullSize.width, doc.canvas.width, 'a drill-down is full canvas resolution')
assert.equal(fullSize.height, doc.canvas.height)
assert.match(full.text, /full-resolution/, 'and says so')

// ---------- the errors teach, like every other capability ----------
const outOfRange = await run('preview_frames', { projectId, at: [1], full: 9 })
assert.equal(outOfRange.status, 400)
assert.match(outOfRange.body, /tiles 0\.\.0/, 'an out-of-range drill-down names the real range')

const emptyId = (await ok('create_project', { name: 'Preview Empty' })).data.id
const empty = await run('preview_frames', { projectId: emptyId })
assert.equal(empty.status, 400)
assert.match(empty.body, /add_scene/, 'an empty project is told what to do next')

// preview must be FREE: if it costs credits agents render instead, which is
// 200x more expensive and three minutes slower.
const paidDoor = await fetch(`${API}/api/agent/tools/preview_frames/execute?paid=1`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ projectId }),
})
assert.equal(paidDoor.status, 400, 'preview_frames must refuse the paid executor — it is free')

await ok('delete_project', { projectId, confirm: true })
await ok('delete_project', { projectId: emptyId, confirm: true })

console.log(
  `preview OK — ${moments.length} key moments derived from the document; ` +
    `${tiles}-tile sheet ${sheetSize.width}x${sheetSize.height} and a ` +
    `${fullSize.width}x${fullSize.height} drill-down delivered as base64 through the gateway; ` +
    `blank-sheet guard, range errors and the free-only rule all hold`,
)
