import type { NarrationWord } from '@euclid/dsl'

/**
 * Text-to-speech behind a provider seam.
 *
 * The selection criterion is **word-level timestamps**, not voice quality:
 * timings are what let captions be exact and what will later let animation
 * anchor to narration beats. A provider that sounds better but can't say when
 * each word lands is not a candidate.
 *
 * Deliberately written against web-standard APIs only (fetch, atob) with no
 * Cloudflare types, so the adapter stays portable and testable outside the
 * worker.
 */

export interface SynthesisRequest {
  text: string
  /** Provider-specific voice id; the provider's default is used when absent. */
  voiceId?: string
}

export interface Synthesis {
  audio: ArrayBuffer
  mime: string
  /** Seconds of speech, from the provider's alignment. */
  durationSec: number
  words: NarrationWord[]
}

export interface TtsProvider {
  readonly name: string
  synthesize(req: SynthesisRequest): Promise<Synthesis>
}

export type TtsErrorCode = 'empty_text' | 'provider_error'

/** Distinguishes "the caller asked for something impossible" from "the provider broke". */
export class TtsError extends Error {
  constructor(
    readonly code: TtsErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TtsError'
  }
}

// ---------- ElevenLabs ----------

const ELEVENLABS_API = 'https://api.elevenlabs.io/v1'
/** "Sarah" — a neutral explainer voice; callers override per scene. */
const DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL'
/** Fast model that still returns character alignment. */
const DEFAULT_MODEL = 'eleven_flash_v2_5'

export interface ElevenLabsAlignment {
  characters: string[]
  character_start_times_seconds: number[]
  character_end_times_seconds: number[]
}

/**
 * ElevenLabs reports timing per *character*; the document wants it per word.
 * Grouping on whitespace is the whole conversion, and it deliberately keeps
 * trailing punctuation attached ("equation.") because `cuesFromWords` in
 * packages/dsl tests for /[.!?]$/ to break subtitle cues at sentence ends.
 *
 * Exported because this is the only non-trivial logic in the adapter, and it
 * is worth testing without spending a provider credit.
 */
export function wordsFromAlignment(alignment: ElevenLabsAlignment): NarrationWord[] {
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } =
    alignment
  const words: NarrationWord[] = []
  let current: NarrationWord | null = null

  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i]
    const start = starts[i]
    const end = ends[i]
    // Ragged arrays would silently produce NaN timings, so skip rather than trust.
    if (ch === undefined || start === undefined || end === undefined) continue

    if (/\s/.test(ch)) {
      if (current) {
        words.push(current)
        current = null
      }
      continue
    }
    if (current) {
      current.word += ch
      current.end = Math.max(current.end, end)
    } else {
      current = { word: ch, start, end }
    }
  }
  if (current) words.push(current)
  return words
}

/** atob gives a binary string; widen it back to bytes. */
function decodeBase64(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export function elevenLabsProvider(
  apiKey: string,
  defaults?: { voiceId?: string; modelId?: string },
): TtsProvider {
  return {
    name: 'elevenlabs',

    async synthesize({ text, voiceId }: SynthesisRequest): Promise<Synthesis> {
      const trimmed = text.trim()
      if (!trimmed) throw new TtsError('empty_text', 'narration text is empty')

      const voice = voiceId ?? defaults?.voiceId ?? DEFAULT_VOICE
      const res = await fetch(`${ELEVENLABS_API}/text-to-speech/${voice}/with-timestamps`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          text: trimmed,
          model_id: defaults?.modelId ?? DEFAULT_MODEL,
          output_format: 'mp3_44100_128',
        }),
      })
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300)
        throw new TtsError('provider_error', `elevenlabs ${res.status}: ${detail}`)
      }

      const body = (await res.json()) as {
        audio_base64?: string
        alignment?: ElevenLabsAlignment
      }
      if (!body.audio_base64 || !body.alignment) {
        throw new TtsError('provider_error', 'elevenlabs response missing audio or alignment')
      }

      const words = wordsFromAlignment(body.alignment)
      // Duration comes from the alignment rather than probing the mp3: it is
      // already exact for the purpose it serves (does this speech fit the
      // scene?) and needs no decoder in the worker. It measures end-of-speech,
      // so it can sit a few ms under the file's true length — muxing uses the
      // real file, so that difference never reaches the output.
      const durationSec = body.alignment.character_end_times_seconds.at(-1) ?? 0
      if (!(durationSec > 0)) {
        throw new TtsError('provider_error', 'elevenlabs alignment produced no duration')
      }

      return {
        audio: decodeBase64(body.audio_base64),
        mime: 'audio/mpeg',
        durationSec,
        words,
      }
    },
  }
}
