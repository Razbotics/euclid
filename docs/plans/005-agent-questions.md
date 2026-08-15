# 005 — Agent questions (status: v1 done)

The agent stops deciding alone. When a choice is genuinely the human's —
pacing, style, how to resolve a narration overrun, whether a scene change
needs explaining — it asks, and waits.

Motivated by the Phase 5 milestone (plans/002): the pipeline reliably built a
*correct* video, but several judgement calls were made silently by the agent
and only surfaced when a human watched the export. Two of the six recorded
flaws — dead-air pacing and an unexplained cross-scene rewrite — are exactly
the kind of thing a human would have answered in one click.

## Where a question lives (the load-bearing decision)

**In the project's Durable Object, not in the chat.**

MCP has an `elicitation` capability that would ask through the client. It was
rejected for two reasons:

1. **Context.** "The narration overruns by 1.9s — how should I fix it?" is a
   question about a moment in a video. Answered in a chat window it is
   abstract; answered in the editor the human can seek to 4.2s and watch the
   problem first. The question carries an optional `atSec`, and the panel
   offers a "jump to" button.
2. **Portability.** Elicitation depends on client support. Riding the DO works
   with any MCP client, including none — the questions are just project state.

Consequences: questions broadcast over the **existing** WebSocket, so the
editor shows them live with no new transport; and they survive disconnects,
so a question asked before the editor was open is still there when it opens.

**Not part of `EuclidDoc`.** A decision is workflow state, not video content.
Putting it in the document would bump `SCHEMA_VERSION`, reach the renderer,
and make the render contract depend on something that never affects a frame.
It lives in DO storage under `dec:<id>` instead.

## Two answer surfaces, one record

The human can answer in the editor, or just tell the agent in chat — the
agent then calls `record_answer`. Both write the same record, and `answer.via`
records which (`'editor'` or `'agent'`), so it is always visible whether a
human clicked or an agent relayed.

**First answer wins.** Both surfaces are live at once, so the second is
rejected with 409 rather than silently overwriting. A quietly overwritten
answer is worse than a clear refusal.

## Shape

- [x] `packages/dsl/src/decisions.ts` — `Decision`, Zod schemas, and
      `formatDecision()` for cheap agent-facing text
- [x] DO: `GET/POST /decisions`, `POST /decisions/:id`, broadcast on both
- [x] API: `/api/projects/:id/decisions` (+ `/:decisionId/answer`), ownership
      gated through the existing `forwardToDO`
- [x] MCP: `ask_user`, `get_answer`, `record_answer` — all **free**
- [x] Editor: `Decisions.tsx` panel above the inspector, with per-option
      buttons, a free-text escape hatch, and a seek-to-moment button
- [x] `check-decisions.ts` drives the whole loop

Constraints worth keeping: 2–6 options (fewer is not a choice, more is a menu
dumped on a human), and an answer must carry an option **or** a note.

## Verified

`check-decisions.ts` (free): the editor is opened *before* the question is
asked, so arrival must come over the WebSocket rather than an initial fetch.
Covered — agent asks over MCP → question appears live with its detail, three
options, "1 waiting" badge and a "jump to 4.2s" button → `get_answer` reports
`[open]` → human clicks an option → agent reads back
`answered via editor: Extend the scene` → a second answer is refused
(`already_answered`) → the chat path records a free-text answer verbatim with
`via agent` and that too reaches the editor → a single-option question is
rejected. Zero console errors.

## Deliberately not done

- **The agent decides when to ask.** No hardcoded rule makes
  `generate_narration` ask on overrun. Judging whether something is ambiguous
  is the agent's job; the tool description tells it when asking is
  appropriate, and hardcoding would both fire when unwanted and miss the cases
  nobody predicted.
- **No blocking `ask_user`.** It returns immediately and the agent polls
  `get_answer`. A long-poll would read better in an agent loop but risks
  request-duration limits; revisit if polling proves annoying in practice.
- **No expiry or cancel.** An unanswered question stays open forever. Fine
  while projects are single-user and short-lived.

## Open question

Nothing forces the agent to *use* this. Whether it asks at sensible moments —
rather than never, or constantly — is a prompt/description problem that only
shows up in a real build. Worth watching in the next milestone run.
