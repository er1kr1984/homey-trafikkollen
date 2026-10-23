'use strict';

const test = require('node:test');
const assert = require('node:assert');
const D = require('../lib/departures');
const { Usage, kindOf } = require('../lib/usage');
const tl = require('../lib/trafiklab');
const { Commutes, normaliseConfig } = require('../lib/commute');

const TZ = 'Europe/Stockholm';
const at = (local) => D.localToEpoch(local, TZ);

test('usage: counts by kind, rolls over by month, warns once at 80 and 100 %', () => {
  let saved = null;
  const u = new Usage({ load: () => null, save: (v) => { saved = v; }, tz: () => TZ });
  assert.strictEqual(kindOf('/departures/740000001'), 'boards');
  assert.strictEqual(kindOf('/departures/740000001/2026-10-23T16:00'), 'commutes');
  assert.strictEqual(kindOf('/arrivals/740000001/2026-10-23T16:00'), 'commutes');
  assert.strictEqual(kindOf('/stops/name/Lund'), 'search');
  assert.strictEqual(kindOf('/stops/list'), 'stoplist');

  const t = at('2026-10-11T12:00');
  for (let i = 0; i < 70; i++) u.count('/departures/1', { now: t });
  for (let i = 0; i < 10; i++) u.count('/arrivals/1/2026-10-11T12:00', { now: t, limited: i === 0 });
  const s = u.summary({ monthly: 100, perMinute: 25, now: t + 1000 });
  assert.strictEqual(s.total, 80);
  assert.deepStrictEqual(s.kinds, { boards: 70, commutes: 10, search: 0, stoplist: 0 });
  assert.strictEqual(s.percent, 80);
  assert.strictEqual(s.limited, 1);
  assert.strictEqual(s.projected, null); // not before 6 hours of counting
  const later = u.summary({ monthly: 100, perMinute: 25, now: t + 8 * 3600000 }); // 80 in 8 h, ~20 days left
  assert.ok(later.projected > 4500 && later.projected < 5500, `projected ${later.projected}`);
  assert.strictEqual(u.threshold(100), 80);
  assert.strictEqual(u.threshold(100), 0); // only once
  u.flush();
  assert.strictEqual(saved.total, 80);

  u.count('/departures/1', { now: at('2026-11-01T00:05') }); // new month
  const n = u.summary({ monthly: 100, perMinute: 25, now: at('2026-11-01T00:06') });
  assert.strictEqual(n.total, 1);
  assert.deepStrictEqual(n.previous, { month: '2026-10', total: 80 });
});

test('commute search looks further ahead when the next hour has no trip', async () => {
  // a quiet line: the only trip leaves 2 h 40 min after "now"
  const raw = (when, trip) => ({
    scheduled: when, realtime: when, delay: 0, canceled: false, is_realtime: false,
    route: { designation: '99', transport_mode: 'BUS', direction: 'Byn' }, trip: { trip_id: trip, start_date: '2026-10-23' },
  });
  const data = {
    'departures|A': [raw('2026-10-23T21:40:00', 'x')],
    'arrivals|B': [raw('2026-10-23T22:10:00', 'x')],
  };
  const calls = [];
  const orig = tl.board;
  tl.board = async (key, kind, id, when) => {
    calls.push(`${kind} ${id} ${when}`);
    const from = D.localToEpoch(when, TZ);
    return (data[`${kind}|${id}`] || []).filter((d) => { const t = D.localToEpoch(d.scheduled, TZ); return t >= from && t < from + 3600000; });
  };
  const realNow = Date.now;
  Date.now = () => at('2026-10-23T19:00');
  try {
    const cm = new Commutes({ keys: () => ({}), tz: () => TZ });
    const cfg = normaliseConfig({ id: 'q', origin: { id: 'A' }, destinations: [{ id: 'B', walk: 0 }] });
    const r = await cm.transit(cfg, TZ);
    assert.strictEqual(r.journeys.length, 1);
    assert.strictEqual(D.hhmm(r.journeys[0].leave, TZ), '21:40');
    assert.strictEqual(r.searchedHours, 3);
    assert.strictEqual(new Set(calls).size, calls.length, 'no hour is asked for twice');
  } finally { tl.board = orig; Date.now = realNow; }
});

test('usage: Trafikverket queries are grouped by what they ask for', () => {
  const { tvKindOf, TV_KINDS } = require('../lib/usage');
  const u = new Usage({ load: () => null, save: () => {}, tz: () => TZ, kindOf: tvKindOf, kinds: TV_KINDS });
  const now = at('2026-10-23T12:00');
  for (const t of ['Situation', 'Situation', 'RoadCondition', 'Camera', 'image', 'TrafficFlow', 'TrainAnnouncement', 'TrainStation', 'FerryRoute', 'WeatherMeasurepoint']) u.count(t, { now });
  const s = u.summary({ monthly: null, perMinute: null, now });
  assert.strictEqual(s.total, 10);
  assert.deepStrictEqual(s.kinds, { messages: 2, conditions: 1, cameras: 1, speed: 1, trains: 2, ferries: 1, weather: 1, images: 1 });
  assert.strictEqual(s.percent, null);
});
