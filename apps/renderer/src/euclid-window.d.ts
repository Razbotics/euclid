/** Shape of the export surface exposed by apps/web/render.html (render-entry.ts). */
declare interface Window {
  __euclid: {
    load(doc: unknown): Promise<{ width: number; height: number; fps: number }>
    renderFrame(t: number): Promise<void>
  }
}
