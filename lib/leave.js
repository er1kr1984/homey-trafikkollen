'use strict';

// "Time to leave" countdown, deliberately cautious so nobody misses a bus because of the app:
// - plan by the EARLIER of the timetable and the live time: a late bus can make up time, an early one really leaves early
// - subtract the walk AND a safety margin
// - never count down on old data: warn after STALE_WARN, stop the countdown after STALE_STOP
// - cancelled trips are skipped (and mentioned); a trip whose leave time has passed is not suggested any more

const MIN = 60000;
const STALE_WARN = 5 * MIN;
const STALE_STOP = 15 * MIN;
const GRACE = MIN; // "leave now" stays up this long after the leave time, then the next trip is shown

/**
 * trips: [{ dep: { scheduled, expected, realtime, delayMin }, canceled, line, mode, direction, platform, arrive, legs }]
 * walk: minutes to the stop; margin: extra safety minutes; updated: when the data was fetched (epoch ms)
 * Returns { next, then, cancelled, ageMin, stale, stop } where next/then items carry
 * { leaveAt, leaveIn, departAt, state: 'ok'|'soon'|'hurry'|'now', late, early, noRealtime }
 */
function plan({ trips, now, walk = 0, margin = 2, updated }) {
  const age = updated ? Math.max(0, now - updated) : Infinity;
  const out = { ageMin: Number.isFinite(age) ? Math.floor(age / MIN) : null, stale: age > STALE_WARN, stop: age > STALE_STOP, next: null, then: [], cancelled: [] };
  const timed = (trips || []).filter((t) => t && t.dep && t.dep.scheduled).map((t) => {
    const expected = t.dep.expected || t.dep.scheduled;
    const departAt = Math.min(t.dep.scheduled, expected);
    const leaveAt = departAt - (walk + margin) * MIN;
    const late = expected - t.dep.scheduled >= MIN ? Math.round((expected - t.dep.scheduled) / MIN) : 0;
    const early = t.dep.scheduled - expected >= MIN ? Math.round((t.dep.scheduled - expected) / MIN) : 0;
    return { ...t, departAt, leaveAt, late, early, noRealtime: t.dep.realtime === false };
  }).sort((a, b) => a.leaveAt - b.leaveAt);

  const usable = timed.filter((t) => !t.canceled && t.leaveAt > now - GRACE);
  out.cancelled = timed.filter((t) => t.canceled && t.dep.scheduled > now - 5 * MIN && (!usable[0] || t.dep.scheduled <= usable[0].departAt + 30 * MIN))
    .slice(0, 2).map((t) => ({ line: t.line, scheduled: t.dep.scheduled, direction: t.direction }));
  const withState = (t) => {
    const leaveIn = Math.floor((t.leaveAt - now) / MIN);
    const state = leaveIn <= 0 ? 'now' : leaveIn <= 3 ? 'hurry' : leaveIn <= 10 ? 'soon' : 'ok';
    return { ...t, leaveIn, state };
  };
  if (usable.length) {
    out.next = withState(usable[0]);
    out.then = usable.slice(1, 3).map(withState);
  }
  return out;
}

module.exports = { plan, STALE_WARN, STALE_STOP };
