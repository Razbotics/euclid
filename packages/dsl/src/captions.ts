import type { EuclidDoc } from './document'

/**
 * Captions are a pure function of the document — same discipline as rendering.
 *
 * Two fidelities, chosen per scene by what the document actually has:
 *  - `narration.audio.words` present (from TTS) → word-accurate cues
 *  - text only → sentences distributed across the scene by character count
 * The second is an approximation, and `estimated` says so rather than
 * pretending otherwise.
 */

export interface Cue {
  /** seconds on the global timeline */
  start: number
  end: number
  text: string
  /** true when timing was inferred from text length, not measured from audio */
  estimated: boolean
}

const MAX_CUE_CHARS = 84 // ~2 lines of 42, the usual subtitle convention
const MAX_CUE_SEC = 6
const MIN_CUE_SEC = 0.8

export function documentCues(doc: EuclidDoc): Cue[] {
  const cues: Cue[] = []
  let sceneStart = 0
  for (const scene of doc.scenes) {
    const text = scene.narration?.text?.trim()
    if (text) {
      const words = scene.narration?.audio?.words
      const raw = words?.length
        ? cuesFromWords(words, sceneStart)
        : cuesFromText(text, sceneStart, scene.duration)
      cues.push(...clampToScene(raw, sceneStart + scene.duration))
    }
    sceneStart += scene.duration
  }
  return cues
}

/**
 * Generated narration can be longer than its scene: `generate_narration`
 * reports the overrun but keeps the audio rather than billing the user twice
 * to retry, so the document legitimately holds speech that outlasts its scene.
 *
 * Cues must not survive past the scene, for two reasons: they would describe
 * footage that is no longer on screen, and — worse — they would overlap the
 * next scene's cues, putting two subtitles up at once.
 */
function clampToScene(cues: Cue[], sceneEnd: number): Cue[] {
  const out: Cue[] = []
  for (const cue of cues) {
    if (cue.start >= sceneEnd) continue // never on screen at all
    out.push(cue.end <= sceneEnd ? cue : { ...cue, end: sceneEnd })
  }
  return out
}

/** Word timings are scene-local; `offset` lifts them onto the global timeline. */
function cuesFromWords(
  words: { word: string; start: number; end: number }[],
  offset: number,
): Cue[] {
  const cues: Cue[] = []

  for (const sentence of groupSentences(words)) {
    const chars = sentence.reduce((n, w) => n + w.word.length + 1, 0) - 1
    const span = sentence[sentence.length - 1]!.end - sentence[0]!.start
    // A sentence is split only as many times as it must be, then split evenly
    // — never filled to the brim and left with a stub.
    const pieces = Math.max(
      Math.ceil(chars / MAX_CUE_CHARS),
      Math.ceil(span / MAX_CUE_SEC),
      1,
    )
    let from = 0
    for (const cut of [...balancedCuts(sentence.map((w) => w.word), pieces), sentence.length]) {
      const chunk = sentence.slice(from, cut)
      from = cut
      if (chunk.length === 0) continue
      const start = chunk[0]!.start
      const end = chunk[chunk.length - 1]!.end
      cues.push({
        start: offset + start,
        end: offset + Math.max(end, start + MIN_CUE_SEC),
        text: chunk.map((w) => w.word).join(' ').trim(),
        estimated: false,
      })
    }
  }
  return cues
}

