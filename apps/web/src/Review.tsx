import { useEffect, useState } from 'react'
import {
  assetBasename,
  planRemaining,
  type Decision,
  type ProjectPlan,
} from '@euclid/dsl'
import { assetUrl, formatBytes, type ProjectFile } from './useAssets'
import { ModelView, viewerKind } from './FileViewer'

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787'

/**
 * The review queue (plans/010, phase 3) — the right-panel section that earns
 * back the space the questions panel gave up in 2026-08-15. Everything the
 * agent is waiting on, newest first: plan approvals rendered as their
 * scene/asset/cost outline, asset reviews rendered with the file *in front of
 * the human* (the whole argument for reviewing here rather than in a chat
 * picker), and plain ask_user questions as before.
 *
 * Approve is one click; request-changes **requires a note**, because a bare
 * rejection gives the agent nothing to iterate against — the note becomes the
 * decision answer, which becomes the asset's `review_note`, which is what the
 * agent reads back.
 */
export function Review({
  decisions,
  plans,
  files,
  onAnswer,
  onSeek,
}: {
  decisions: Decision[]
  plans: ProjectPlan[]
  files: ProjectFile[] | null
  onAnswer: (id: string, answer: { optionId?: string; note?: string }) => void
  onSeek: (t: number) => void
}) {
  if (decisions.length === 0) return null
  const open = [...decisions.filter((d) => d.status === 'open')].reverse()
  const answered = [...decisions.filter((d) => d.status === 'answered')].reverse()

  return (
    <section className="decisions review-queue">
      <h3>
        review
        {open.length > 0 && <span className="decision-badge">{open.length} waiting</span>}
      </h3>
      {open.map((d) => (
        <OpenItem key={d.id} decision={d} plans={plans} files={files} onAnswer={onAnswer} onSeek={onSeek} />
      ))}
      {answered.map((d) => (
        <div key={d.id} className="decision answered">
          <p className="decision-question">{d.question}</p>
          <p className="decision-resolved">
            {d.options.find((o) => o.id === d.answer?.optionId)?.label ?? d.answer?.note}
            {d.answer?.optionId && d.answer.note ? ` — "${d.answer.note}"` : ''}
            <span className="decision-via"> · via {d.answer?.via}</span>
          </p>
        </div>
      ))}
    </section>
  )
}

function OpenItem({
  decision: d,
  plans,
  files,
  onAnswer,
  onSeek,
}: {
  decision: Decision
  plans: ProjectPlan[]
  files: ProjectFile[] | null
  onAnswer: (id: string, answer: { optionId?: string; note?: string }) => void
  onSeek: (t: number) => void
}) {
  const plan = d.refs?.planId ? plans.find((p) => p.id === d.refs!.planId) : undefined
  const assetIds = d.refs?.assetIds ?? []
  if (plan) return <PlanCard decision={d} plan={plan} onAnswer={onAnswer} />
  if (assetIds.length > 0) {
    return <AssetCard decision={d} assetIds={assetIds} files={files} onAnswer={onAnswer} />
  }
  return <QuestionCard decision={d} onAnswer={onAnswer} onSeek={onSeek} />
}

/** Approve / request-changes, shared by plan and asset cards. */
function Verdict({
  decisionId,
  onAnswer,
  approveLabel,
}: {
  decisionId: string
  onAnswer: (id: string, answer: { optionId?: string; note?: string }) => void
  approveLabel: string
}) {
  const [note, setNote] = useState('')
  return (
    <div className="review-verdict">
      <button className="review-approve" onClick={() => onAnswer(decisionId, { optionId: 'approve' })}>
        ✓ {approveLabel}
      </button>
      <form
        className="decision-note"
        onSubmit={(e) => {
          e.preventDefault()
          if (note.trim()) {
            onAnswer(decisionId, { optionId: 'request_changes', note: note.trim() })
          }
        }}
      >
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="what should change?"
        />
        {/* Disabled until the note says something: a bare rejection gives the
            agent nothing to iterate against. */}
        <button type="submit" disabled={!note.trim()} title="the note becomes the agent's brief">
          request changes
        </button>
      </form>
    </div>
  )
}

function PlanCard({
  decision: d,
  plan,
  onAnswer,
}: {
  decision: Decision
  plan: ProjectPlan
  onAnswer: (id: string, answer: { optionId?: string; note?: string }) => void
}) {
  return (
    <div className="decision open review-plan">
      <p className="decision-question">
        Plan rev {plan.revision} — {plan.summary}
      </p>
      <ol className="plan-scenes">
        {plan.scenes.map((s, i) => (
          <li key={i}>
            <strong>{s.title}</strong>
            {s.beats && <span className="plan-beats"> — {s.beats}</span>}
            {s.narration && <p className="plan-draft">“{s.narration}”</p>}
          </li>
        ))}
      </ol>
      <ul className="plan-assets">
        {plan.assets.map((a, i) => (
          <li key={i}>
            {a.kind} ×{a.count} · {a.model} — {a.description}{' '}
            <span className="plan-credits">{a.estCredits}cr</span>
          </li>
        ))}
        {plan.narrationTakes > 0 && (
          <li>
            narration ×{plan.narrationTakes} takes{' '}
            <span className="plan-credits">{plan.narrationEstCredits}cr</span>
          </li>
        )}
      </ul>
      <p className="plan-total">
        budget{' '}
        <strong>
          {plan.estTotalCredits} credit{plan.estTotalCredits === 1 ? '' : 's'}
        </strong>
        {plan.spentCredits > 0 && ` · ${planRemaining(plan)} left`}
        <span className="muted"> — rendering priced separately</span>
      </p>
      <Verdict decisionId={d.id} onAnswer={onAnswer} approveLabel="approve plan" />
    </div>
  )
}

