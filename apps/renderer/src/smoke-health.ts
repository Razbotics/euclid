/**
 * The render worker's health verdict — whether the **drain loop** is alive.
 * Run: pnpm --filter @euclid/renderer exec tsx src/smoke-health.ts
 *
 * Free, no network. Here rather than in a check script because the states that
 * matter are ones no live worker holds still in: a loop that has stopped while
 * the process outlives it, and a loop busy long enough to look dead. Reaching
 * either against a running worker means contriving a hang; as arithmetic they
 * are four lines.
 *
 * What is being defended is a real incident. `/health` answered a flat `ok`
 * from the HTTP listener, so a worker whose loop had exited went on reporting
 * healthy while render jobs sat queued with the credits already spent — and
 * two check runs spent two minutes each timing out before anyone looked at the
 * process.
 */
import assert from 'node:assert'
import { healthVerdict, idleStaleMs, type Phase } from './health'

const POLL = 3000
/** Verdict for a phase held for `sinceLastPoll` ms without a poll. */
const at = (phase: Phase, sinceLastPoll: number) =>
  healthVerdict({ phase, lastPollAt: 0, now: sinceLastPoll, pollMs: POLL })

// ---------- a loop that is turning ----------
assert.ok(at('idle', 0).ok, 'a fresh poll is healthy')
assert.ok(at('idle', POLL).ok, 'and one poll interval later still is')
assert.ok(at('starting', 60_000).ok, 'a worker still booting has not failed anything yet')

// ---------- a loop that has stopped ----------
const stopped = at('stopped', 0)
assert.equal(stopped.ok, false, 'a stopped loop is unhealthy however recently it polled')
assert.match(stopped.reason ?? '', /stopped/, 'and says so, because this one needs a restart')

// ---------- a loop that is idle but no longer polling ----------
assert.ok(at('idle', idleStaleMs(POLL)).ok, 'exactly at the bound is still healthy')
const stale = at('idle', idleStaleMs(POLL) + 1)
assert.equal(stale.ok, false, 'past it is not')
assert.match(stale.reason ?? '', /not polling/, 'and is a different failure from "stopped"')
assert.notEqual(stopped.reason, stale.reason, 'the two 503s must be distinguishable')

// ---------- the judgement worth testing: busy is not dead ----------
//
// A render or a transcode goes minutes without touching the top of the loop.
// If staleness applied to those phases, health would fail on precisely the
// worker doing the most work — a false alarm that would teach everyone to
// ignore it.
for (const busy of ['probe', 'shots', 'proxy', 'render'] as const) {
  assert.ok(
    at(busy, 30 * 60_000).ok,
    `${busy} for half an hour must read healthy — it is work in progress, not a dead loop`,
  )
}

console.log(
  `health smoke OK — stopped is unhealthy at any age, idle goes stale past ` +
    `${idleStaleMs(POLL)}ms (${POLL}ms polls), the two 503s name different causes, and four busy ` +
    `phases stay healthy after 30 minutes without a poll.`,
)
