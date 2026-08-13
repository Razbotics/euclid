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
    </aside>
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