/** Break a word stream after every sentence-final word. */
function groupSentences<T extends { word: string }>(words: T[]): T[][] {
  const groups: T[][] = []
  let current: T[] = []
  for (const w of words) {
    current.push(w)
    if (/[.!?]["')\]]?$/.test(w.word)) {
      groups.push(current)
      current = []
    }
  }
  if (current.length) groups.push(current)
  return groups
}

/** A comma, semicolon, colon or dash is a natural place to break a line. */
const CLAUSE_END = /[,;:—–-]$/

/**
 * Word indices at which to cut a run into `pieces` balanced chunks.
 *
 * Greedy filling is what produced cues like "…add it to both / sides." — the
 * first line takes everything it can and the second gets the crumbs. Cutting
 * at even character positions, then nudging each cut to a nearby clause
 * boundary, keeps lines similar in length and breaks where the sentence
 * already pauses. That is the entire difference between subtitles that read
 * and subtitles that merely fit.
 */
function balancedCuts(words: string[], pieces: number): number[] {
  if (pieces < 2 || words.length < 2) return []
  const prefix = [0]
  for (const w of words) prefix.push(prefix[prefix.length - 1]! + w.length + 1)
  const total = prefix[prefix.length - 1]!

  const cuts: number[] = []
  for (let p = 1; p < pieces; p++) {
    const target = (total * p) / pieces
    let best = 1
    let bestDistance = Infinity
    for (let i = 1; i < words.length; i++) {
      const distance = Math.abs(prefix[i]! - target)
      if (distance < bestDistance) {
        bestDistance = distance
        best = i
      }
    }
    // Look for a clause boundary near the even cut, preferring the closest.
    const window = Math.max(1, Math.round(words.length / (pieces * 3)))
    let chosen = best
    for (let d = 1; d <= window; d++) {
      const before = best - d
      const after = best + d
      if (before > 0 && CLAUSE_END.test(words[before - 1]!)) {
        chosen = before
        break
      }
      if (after < words.length && CLAUSE_END.test(words[after - 1]!)) {
        chosen = after
        break
      }
    }
    if (!cuts.includes(chosen)) cuts.push(chosen)
  }
  return cuts.sort((a, b) => a - b)
}

/**
 * No audio yet: split into sentences and give each a share of the scene
 * proportional to its length. Reading rate is implied by the scene duration,
 * so this stays in sync with whatever pacing the author chose.
 */
function cuesFromText(text: string, offset: number, duration: number): Cue[] {
  const sentences = splitSentences(text)
  const totalChars = sentences.reduce((n, s) => n + s.length, 0)
  if (totalChars === 0) return []

  const cues: Cue[] = []
  let t = 0
  for (const sentence of sentences) {
    const share = (sentence.length / totalChars) * duration
    for (const chunk of chunkText(sentence, MAX_CUE_CHARS)) {
      const chunkShare = (chunk.length / sentence.length) * share
      const start = t
      const end = Math.min(duration, t + chunkShare)
      cues.push({
        start: offset + start,
        end: offset + Math.max(end, Math.min(duration, start + MIN_CUE_SEC)),
        text: chunk,
        estimated: true,
      })
      t = end
    }
  }
  return cues
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Split on word boundaries so a cue never cuts a word in half — and split
 * evenly rather than greedily, using the same balancing as the word-timed
 * path so both fidelities read the same way.
 */
function chunkText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (text.length <= maxChars || words.length < 2) return [text]

  const pieces = Math.ceil(text.length / maxChars)
  const chunks: string[] = []
  let from = 0
  for (const cut of [...balancedCuts(words, pieces), words.length]) {
    if (cut > from) chunks.push(words.slice(from, cut).join(' '))
    from = cut
  }
  return chunks
}

export function toSRT(cues: Cue[]): string {
  return (
    cues
      .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}`)
      .join('\n\n') + (cues.length ? '\n' : '')
  )
}

export function toVTT(cues: Cue[]): string {
  return (
    'WEBVTT\n\n' +
    cues.map((c) => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}`).join('\n\n') +
    (cues.length ? '\n' : '')
  )
}

function clock(t: number): { hh: string; mm: string; ss: string; ms: string } {
  const total = Math.max(0, t)
  const ms = Math.round((total % 1) * 1000)
  const whole = Math.floor(total)
  return {
    hh: String(Math.floor(whole / 3600)).padStart(2, '0'),
    mm: String(Math.floor((whole % 3600) / 60)).padStart(2, '0'),
    ss: String(whole % 60).padStart(2, '0'),
    ms: String(ms).padStart(3, '0'),
  }
}

function srtTime(t: number): string {
  const { hh, mm, ss, ms } = clock(t)
  return `${hh}:${mm}:${ss},${ms}`
}

function vttTime(t: number): string {
  const { hh, mm, ss, ms } = clock(t)
  return `${hh}:${mm}:${ss}.${ms}`
}
