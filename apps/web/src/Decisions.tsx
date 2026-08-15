import { useState } from 'react'
import type { Decision } from '@euclid/dsl'

interface Props {
  decisions: Decision[]
  onAnswer: (id: string, answer: { optionId?: string; note?: string }) => void
  /** Seek the playhead, so a question about a moment can be looked at first. */
  onSeek: (t: number) => void
}

/**
 * Questions the agent is waiting on. Deliberately prominent and deliberately
 * blocking-looking: an unanswered question means an agent is stalled, and a
 * subtle indicator would leave it stalled for a long time.
 *
 * Answered questions stay listed, greyed, so the human can see what they chose
 * and the agent's later decisions make sense in hindsight.
 */
export function Decisions({ decisions, onAnswer, onSeek }: Props) {
  if (decisions.length === 0) return null
  const open = decisions.filter((d) => d.status === 'open')
  const answered = decisions.filter((d) => d.status === 'answered')

  return (
    <section className="decisions">
      <h3>
        agent questions
        {open.length > 0 && <span className="decision-badge">{open.length} waiting</span>}
      </h3>
      {open.map((d) => (
        <OpenDecision key={d.id} decision={d} onAnswer={onAnswer} onSeek={onSeek} />
      ))}
      {answered.map((d) => (
        <div key={d.id} className="decision answered">
          <p className="decision-question">{d.question}</p>
          <p className="decision-resolved">
            {d.options.find((o) => o.id === d.answer?.optionId)?.label ?? d.answer?.note}
            <span className="decision-via"> · via {d.answer?.via}</span>
          </p>
        </div>
      ))}
    </section>
  )
}

function OpenDecision({ decision: d, onAnswer, onSeek }: { decision: Decision } & Omit<Props, 'decisions'>) {
  const [note, setNote] = useState('')

  return (
    <div className="decision open">
      <p className="decision-question">{d.question}</p>
      {d.detail && <p className="decision-detail">{d.detail}</p>}
      {d.context?.atSec !== undefined && (
        <button className="decision-seek" onClick={() => onSeek(d.context!.atSec!)}>
          ▶ jump to {d.context.atSec.toFixed(1)}s
        </button>
      )}
      <div className="decision-options">
        {d.options.map((o) => (
          <button key={o.id} onClick={() => onAnswer(d.id, { optionId: o.id })} title={o.detail}>
            {o.label}
            {o.detail && <span className="opt-detail">{o.detail}</span>}
          </button>
        ))}
      </div>
      {/* An escape hatch: the right answer is often none of the offered ones. */}
      <form
        className="decision-note"
        onSubmit={(e) => {
          e.preventDefault()
          if (note.trim()) onAnswer(d.id, { note: note.trim() })
        }}
      >
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="or answer in your own words…"
        />
        <button type="submit" disabled={!note.trim()}>
          send
        </button>
      </form>
    </div>
  )
}
