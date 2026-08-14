import { op, type EuclidDoc, type EuclidNode, type Op, type Scene } from '@euclid/dsl'

interface Props {
  doc: EuclidDoc
  currentScene: Scene | null
  selectedNodeId: string | null
  onSelect: (id: string | null) => void
  submit: (ops: Op[]) => void
}

/**
 * Manual-edit side panel: node list for the current scene + numeric fields for
 * the selected node. Edits go through submit() as ordinary ops — the same
 * mutation path the MCP agent uses, so human and agent changes interleave safely.
 */
export function Inspector({ doc: _doc, currentScene, selectedNodeId, onSelect, submit }: Props) {
  if (!currentScene) return <aside className="inspector">no scene at playhead</aside>
  const selected = selectedNodeId ? flatten(currentScene.nodes).find((n) => n.id === selectedNodeId) : undefined

  const patch = (p: Record<string, unknown>) => {
    if (selected) submit([op.updateNode(currentScene.id, selected.id, p)])
  }

  return (
    <aside className="inspector">
      <h3>{currentScene.name}</h3>
      <ul className="node-list">
        {flatten(currentScene.nodes).map((n) => (
          <li
            key={n.id}
            className={n.id === selectedNodeId ? 'selected' : ''}
            onClick={() => onSelect(n.id === selectedNodeId ? null : n.id)}
          >
            <code>{n.type}</code> {n.name ?? n.id}
          </li>
        ))}
      </ul>
      {selected && (
        <div className="fields">
          <NumberField
            label="x"
            value={selected.position.x}
            onCommit={(v) => patch({ position: { ...selected.position, x: v } })}
          />
          <NumberField
            label="y"
            value={selected.position.y}
            onCommit={(v) => patch({ position: { ...selected.position, y: v } })}
          />
          <NumberField label="scale" value={selected.scale} step={0.05} onCommit={(v) => patch({ scale: v })} />
          <NumberField
            label="opacity"
            value={selected.opacity}
            step={0.05}
            onCommit={(v) => patch({ opacity: Math.min(1, Math.max(0, v)) })}
          />
          {selected.type === 'latex' && (
            <TextField label="tex" value={selected.tex} onCommit={(v) => patch({ tex: v })} />
          )}
          {selected.type === 'text' && (
            <TextField label="text" value={selected.text} onCommit={(v) => patch({ text: v })} />
          )}
        </div>
      )}
      <NarrationPanel scene={currentScene} submit={submit} />
    </aside>
  )
}

/**
 * Scene-level narration. Read-only on purpose: rewriting the script here would
 * leave the generated audio and its word timings describing text that no longer
 * exists, and regenerating costs credits — that belongs to the agent, which can
 * call generate_narration.
 *
 * What the editor *can* usefully fix is the mismatch generate_narration reports
 * but deliberately doesn't enforce: speech that outruns its scene. Extending
 * the scene is an ordinary op, so it goes through the same path as every other
 * edit.
 */
function NarrationPanel({ scene, submit }: { scene: Scene; submit: (ops: Op[]) => void }) {
  const narration = scene.narration
  if (!narration) return null
  const audio = narration.audio
  const overrun = audio ? audio.durationSec - scene.duration : 0

  return (
    <div className="narration-panel">
      <h4>narration</h4>
      <p className="narration-text">{narration.text}</p>
      {!audio && <p className="narration-status pending">script only — no audio generated yet</p>}
      {audio && (
        <p className="narration-status">
          {audio.durationSec.toFixed(2)}s
          {audio.words?.length ? ` · ${audio.words.length} words timed` : ' · no word timings'}
        </p>
      )}
      {overrun > 0 && (
        <div className="narration-warning">
          <span>
            overruns the scene by {overrun.toFixed(2)}s — the last{' '}
            {overrun.toFixed(2)}s will be cut from the export
          </span>
          <button
            onClick={() =>
              submit([op.updateScene(scene.id, { duration: Math.ceil(audio!.durationSec * 10) / 10 })])
            }
          >
            fit scene to narration
          </button>
        </div>
      )}
    </div>
  )
}

function flatten(nodes: EuclidNode[], into: EuclidNode[] = []): EuclidNode[] {
  for (const n of nodes) {
    into.push(n)
    if (n.type === 'group') flatten(n.children, into)
  }
  return into
}

function NumberField({
  label,
  value,
  step = 1,
  onCommit,
}: {
  label: string
  value: number
  step?: number
  onCommit: (v: number) => void
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        step={step}
        key={`${label}:${value}`}
        defaultValue={Number.isInteger(value) ? value : Number(value.toFixed(3))}
        onBlur={(e) => {
          const v = parseFloat(e.target.value)
          if (!Number.isNaN(v) && v !== value) onCommit(v)
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  )
}

function TextField({
  label,
  value,
  onCommit,
}: {
  label: string
  value: string
  onCommit: (v: string) => void
}) {
  return (
    <label>
      {label}
      <input
        type="text"
        key={`${label}:${value}`}
        defaultValue={value}
        onBlur={(e) => e.target.value !== value && onCommit(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  )
}
