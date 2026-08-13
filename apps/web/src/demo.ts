import { SCHEMA_VERSION, type EuclidDoc } from '@euclid/dsl'

/**
 * Offline demo document — what you see when the backend isn't running.
 * Doubles as a living example of the DSL and an engine smoke test:
 * write-on, keyframe tracks, and a chained LaTeX morph.
 */
export const demoDoc: EuclidDoc = {
  schema: SCHEMA_VERSION,
  id: 'demo',
  name: 'Pythagoras (demo)',
  canvas: { width: 1920, height: 1080, fps: 60 },
  scenes: [
    {
      id: 'sc_intro',
      name: 'Title',
      duration: 4,
      background: '#101418',
      nodes: [
        {
          id: 'txt_title',
          type: 'text',
          text: 'The Pythagorean Theorem',
          fontFamily: 'Georgia, serif',
          fontSize: 96,
          fill: '#ffffff',
          position: { x: 960, y: 400 },
          scale: 1,
          rotation: 0,
          opacity: 1,
          tracks: [],
          transitions: [{ type: 'write', start: 0.3, duration: 1.6 }],
        },
        {
          id: 'circ_accent',
          type: 'circle',
          radius: 26,
          fill: '#58c4dd',
          strokeWidth: 0,
          position: { x: 300, y: 700 },
          scale: 1,
          rotation: 0,
          opacity: 1,
          tracks: [
            {
              property: 'position',
              keyframes: [
                { t: 0.5, value: { x: 300, y: 700 }, easing: 'linear' },
                { t: 3.2, value: { x: 1620, y: 700 }, easing: 'smooth' },
              ],
            },
            {
              property: 'fill',
              keyframes: [
                { t: 0.5, value: '#58c4dd', easing: 'linear' },
                { t: 3.2, value: '#fc6255', easing: 'smooth' },
              ],
            },
          ],
          transitions: [],
        },
      ],
    },
    {
      id: 'sc_theorem',
      name: 'The equation',
      duration: 6,
      background: '#101418',
      nodes: [
        {
          id: 'eq_main',
          type: 'latex',
          tex: 'a^2 + b^2 = c^2',
          color: '#ffffff',
          fontSize: 110,
          position: { x: 960, y: 480 },
          scale: 1,
          rotation: 0,
          opacity: 1,
          tracks: [],
          transitions: [
            { type: 'write', start: 0.2, duration: 1.2 },
            { type: 'texMorph', start: 2.5, duration: 1.2, toTex: 'c = \\sqrt{a^2 + b^2}', easing: 'smooth' },
          ],
        },
      ],
      narration: {
        text: 'For any right triangle, the square of the hypotenuse equals the sum of the squares of the other two sides.',
      },
    },
  ],
}
