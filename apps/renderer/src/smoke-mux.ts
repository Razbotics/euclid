/**
 * Audio placement (narration *and* music/effect tracks) and ffmpeg argument
 * construction.
 * Run: pnpm --filter @euclid/renderer exec tsx src/smoke-mux.ts
 *
 * Free — pure logic, no render, no network. check-mux.ts proves the resulting
 * command actually produces a synced file; this proves the offsets and trims
 * are right without spending 30 seconds and two TTS credits to find out.
 */
import assert from 'node:assert'
import {
  applyOps,
  audibleAudio,
  emptyDoc,
  gainAt,
  isTrimmed,
  op,
  outlineDoc,
  pacingSummary,
  planAudio,
  planNarration,
  scenePacing,
} from '@euclid/dsl'
import { buildFfmpegArgs } from './mux'

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

// ---------- pacing ----------
// Same module, same document: how much of each scene is speech vs silence.
// Nothing enforces a pace; this only makes dead air visible to the agent.
const pacing = scenePacing(doc)
assert.equal(pacing.length, 3, 'every scene is reported, narrated or not')
assert.deepEqual(
  pacing.map((p) => [p.sceneId, p.speechSec, p.tailSec]),
  [
    ['s1', 1.4, 1.6], // 1.4s of speech in a 3s scene
    ['s2', 0, 2], // text-only narration is not speech yet
    ['s3', 3, 0], // 4.5s of audio cut to the 3s scene leaves no tail
  ],
  'speech is capped at the scene, and the tail is what remains',
)
assert.equal(pacing[1]!.hasNarrationText, true, 's2 has a script but no audio')

const summary = pacingSummary(doc)
assert.equal(summary.totalSec, 8)
assert.equal(summary.speechSec, 4.4)
assert.equal(summary.silentSec, 3.6)
assert.equal(summary.silentPct, 45, 'silence percentage is what surfaces dead air')

// The outline is where the agent actually sees it.
const outline = outlineDoc(doc)
assert.match(outline, /3\.6s silent \(45%\)/, 'project line reports total silence')
assert.match(outline, /speech=1\.40s tail=1\.60s/, 'per-scene speech and tail are shown')
assert.match(outline, /narration=text-only/, 'a script with no audio is marked, not counted as speech')
assert.ok(!/tail=1\.60s \(long\)/.test(outline), 'a short tail is not flagged')

// ---------- ffmpeg arguments ----------
// The mux reads `audibleAudio`, not `planNarration` — narration is one lane
// among several now, and the export must be built from the merged list.
const withPaths = (doc: Parameters<typeof audibleAudio>[0]) =>
  audibleAudio(doc).map((p) => ({ ...p, path: `/tmp/${p.assetId}.mp3` }))
const args = buildFfmpegArgs(60, withPaths(doc), '/tmp/out.mp4')
const filter = args[args.indexOf('-filter_complex') + 1]!

assert.ok(args.includes('-filter_complex'), 'narrated renders need a filter graph')
assert.match(filter, /adelay=0:all=1/, 's1 is placed at 0ms')
assert.match(filter, /adelay=5000:all=1/, 's3 is placed at 5000ms')
assert.match(filter, /atrim=0\.000:3\.000/, 's3 is trimmed to its 3s scene')
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

// ---------- audio tracks: music and effects alongside narration ----------
// A bed under the whole video at 40%, and a sting placed inside scene 2. The
// bed is deliberately longer than the video and the sting deliberately runs
// past the end, because both are what a real project does.
let scored = applyOps(doc, [
  op.addAudioTrack({ id: 'bed', name: 'Music bed', kind: 'music', gain: 0.4, clips: [] }),
  op.addAudioTrack({ id: 'fx', name: 'Effects', kind: 'sfx', clips: [] }),
  op.addAudioClip('bed', {
    id: 'c-bed',
    assetId: 'music',
    startSec: 0,
    durationSec: 30,
    fadeInSec: 1,
    fadeOutSec: 2,
  }),
  op.addAudioClip('fx', { id: 'c-sting', assetId: 'sting', startSec: 7, durationSec: 4, gain: 0.8 }),
])

const full = planAudio(scored)
assert.equal(full.length, 4, 'two narration clips and two track clips, in one list')
assert.deepEqual(
  full.map((p) => p.trackId),
  ['narration', 'bed', 'narration', 'fx'],
  'placements are ordered by start time, whatever lane they are on',
)

const bed = full.find((p) => p.key === 'c-bed')!
assert.equal(bed.playSec, 8, 'a 30s bed on an 8s video is cut at the end of the video')
assert.equal(bed.gain, 0.4, 'track gain reaches the placement')
const sting = full.find((p) => p.key === 'c-sting')!
assert.equal(sting.playSec, 1, 'a 4s sting starting at 7s of an 8s video plays for 1s')
assert.equal(sting.gain, 0.8, 'clip gain with no track gain is the clip gain')

// Gains multiply, and a fade never exceeds the clip it is on.
scored = applyOps(scored, [op.updateAudioClip('fx', 'c-sting', { fadeInSec: 5 })])
const clamped = planAudio(scored).find((p) => p.key === 'c-sting')!
assert.equal(clamped.fadeInSec, 1, 'a 5s fade on a 1s clip is clamped to the clip')

// The fade envelope the preview player reads, and the export renders.
assert.equal(gainAt(bed, 0), 0, 'a fade-in starts at silence')
assert.equal(gainAt(bed, 0.5), 0.2, 'halfway through a 1s fade-in is half the level')
assert.equal(gainAt(bed, 4), 0.4, 'the middle of the clip sits at its own level')
assert.equal(gainAt(bed, 7), 0.2, '1s into a 2s fade-out is half the level')
assert.equal(gainAt(bed, 8), 0, 'the end of the clip is silence')