function AssetCard({
  decision: d,
  assetIds,
  files,
  onAnswer,
}: {
  decision: Decision
  assetIds: string[]
  files: ProjectFile[] | null
  onAnswer: (id: string, answer: { optionId?: string; note?: string }) => void
}) {
  return (
    <div className="decision open review-assets">
      <p className="decision-question">{d.question}</p>
      {assetIds.map((id) => {
        const file = files?.find((f) => f.id === id)
        if (!file) {
          return (
            <p key={id} className="muted">
              {id} — no longer in the project
            </p>
          )
        }
        const previous = file.revises ? files?.find((f) => f.id === file.revises) : undefined
        return (
          <div key={id} className="review-asset">
            {/* The lineage strip: what was turned down beside what replaced
                it, which is the whole reason iteration review exists. */}
            {previous && (
              <div className="review-lineage">
                <figure>
                  <figcaption>
                    previous{previous.reviewNote ? ` — “${previous.reviewNote}”` : ''}
                  </figcaption>
                  <AssetPreview file={previous} />
                </figure>
                <figure>
                  <figcaption>new</figcaption>
                  <AssetPreview file={file} />
                </figure>
              </div>
            )}
            {!previous && <AssetPreview file={file} />}
            <p className="review-file-meta">
              {file.path} · {formatBytes(file.bytes)}
              {file.durationSec ? ` · ${file.durationSec.toFixed(1)}s` : ''}
            </p>
          </div>
        )
      })}
      <Verdict decisionId={d.id} onAnswer={onAnswer} approveLabel="approve" />
    </div>
  )
}

/**
 * The compact in-queue preview — the same renderers the file tabs use, sized
 * for a side panel. Video plays the scrubbing proxy (a person is watching);
 * a model shows its structure readout, since nothing here can draw one.
 */
function AssetPreview({ file }: { file: ProjectFile }) {
  const kind = viewerKind(file.mime, file.path)
  const url = assetUrl(file.id)
  switch (kind) {
    case 'image':
      return (
        <div className="image-view review-thumb">
          <img src={url} alt={file.path} />
        </div>
      )
    case 'video':
      return <video className="review-media" src={assetUrl(file.id, 'proxy')} controls playsInline />
    case 'audio':
      return <audio className="review-media" src={url} controls />
    case 'model':
      return <ModelView url={url} mime={file.mime} path={file.path} />
    default:
      return (
        <p className="muted">
          {assetBasename(file.path)} —{' '}
          <a href={url} target="_blank" rel="noreferrer">
            open ↗
          </a>
        </p>
      )
  }
}

/** A plain ask_user question — what the old Decisions panel rendered. */
function QuestionCard({
  decision: d,
  onAnswer,
  onSeek,
}: {
  decision: Decision
  onAnswer: (id: string, answer: { optionId?: string; note?: string }) => void
  onSeek: (t: number) => void
}) {
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

/**
 * The header's review-mode chip. State comes from the capability gateway —
 * the same `get_plan` / `set_review_mode` verbs the agent calls, over
 * `?format=json` — so there is no second REST surface to drift (plans/010).
 * No confirmation on the toggle: the click *is* the human deciding, which is
 * the only authority the gate defers to.
 */
export function ReviewModeToggle({ projectId }: { projectId: string }) {
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await fetch(`${API}/api/agent/tools/${name}/execute?format=json`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    })
    if (!res.ok) throw new Error(`${name}: ${res.status}`)
    return ((await res.json()) as { data: { reviewMode: boolean } }).data
  }

  useEffect(() => {
    let cancelled = false
    call('get_plan', { projectId })
      .then((data) => {
        if (!cancelled) setOn(data.reviewMode)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [projectId])

  if (on === null) return null
  return (
    <button
      className={`icon-btn review-toggle${on ? ' on' : ''}`}
      disabled={busy}
      title={
        on
          ? 'review mode: the agent needs your approval to spend credits or place generated assets'
          : 'review mode off: the agent generates and places without asking'
      }
      onClick={() => {
        setBusy(true)
        call('set_review_mode', { projectId, enabled: !on })
          .then((data) => setOn(data.reviewMode))
          .catch(() => {})
          .finally(() => setBusy(false))
      }}
    >
      {on ? '✓ review on' : 'review off'}
    </button>
  )
}
