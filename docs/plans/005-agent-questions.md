# 005 — Agent questions (status: v1 done)

The agent stops deciding alone. When a choice is genuinely the human's —
pacing, style, how to resolve a narration overrun, whether a scene change
needs explaining — it asks, and waits.

Motivated by the Phase 5 milestone (plans/002): the pipeline reliably built a
*correct* video, but several judgement calls were made silently by the agent
and only surfaced when a human watched the export. Two of the six recorded
flaws — dead-air pacing and an unexplained cross-scene rewrite — are exactly
the kind of thing a human would have answered in one click.

## Where a question is asked, and where it lives

**Asked in chat. Stored in the project's Durable Object.** These are
different things, and conflating them was the original design error.

The first version treated the editor as the place a question got asked, on
the grounds that "the narration overruns by 1.9s" is a question about a
moment in a video and the editor is where you can seek to it. That reasoning
still holds — but it assumed someone had a browser open. **The system can run
headless**: a cron job, CI, an agent on a server. A question that exists only
in a web panel is a question nobody is asked.

So chat is the surface that always exists. `ask_user` returns a
ready-to-paste block — question, numbered options, "reply with a number" —
and instructs the agent to put it in its next reply and stop. The DO copy is
what gives it persistence, an audit trail, and a **second** surface for
whoever does have the editor open, where the `atSec` seek button still adds
the context chat can't.

MCP's `elicitation` capability is now the **preferred** path: `ask_user`
calls `server.elicitInput()` when the client advertises support, so the human
answers in their client's own picker and the result travels client → server
with the agent never in the middle. That matters for correctness, not just
looks — on the fallback path the agent *interprets* the reply and calls
`record_answer`, which is why that provenance is recorded as `agent` while an
elicited answer is `chat`.

The attempt is bounded (`ELICIT_TIMEOUT_MS`, 30s) and falls back to the
pasteable block on decline, dismissal, timeout or any error. A client can
advertise the capability and still never deliver the request — observed with
a Streamable-HTTP client that wasn't reading the stream server-initiated
requests arrive on — so an unbounded wait would stall every question.

Consequences of the DO copy: questions broadcast over the **existing**
WebSocket, so the editor shows them live with no new transport, and they
survive disconnects — a question asked before the editor was open is still
there when it opens.

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
- ~~**No blocking `ask_user`.**~~ **This was wrong.** It returned a receipt
  ("asked (id)") and merely suggested polling. In the first real run the agent
  asked a good question at the right moment, scheduled a wakeup, built the
  rest of the video against its own guess, and mentioned the unanswered
  question only in its closing summary. A question that doesn't stop the asker
  is a log line, not a question.

  Fixed in the cheapest place that works: the **return value**, which is the
  strongest prompt surface available — the agent reads it the instant it
  lands. It now opens `STOP — WAITING ON THE HUMAN` and carries a
  ready-to-paste block for the human; `get_answer` repeats the instruction
  while anything is open, since polling and then carrying on is the same
  failure. Still no server-side long-poll: that risks request-duration
  limits, and wording is worth trying first.
- **No expiry or cancel.** An unanswered question stays open forever. Fine
  while projects are single-user and short-lived.

## What the first real run showed

The predicted failure was "the agent never asks". It did ask, unprompted and
at a sensible moment — how long the end card should hold in silence, with
three costed options and a seek-to-moment link. The actual failures were
different:

1. **It didn't wait.** Addressed above.
2. **The call never reached the MCP client.** The run happened in a session
   that had connected before these tools existed, so they weren't in its tool
   list; it discovered them from the docs and invoked them over raw JSON-RPC
   through Bash. The question reached the editor, but nothing in the chat knew
   a question existed — see the client-restart gotcha in
   [dev-setup](../dev-setup.md).

Still open: whether the wording alone makes it wait. Only a fresh run tells.
