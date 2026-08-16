import { globalToScene, type EuclidDoc } from '@euclid/dsl'
import { resolveCamera } from '@euclid/engine'

interface Props {
  doc: EuclidDoc
  time: number
}

/**
 * Where the camera is looking, while you scrub.
 *
 * Deliberately a mini-map rather than an outline drawn over the canvas: the
 * preview *is* the camera's view, so a frame rectangle on top of it would
 * either trace the edge of the window (zoom ≥ 1, telling you nothing) or sit
 * entirely off-screen (zoomed in, showing nothing at all). What is missing
 * while scrubbing a camera move is the other half — which part of the scene
 * you are inside — and that only exists next to the whole scene, not on it.
 *
 * Pure function of (doc, time), sampled through the same `resolveCamera` the
 * stage uses, so the map cannot drift from the picture beside it.
 */
export function CameraFrame({ doc, time }: Props) {
  const at = globalToScene(doc, time)
  const cam = at ? resolveCamera(at.scene, at.localT) : null
  if (!cam) return null

  const { width: W, height: H } = doc.canvas
  // The visible region in SCENE coordinates. Screen = centre + R(−roll)·zoom·
  // (p − position), so inverting it puts the frame's corners at
  // position + R(roll)·(±W/2z, ±H/2z).
  const hw = W / (2 * cam.zoom)
  const hh = H / (2 * cam.zoom)
  const cos = Math.cos(cam.rotation)
  const sin = Math.sin(cam.rotation)
  const corners = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([u, v]) => ({
    x: cam.position.x + u! * cos - v! * sin,
    y: cam.position.y + u! * sin + v! * cos,
  }))

  // The map covers the canvas and the frame together, so a camera that has
  // wandered outside the composed area stays visible instead of clipping.
  const pad = Math.max(W, H) * 0.05
  const minX = Math.min(0, ...corners.map((c) => c.x)) - pad
  const maxX = Math.max(W, ...corners.map((c) => c.x)) + pad
  const minY = Math.min(0, ...corners.map((c) => c.y)) - pad
  const maxY = Math.max(H, ...corners.map((c) => c.y)) + pad

  const degrees = (cam.rotation * 180) / Math.PI
  return (
    <div className="camera-frame" title="camera framing — outer box is the canvas">
      <svg viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} aria-hidden="true">
        <rect className="canvas-rect" x={0} y={0} width={W} height={H} vectorEffect="non-scaling-stroke" />
        <polygon
          className="view-rect"
          points={corners.map((c) => `${c.x},${c.y}`).join(' ')}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className="camera-readout">
        ⛶ ({Math.round(cam.position.x)}, {Math.round(cam.position.y)}) · {cam.zoom.toFixed(2)}×
        {Math.abs(degrees) >= 0.5 ? ` · ${degrees.toFixed(0)}°` : ''}
      </span>
    </div>
  )
}
