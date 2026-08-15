/** Asset paths + tree, and what the document depends on. Free, no browser.
 *  Run: pnpm exec tsx src/smoke-assets.ts */
import assert from 'node:assert'
import {
  AssetPathError,
  applyOps,
  assetBasename,
  assetDirname,
  assetIdsInDoc,
  buildAssetTree,
  defaultAssetPath,
  emptyDoc,
  normalizeAssetPath,
  op,
  type AssetRecord,
} from '@euclid/dsl'

// ---------- path normalization ----------

assert.equal(normalizeAssetPath('narration/hook.mp3'), '/narration/hook.mp3', 'made absolute')
assert.equal(normalizeAssetPath('/narration//hook.mp3'), '/narration/hook.mp3', 'collapses //')
assert.equal(normalizeAssetPath('/narration/hook.mp3/'), '/narration/hook.mp3', 'no trailing slash')
assert.equal(normalizeAssetPath('  /a/ b .mp3 '), '/a/b .mp3', 'segments trimmed, inner space kept')

// The regex that guards segments must not eat ordinary filename characters —
// an over-broad character range once rejected "scene-1.mp3".
assert.equal(normalizeAssetPath('/narration/scene-1 take.2.mp3'), '/narration/scene-1 take.2.mp3')

for (const bad of ['..', '/a/../b', '/a/./b']) {
  assert.throws(() => normalizeAssetPath(bad), AssetPathError, `traversal rejected: ${bad}`)
}
assert.throws(() => normalizeAssetPath('/'), AssetPathError, 'root is not a file')
assert.throws(() => normalizeAssetPath('   '), AssetPathError, 'blank is not a file')
assert.throws(() => normalizeAssetPath('/a/b\\c'), AssetPathError, 'backslash rejected')

assert.equal(assetDirname('/narration/hook.mp3'), '/narration')
assert.equal(assetDirname('/hook.mp3'), '', 'root file has no folder')
assert.equal(assetBasename('/narration/hook.mp3'), 'hook.mp3')

assert.equal(defaultAssetPath('audio', 'audio/mpeg', 'abcdef1234'), '/audio/abcdef12.mp3')
assert.equal(defaultAssetPath('video', 'video/mp4', 'abcdef1234'), '/video/abcdef12.mp4')
assert.equal(defaultAssetPath('image', 'application/x-weird', 'abcdef1234'), '/image/abcdef12.bin')

// ---------- tree ----------

const rec = (id: string, path: string): AssetRecord => ({
  id,
  kind: 'audio',
  mime: 'audio/mpeg',
  bytes: 1024,
  durationSec: 1,
  path,
  createdAt: 0,
})

const tree = buildAssetTree([
  rec('c', '/narration/scene-2.mp3'),
  rec('a', '/narration/scene-1.mp3'),
  rec('r', '/loose.mp3'),
  rec('d', '/footage/raw/clip.mp3'),
])

assert.deepEqual(
  tree.folders.map((f) => f.name),
  ['footage', 'narration'],
  'folders sorted by name',
)
assert.deepEqual(tree.files.map((f) => f.name), ['loose.mp3'], 'root files stay at the root')

const narration = tree.folders.find((f) => f.name === 'narration')!
assert.deepEqual(
  narration.files.map((f) => f.name),
  ['scene-1.mp3', 'scene-2.mp3'],
  'files sorted by name, not insertion order',
)
assert.equal(narration.path, '/narration', 'folder carries its absolute path')

const footage = tree.folders.find((f) => f.name === 'footage')!
assert.equal(footage.folders[0]!.name, 'raw', 'nested folders are created implicitly')
assert.equal(footage.folders[0]!.path, '/footage/raw')
assert.equal(footage.folders[0]!.files[0]!.name, 'clip.mp3')

assert.deepEqual(buildAssetTree([]), { path: '', name: '', folders: [], files: [] }, 'empty tree')

// ---------- what the document depends on ----------

let doc = emptyDoc('p', 'Assets')
doc = applyOps(doc, [
  op.addScene({ id: 's1', name: 'One', duration: 5, background: '#000000', nodes: [] }),
  op.addScene({ id: 's2', name: 'Two', duration: 5, background: '#000000', nodes: [] }),
  op.setNarration('s1', {
    text: 'spoken',
    audio: { assetId: 'in-use', durationSec: 2, words: [] },
  }),
  // Text without audio must not claim an asset.
  op.setNarration('s2', { text: 'not yet synthesized' }),
])

const used = assetIdsInDoc(doc)
assert.ok(used.has('in-use'), 'narration audio counts as a reference')
assert.equal(used.size, 1, 'narration text alone references nothing')
assert.ok(!used.has('orphan'), 'a regenerated leftover is not referenced')

console.log('assets OK — paths normalized and traversal-safe, tree groups and sorts, doc references found')
