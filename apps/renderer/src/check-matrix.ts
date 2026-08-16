/**
 * Structured primitives (plans/006 Phase B): matrix, tokens, cell addressing,
 * staggered reveals and cell-matched morphing — measured in pixels.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-matrix.ts
 *
 * Free — no credits. Needs `dev:api`, `dev:web`, and `render-worker.ts`.
 *
 * Lit fraction proves that something rendered and how much of it, but not
 * *where* — and "where" is the whole claim of cell addressing. So the
 * addressing test frames the camera tightly on one row (Phase A earning its
 * place): a marker on the right row fills that frame, and the identical call
 * against the wrong row leaves it empty. That turns a question about position
 * into one about brightness, which ink can answer.
 */
import './load-env'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'

const API = process.env.API_URL ?? 'http://localhost:8787'
const PREVIEW = process.env.PREVIEW_ORIGIN ?? 'http://localhost:8790'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const H = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-user-id': 'dev-user' }
const OUT = process.env.OUT_DIR ?? '/tmp'

const health = await fetch(`${PREVIEW}/health`).catch(() => null)
if (!health?.ok) {
  console.error(
    `preview backend not running at ${PREVIEW}\n` +
      '  pnpm --filter @euclid/renderer exec tsx src/render-worker.ts',
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
  return JSON.parse(r.body) as { text: string; data: any; image?: { base64: string } }
}
async function inkAt(projectId: string, at: number[], save?: string): Promise<number[]> {
  const shot = await ok('preview_frames', { projectId, at, columns: at.length })
  if (save && shot.image) writeFileSync(`${OUT}/${save}`, Buffer.from(shot.image.base64, 'base64'))
  return shot.data.ink as number[]
}
const pct = (v: number) => `${(v * 100).toFixed(2)}%`
const rising = (v: number[]) => v.every((x, i) => i === 0 || x > v[i - 1]!)

const projectId = (await ok('create_project', { name: 'Matrix Check' })).data.id

// ---------- 1. a matrix renders, and reveals cell by cell ----------
const cellScene = (await ok('add_scene', { projectId, name: 'Cells', duration: 6 })).data.sceneId
const matrixId = (
  await ok('add_matrix', {
    projectId, sceneId: cellScene,
    cells: [['1', '2', '3'], ['4', '5', '6']],
    x: 960, y: 540, fontSize: 90, cellWidth: 240, cellHeight: 180,
  })
).data.nodeId
const [drawn] = await inkAt(projectId, [5.5], 'check-matrix-grid.png')
assert.ok(drawn! > 0.002, `a 2x3 matrix must draw its cells and brackets (${pct(drawn!)})`)

// The reveal is the generalised stagger: cells arrive in reading order, so the
// lit fraction climbs through the write instead of appearing at once.
await ok('write_on', { projectId, sceneId: cellScene, nodeId: matrixId, start: 0, duration: 4 })
const fill = await inkAt(projectId, [0.6, 2, 3.6], 'check-matrix-fill.png')
assert.ok(rising(fill), `a matrix must fill in cell by cell: ${fill.map(pct).join(' → ')}`)
assert.ok(fill[0]! < drawn! * 0.6, 'and start well short of the finished grid')

// ---------- 2. cell addressing, made positional by the camera ----------
// Two identical box highlights, one on row 0 and one on row 1, with the camera
// framing row 1 alone. Only the second can light this frame.
const addrScene = (await ok('add_scene', { projectId, name: 'Address', duration: 6 })).data.sceneId
const addrId = (
  await ok('add_matrix', {
    projectId, sceneId: addrScene,
    cells: [['a', 'b'], ['c', 'd']],
    x: 960, y: 540, fontSize: 90, cellWidth: 260, cellHeight: 200,
  })
).data.nodeId
// Row 1's centre is half a cell below the matrix centre.
await ok('set_camera', { projectId, sceneId: addrScene, x: 960, y: 640, zoom: 4 })
await ok('highlight', {
  projectId, sceneId: addrScene, nodeId: addrId, cells: { rows: 0 },
  style: 'box', start: 1, duration: 1.6,
})
await ok('highlight', {
  projectId, sceneId: addrScene, nodeId: addrId, cells: { rows: 1 },
  style: 'box', start: 3, duration: 1.6,
})
const [wrongRow, rightRow] = await inkAt(projectId, [6 + 1.8, 6 + 3.8], 'check-matrix-rows.png')
assert.ok(
  rightRow! > wrongRow! * 1.5,
  `a box on row 1 must land on row 1: framed on that row it reads ${pct(rightRow!)}, ` +
    `against ${pct(wrongRow!)} for the same call on row 0`,
)

// Spotlight is the other half of cell emphasis: everything *outside* the range
// dims, so a frame showing only the un-targeted cells goes darker.
await ok('highlight', {
  projectId, sceneId: addrScene, nodeId: addrId, cells: { rows: 0 },
  style: 'spotlight', start: 4.8, duration: 1,
})
const [lit, dimmed] = await inkAt(projectId, [6 + 0.5, 6 + 5.3])
assert.ok(dimmed! < lit!, `spotlighting row 0 must dim row 1: ${pct(lit!)} → ${pct(dimmed!)}`)

// ---------- 3. a matrix restating itself ----------
const morphScene = (await ok('add_scene', { projectId, name: 'Morph', duration: 6 })).data.sceneId
const morphId = (
  await ok('add_matrix', {
    projectId, sceneId: morphScene,
    cells: [['1', '2'], ['3', '4']],
    x: 960, y: 540, fontSize: 80, cellWidth: 200, cellHeight: 160,
  })
).data.nodeId
await ok('morph_matrix', {
  projectId, sceneId: morphScene, nodeId: morphId,
  toCells: [['1', '2', '5', '7'], ['3', '4', '6', '8']],
  start: 1, duration: 2,
})
const morph = await inkAt(projectId, [12 + 0.5, 12 + 2, 12 + 4], 'check-matrix-morph.png')
assert.ok(
  morph[2]! > morph[0]! * 1.3,
  `gaining two columns must add ink: ${morph.map(pct).join(' → ')}`,
)
assert.ok(morph[1]! > 0, 'and the mid-morph frame is not blank')

// ---------- 4. tokens ----------
const tokScene = (await ok('add_scene', { projectId, name: 'Tokens', duration: 6 })).data.sceneId
const tokId = (
  await ok('add_tokens', {
    projectId, sceneId: tokScene,
    labels: ['the', 'cat', 'sat', 'down'],
    x: 960, y: 540, fontSize: 64, boxStroke: '#58c4dd', boxFill: '#1b2733',
  })
).data.nodeId
const [strip] = await inkAt(projectId, [18 + 5.5], 'check-matrix-tokens.png')
assert.ok(strip! > 0.01, `a boxed token strip must draw (${pct(strip!)})`)
await ok('write_on', { projectId, sceneId: tokScene, nodeId: tokId, start: 0, duration: 3 })
const tokens = await inkAt(projectId, [18 + 0.5, 18 + 1.5, 18 + 2.7])
assert.ok(rising(tokens), `tokens must arrive one at a time: ${tokens.map(pct).join(' → ')}`)

// ---------- 5. a group revealing child by child ----------
// The same stagger again, with children as the sequence — a `write` on a group
// used to sweep one mask edge across the whole thing.
const grpScene = (await ok('add_scene', { projectId, name: 'Group', duration: 6 })).data.sceneId
const groupId = (await ok('add_group', { projectId, sceneId: grpScene, x: 960, y: 540 })).data.nodeId
for (const dx of [-600, -200, 200, 600]) {
  await ok('add_shape', {
    projectId, sceneId: grpScene, shape: 'circle', x: dx, y: 0, radius: 90,
    fill: '#ffffff', parentId: groupId,
  })
}
await ok('write_on', { projectId, sceneId: grpScene, nodeId: groupId, start: 0, duration: 4 })
const group = await inkAt(projectId, [24 + 0.6, 24 + 2, 24 + 3.6], 'check-matrix-group.png')
assert.ok(rising(group), `a group must reveal child by child: ${group.map(pct).join(' → ')}`)

// ---------- 6. the errors teach ----------
const badRow = await run('highlight', {
  projectId, sceneId: addrScene, nodeId: addrId, cells: { rows: 9 }, start: 0, duration: 1,
})
assert.equal(badRow.status, 400)
assert.match(badRow.body, /outside .* which is 2x2/, 'an out-of-range row names the real shape')
assert.match(badRow.body, /0-based/, 'and says which way the indices run')

const cellsOnLatex = await ok('add_latex', { projectId, sceneId: cellScene, tex: 'x', x: 100, y: 100 })
const wrongType = await run('highlight', {
  projectId, sceneId: cellScene, nodeId: cellsOnLatex.data.nodeId,
  cells: { rows: 0 }, start: 0, duration: 1,
})
assert.equal(wrongType.status, 400)
assert.match(wrongType.body, /matrix and tokens/, 'cells on a latex node points at tex instead')

const ragged = await run('add_matrix', {
  projectId, sceneId: cellScene, cells: [['1', '2'], ['3']], x: 100, y: 100,
})
assert.equal(ragged.status, 400)
assert.match(ragged.body, /same number of cells/, 'a ragged grid is refused before it renders')

const wrongMorph = await run('morph_matrix', {
  projectId, sceneId: cellScene, nodeId: cellsOnLatex.data.nodeId,
  toCells: [['1']], start: 0, duration: 1,
})
assert.equal(wrongMorph.status, 400)
assert.match(wrongMorph.body, /morph_latex/, 'morphing a latex node names the capability that does')

// ---------- 7. the agent sees a cell morph without being told to look ----------
const sheet = await ok('preview_frames', { projectId })
const kinds = (sheet.data.moments as { kind: string }[]).map((m) => m.kind)
assert.ok(kinds.includes('cellMorph'), 'a cell morph must be a key moment, like a tex morph')
writeFileSync(`${OUT}/check-matrix-sheet.png`, Buffer.from(sheet.image!.base64, 'base64'))

await ok('delete_project', { projectId, confirm: true })

console.log(
  `matrix OK — grid ${pct(drawn!)}, fill ${fill.map(pct).join('→')}, ` +
    `row addressing ${pct(wrongRow!)} vs ${pct(rightRow!)}, spotlight ${pct(lit!)}→${pct(dimmed!)}, ` +
    `morph ${morph.map(pct).join('→')}, tokens ${tokens.map(pct).join('→')}, ` +
    `group ${group.map(pct).join('→')}. Range, type and shape errors all teach. ` +
    `Frames in ${OUT}/check-matrix-*.png`,
)
