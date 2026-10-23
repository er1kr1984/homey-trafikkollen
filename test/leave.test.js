'use strict';

const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/leave');

const MIN = 60000;
const T0 = Date.UTC(2026, 9, 26, 6, 0); // 07:00 Stockholm
const at = (m) => T0 + m * MIN;
const trip = (sched, o = {}) => ({ dep: { scheduled: at(sched), expected: at(o.exp ?? sched), realtime: o.rt !== false }, canceled: !!o.canceled, line: o.line || '165', mode: 'BUS' });

test('leave: walk and margin are taken off the departure', () => {
  const r = L.plan({ trips: [trip(20)], now: at(0), walk: 5, margin: 2, updated: at(0) });
  assert.strictEqual(r.next.leaveAt, at(13));
  assert.strictEqual(r.next.leaveIn, 13);
  assert.strictEqual(r.next.state, 'ok');
});

test('leave: a late bus is still planned at its timetable time (it can make up time)', () => {
  const r = L.plan({ trips: [trip(20, { exp: 26 })], now: at(0), walk: 5, margin: 2, updated: at(0) });
  assert.strictEqual(r.next.departAt, at(20));
  assert.strictEqual(r.next.late, 6);
});

test('leave: an early bus is planned at its early time', () => {
  const r = L.plan({ trips: [trip(20, { exp: 18 })], now: at(0), walk: 5, margin: 2, updated: at(0) });
  assert.strictEqual(r.next.departAt, at(18));
  assert.strictEqual(r.next.early, 2);
  assert.strictEqual(r.next.leaveIn, 11);
});

test('leave: cancelled trips are skipped and mentioned; passed leave times are not suggested', () => {
  const r = L.plan({ trips: [trip(8), trip(15, { canceled: true }), trip(30)], now: at(2), walk: 5, margin: 2, updated: at(2) });
  // 07:08 means leaving at 07:01: already passed by more than a minute
  assert.strictEqual(r.next.departAt, at(30));
  assert.strictEqual(r.cancelled.length, 1);
  assert.strictEqual(r.cancelled[0].scheduled, at(15));
});

test('leave: "leave now" for a minute, then the next trip', () => {
  const trips = [trip(10), trip(25)];
  assert.strictEqual(L.plan({ trips, now: at(3), walk: 5, margin: 2, updated: at(3) }).next.state, 'now');
  assert.strictEqual(L.plan({ trips, now: at(3) + 59000, walk: 5, margin: 2, updated: at(3) }).next.departAt, at(10));
  assert.strictEqual(L.plan({ trips, now: at(4) + 1000, walk: 5, margin: 2, updated: at(3) }).next.departAt, at(25));
});

test('leave: old data warns after 5 min and stops the countdown after 15', () => {
  const t = [trip(40)];
  assert.strictEqual(L.plan({ trips: t, now: at(0), updated: at(-4) }).stale, false);
  const warn = L.plan({ trips: t, now: at(0), updated: at(-6) });
  assert.strictEqual(warn.stale, true); assert.strictEqual(warn.stop, false);
  assert.strictEqual(L.plan({ trips: t, now: at(0), updated: at(-16) }).stop, true);
  assert.strictEqual(L.plan({ trips: t, now: at(0), updated: null }).stop, true);
});
