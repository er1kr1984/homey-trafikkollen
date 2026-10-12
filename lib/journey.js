'use strict';

// Door-to-door journeys built from departure/arrival boards by following trip ids:
//   origin departure --(same trip)--> transfer arrival, then
//   transfer departure --(same trip)--> destination arrival (+ walk to the final address).
// A trip that reaches a destination stop straight from the origin is a direct journey.
// Pure functions on normalised departures (lib/departures.normalise), so they can be unit tested.

const MIN = 60000;

/** First arrival of trip `key` at one of `arrs` after `after` (a loop line can pass a stop twice). */
function arrivalOf(arrs, key, after) {
  let best = null;
  for (const a of arrs) {
    if (a.key === key && !a.canceled && a.expected > after && (!best || a.expected < best.expected)) best = a;
  }
  return best;
}

/**
 * opts: {
 *   first:     departures from the origin,
 *   transfer:  { arrivals, departures } at the change stop (optional),
 *   dests:     [{ name, walk, arrivals }] stops near the final address,
 *   walkTo:    minutes from home to the origin stop,
 *   change:    minimum minutes to change at the transfer stop,
 *   now, maxSecond: how many onward departures to try per arrival (default 10)
 * }
 * Returns journeys sorted by leave time, Pareto-filtered (nothing that leaves earlier and arrives no sooner).
 * Journey: { leave, arrive, legs: [{ dep, arr }], slack (spare minutes beyond `change`, null if direct), canceled, problem }
 */
function build(opts) {
  const { first = [], transfer = null, dests = [], walkTo = 0, change = 3, now = Date.now(), maxSecond = 10 } = opts;
  const out = [];
  const cancelled = [];
  for (const dep of first) {
    if (dep.expected - walkTo * MIN < now - MIN) continue;
    const reachesTransfer = transfer && arrivalOf(transfer.arrivals, dep.key, dep.expected);
    if (dep.canceled) {
      // a cancelled trip has no live arrivals; keep it for display if its line normally goes our way
      cancelled.push({ leave: dep.scheduled - walkTo * MIN, arrive: null, legs: [{ dep, arr: null }], slack: null, canceled: true, problem: true });
      continue;
    }
    let best = null;
    for (const d of dests) {
      const a = arrivalOf(d.arrivals, dep.key, dep.expected);
      if (!a) continue;
      const j = { leave: dep.expected - walkTo * MIN, arrive: a.expected + (d.walk || 0) * MIN, legs: [{ dep, arr: a }], slack: null, dest: d.name };
      if (!best || j.arrive < best.arrive) best = j;
    }
    if (reachesTransfer) {
      const t = reachesTransfer;
      const onward = transfer.departures
        .filter((x) => !x.canceled && x.expected >= t.expected + change * MIN)
        .sort((a, b) => a.expected - b.expected)
        .slice(0, maxSecond);
      for (const c of onward) {
        for (const d of dests) {
          const a = arrivalOf(d.arrivals, c.key, c.expected);
          if (!a) continue;
          const j = {
            leave: dep.expected - walkTo * MIN,
            arrive: a.expected + (d.walk || 0) * MIN,
            legs: [{ dep, arr: t }, { dep: c, arr: a }],
            slack: Math.round((c.expected - t.expected) / MIN) - change,
            dest: d.name,
          };
          if (!best || j.arrive < best.arrive || (j.arrive === best.arrive && j.legs.length < best.legs.length)) best = j;
        }
      }
    }
    if (best) {
      best.canceled = false;
      best.problem = best.legs.some((l) => l.dep.delayMin >= 3);
      out.push(best);
    }
  }
  // Pareto: drop a journey if another leaves at the same time or later and arrives no later.
  out.sort((a, b) => a.leave - b.leave || a.arrive - b.arrive);
  const keep = out.filter((j, i) => !out.some((o, k) => k !== i && o.leave >= j.leave && o.arrive <= j.arrive
    && (o.leave > j.leave || o.arrive < j.arrive || k > i)));
  // cancelled departures are only worth showing for line+direction combinations that otherwise appear in the result
  const routeOf = (d) => `${d.line}|${d.direction}`;
  const routes = new Set(keep.map((j) => routeOf(j.legs[0].dep)));
  const shownCancelled = cancelled.filter((c) => routes.has(routeOf(c.legs[0].dep)));
  return [...keep, ...shownCancelled].sort((a, b) => a.leave - b.leave);
}

module.exports = { build, arrivalOf };
