/**
 * Shape of the export surface exposed by apps/web/render.html (render-entry.ts).
 *
 * Hand-mirrored rather than imported: this package must not depend on apps/web,
 * which the container image does not even copy. Keep it in step with
 * render-entry.ts — the two are one contract with a process boundary through it.
 */
declare interface Window {
  __euclid: {
    load(doc: unknown): Promise<{ width: number; height: number; fps: number }>
    renderFrame(t: number): Promise<void>
    /** WebCodecs capture; returns the codec actually configured. */
    startEncode(opts?: { bitrate?: number; codec?: string; realtime?: boolean }): Promise<{ codec: string }>
    /** Render at `t` and hand the frame straight to the encoder — no readback. */
    encodeFrame(t: number, index: number, keyFrame: boolean): Promise<void>
    /** Encode a run of frames in one call; times derive from the document's fps. */
    encodeRange(
      fromIndex: number,
      count: number,
      keyEvery: number,
    ): Promise<{ encodeMs: number; renderMs: number; grabMs: number; waitMs: number }>
    /** Drain whatever the encoder has produced so far. `data` is base64. */
    takeChunks(): { data: string; key: boolean; timestamp: number }[]
    /** Flush the encoder; call takeChunks once more afterwards. */
    finishEncode(): Promise<void>
  }
}
