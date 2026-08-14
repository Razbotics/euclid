/**
 * Narration placement and ffmpeg argument construction.
 * Run: pnpm --filter @euclid/renderer exec tsx src/smoke-mux.ts
 *
 * Free — pure logic, no render, no network. check-mux.ts proves the resulting
 * command actually produces a synced file; this proves the offsets and trims
 * are right without spending 30 seconds and two TTS credits to find out.
 */
import assert from 'node:assert'
import { applyOps, emptyDoc, op } from '@euclid/dsl'
import { buildFfmpegArgs, isTrimmed, planNarration } from './mux'

const audio = (assetId: string, durationSec: number) => ({ assetId, durationSec })

// s1 [0→3] narrated and fits; s2 [3→5] silent; s3 [5→8] narration overruns.
let doc = emptyDoc('p', 'Mux')
doc = applyOps(doc, [
  op.addScene({ id: 's1', name: 'One', duration: 3, background: '#000000', nodes: [] }),
  op.addScene({ id: 's2', name: 'Silent', duration: 2, background: '#000000', nodes: [] }),
  op.addScene({ id: 's3', name: 'Three', duration: 3, background: '#000000', nodes: [] }),
  op.setNarration('s1', { text: 'Fits fine.', audio: audio('a1', 1.4) }),
  // s2 has narration text but no audio — must not become a clip.
  op.setNarration('s2', { text: 'Never generated.' }),
  op.setNarration('s3', { text: 'Runs long.', audio: audio('a3', 4.5) }),
])

const plan = planNarration(doc)

assert.equal(plan.length, 2, 'only scenes with generated audio become clips')
assert.deepEqual(
  plan.map((p) => p.sceneId),
  ['s1', 's3'],
  'a scene with narration text but no audio contributes nothing',
)

// Offsets are the scene's global start, which is what adelay depends on.
assert.equal(plan[0]!.startSec, 0, 's1 starts the timeline')
assert.equal(plan[1]!.startSec, 5, 's3 starts after s1 (3s) and s2 (2s)')

// Fitting audio plays in full; overrunning audio is cut at the scene boundary.
assert.equal(plan[0]!.playSec, 1.4, 'audio shorter than its scene plays in full')
assert.equal(isTrimmed(plan[0]!), false, 's1 is not trimmed')
assert.equal(plan[1]!.playSec, 3, '4.5s of speech in a 3s scene is cut to 3s')
assert.equal(isTrimmed(plan[1]!), true, 's3 is trimmed')
assert.ok(
  plan[1]!.startSec + plan[1]!.playSec <= 8,
  'no clip may extend past the end of the document',
)

// Clips must never overlap — that is what would put two voices on screen.
for (let i = 1; i < plan.length; i++) {
  const prev = plan[i - 1]!
  assert.ok(
    plan[i]!.startSec >= prev.startSec + prev.playSec,
    `clip ${i} starts before clip ${i - 1} finishes`,
  )
}

// ---------- ffmpeg arguments ----------
const args = buildFfmpegArgs(60, plan.map((p) => ({ ...p, path: `/tmp/${p.assetId}.mp3` })), '/tmp/out.mp4')
const filter = args[args.indexOf('-filter_complex') + 1]!

assert.ok(args.includes('-filter_complex'), 'narrated renders need a filter graph')
assert.match(filter, /adelay=0:all=1/, 's1 is placed at 0ms')
assert.match(filter, /adelay=5000:all=1/, 's3 is placed at 5000ms')
assert.match(filter, /atrim=0:3\.000/, 's3 is trimmed to its 3s scene')
assert.match(filter, /amix=inputs=2:normalize=0/, 'normalize=0 keeps narration at full volume')
assert.match(filter, /apad/, 'apad extends the track over a trailing silent scene')
assert.ok(args.includes('-shortest'), '-shortest ends the file with the video')
assert.deepEqual(args.slice(-6, -1), ['-c:a', 'aac', '-b:a', '192k', '-shortest'], 'aac audio output')

// Input order matters: video is input 0, so clip N is input N+1.
assert.equal(args[args.indexOf('-i') + 1], '-', 'the PNG pipe (stdin) is the first input')
assert.match(filter, /^\[1:a\]/, 'first clip reads from input 1, not 0')

// ---------- the silent case must not grow a filter graph ----------
let silent = emptyDoc('p2', 'Silent')
silent = applyOps(silent, [
  op.addScene({ id: 'x1', name: 'One', duration: 2, background: '#000000', nodes: [] }),
])
const silentPlan = planNarration(silent)
assert.equal(silentPlan.length, 0, 'a document with no narration plans no clips')
const silentArgs = buildFfmpegArgs(60, [], '/tmp/out.mp4')
assert.ok(!silentArgs.includes('-filter_complex'), 'silent renders stay on the old simple path')
assert.ok(!silentArgs.includes('-c:a'), 'silent renders get no audio stream')

console.log(
  `mux planning OK — ${plan.length} clips at ${plan.map((p) => `${p.startSec}s`).join('/')}, ` +
    `s3 cut ${plan[1]!.durationSec}s → ${plan[1]!.playSec}s, silent path unchanged`,
)
