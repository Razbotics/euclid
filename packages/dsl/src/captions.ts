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
      cues.push(
        ...(words?.length
          ? cuesFromWords(words, sceneStart)
          : cuesFromText(text, sceneStart, scene.duration)),
      )
    }
    sceneStart += scene.duration
  }
  return cues
}

/** Word timings are scene-local; `offset` lifts them onto the global timeline. */
function cuesFromWords(
  words: { word: string; start: number; end: number }[],
  offset: number,
): Cue[] {
  const cues: Cue[] = []
  let group: typeof words = []

  const flush = () => {
    if (group.length === 0) return
    const start = group[0]!.start
    const end = group[group.length - 1]!.end
    cues.push({
      start: offset + start,
      end: offset + Math.max(end, start + MIN_CUE_SEC),
      text: group.map((w) => w.word).join(' ').trim(),
      estimated: false,
    })
    group = []
  }

  for (const w of words) {
    const wouldBeChars = group.reduce((n, g) => n + g.word.length + 1, 0) + w.word.length
    const wouldBeSpan = group.length > 0 ? w.end - group[0]!.start : 0
    if (group.length > 0 && (wouldBeChars > MAX_CUE_CHARS || wouldBeSpan > MAX_CUE_SEC)) flush()
    group.push(w)
    if (/[.!?]$/.test(w.word)) flush() // break on sentence end for readability
  }
  flush()
  return cues
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

/** Split on word boundaries so a cue never cuts a word in half. */
function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]
  const chunks: string[] = []
  let current = ''
  for (const word of text.split(/\s+/)) {
    if (current && (current + ' ' + word).length > maxChars) {
      chunks.push(current)
      current = word
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) chunks.push(current)
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
