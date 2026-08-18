import { useMemo } from 'react'
import { documentCues, type EuclidDoc } from '@euclid/dsl'

/**
 * Subtitles over the canvas, from the same `documentCues` the SRT/VTT export
 * serves. Cues are already clamped to their scene, so this shows exactly what
 * a viewer of the exported file would see.
 *
 * Hidden at a standing playhead of 0: that is the editor's resting state, not
 * a moment anyone is watching, and a caption sitting over the opening frame
 * obscures the composition while you are working on it. Scrubbing to 0 while
 * playing still shows it, because then it really is the frame being played.
 */
export function CaptionOverlay({
  doc,
  time,
  playing,
}: {
  doc: EuclidDoc
  time: number
  playing: boolean
}) {
  const cues = useMemo(() => documentCues(doc), [doc])
  const cue = cues.find((c) => time >= c.start && time < c.end)
  if (!cue || (time === 0 && !playing)) return null
  return (
    <div className={`caption-overlay${cue.estimated ? ' estimated' : ''}`}>
      <span>{cue.text}</span>
    </div>
  )
}