// ---------- the outline is where the agent sees the mix ----------
// An agent that cannot see the music bed will cheerfully generate a second
// one, and a muted lane it cannot see is a render that comes back missing a
// sound nobody remembers turning off.
const scoredOutline = outlineDoc(scored)
assert.match(scoredOutline, /audio "Music bed" \(bed\) music/, 'tracks are listed')
assert.match(scoredOutline, /gain=0\.4/, 'a non-default track gain is shown')
assert.match(
  scoredOutline,
  /clip c-bed \[0s → 8s\] \(cut from 30s at the end of the video\)/,
  'a clip is reported as what it plays, not as how long the file is',
)
assert.match(scoredOutline, /fadeIn=1s fadeOut=2s/, 'fades are visible without a second call')
assert.ok(!/MUTED/.test(scoredOutline), 'nothing is marked muted when nothing is')
assert.match(
  outlineDoc(applyOps(scored, [op.updateAudioTrack('bed', { muted: true })])),
  /MUTED \(silent in the export\)/,
  'a muted lane says what mute means',
)

// ---------- muting is part of the document, so it changes the export ----------
const muted = applyOps(scored, [op.updateAudioTrack('bed', { muted: true })])
assert.equal(planAudio(muted).length, 4, 'the timeline still draws a muted lane')
assert.equal(planAudio(muted).find((p) => p.key === 'c-bed')!.muted, true, 'flagged, not dropped')
assert.equal(audibleAudio(muted).length, 3, 'but the export leaves it out')
assert.ok(!audibleAudio(muted).some((p) => p.trackId === 'bed'), 'no muted clip reaches ffmpeg')

// ---------- the filter graph for a scored video ----------
const scoredArgs = buildFfmpegArgs(30, withPaths(scored), '/tmp/out.mp4')
const scoredFilter = scoredArgs[scoredArgs.indexOf('-filter_complex') + 1]!
assert.match(scoredFilter, /amix=inputs=4:normalize=0/, 'all four clips are mixed')
assert.match(scoredFilter, /volume=0\.400/, 'the bed is attenuated to its track gain')
assert.match(scoredFilter, /afade=t=in:st=0:d=1\.000/, 'the bed fades in over 1s')
assert.match(scoredFilter, /afade=t=out:st=6\.000:d=2\.000/, 'and out over the last 2s of its 8s')
assert.match(scoredFilter, /adelay=7000:all=1/, 'the sting is placed at 7s')
// Order within one chain is what makes a fade ramp to the clip's own level.
assert.ok(
  scoredFilter.indexOf('volume=0.400') < scoredFilter.indexOf('afade=t=in'),
  'volume is applied before the fade, so a 0.4 bed never swells to 1.0',
)
// And trimming happens in source time, before the clip is placed.
assert.ok(
  scoredFilter.indexOf('atrim') < scoredFilter.indexOf('adelay'),
  'atrim precedes adelay, or the delay would stack on the source offset',
)

// ---------- trimming the head of a clip ----------
const trimmed = applyOps(scored, [
  op.updateAudioClip('bed', 'c-bed', { sourceInSec: 12, playSec: 3 }),
])
const head = planAudio(trimmed).find((p) => p.key === 'c-bed')!
assert.equal(head.sourceInSec, 12, 'the head trim is carried through')
assert.equal(head.playSec, 3, 'and the clip plays only what it was asked to')
const trimFilter = buildFfmpegArgs(30, withPaths(trimmed), '/tmp/o.mp4')[
  buildFfmpegArgs(30, withPaths(trimmed), '/tmp/o.mp4').indexOf('-filter_complex') + 1
]!
assert.match(trimFilter, /atrim=12\.000:15\.000/, 'ffmpeg reads 12s→15s of the source')

// ---------- dragging a clip between lanes ----------
const moved = applyOps(scored, [op.moveAudioClip('fx', 'bed', 'c-sting', 2)])
assert.equal(moved.audio!.find((t) => t.id === 'fx')!.clips.length, 0, 'it left the old lane')
const landed = moved.audio!.find((t) => t.id === 'bed')!.clips.find((c) => c.id === 'c-sting')!
assert.equal(landed.startSec, 2, 'and arrived at the new time')
// Same lane, same clip: a no-op move must not lose it.
const sameLane = applyOps(scored, [op.moveAudioClip('bed', 'bed', 'c-bed', 4)])
assert.equal(sameLane.audio!.find((t) => t.id === 'bed')!.clips.length, 1, 'a same-lane move keeps the clip')
assert.equal(
  sameLane.audio!.find((t) => t.id === 'bed')!.clips[0]!.startSec,
  4,
  'and still moves it',
)

// ---------- removing the last track leaves no empty husk ----------
const bare = applyOps(scored, [op.removeAudioTrack('bed'), op.removeAudioTrack('fx')])
assert.equal(bare.audio, undefined, 'an empty audio list is removed, not left as []')
assert.equal(audibleAudio(bare).length, 2, 'narration survives losing every audio track')

console.log(
  `mux planning OK — ${plan.length} narration clips at ${plan.map((p) => `${p.startSec}s`).join('/')}, ` +
    `s3 cut ${plan[1]!.durationSec}s → ${plan[1]!.playSec}s; ` +
    `scored: ${full.length} clips over ${new Set(full.map((p) => p.trackId)).size} lanes, ` +
    `bed cut 30s → ${bed.playSec}s @${bed.gain}, mute removes 1 from the mix; silent path unchanged`,
)
