'use strict';

const test = require('node:test');
const assert = require('node:assert');
const J = require('../lib/journey');
const D = require('../lib/departures');
const { nextWindow, parseConfigs } = require('../lib/commute');

const T0 = Date.UTC(2026, 9, 13, 5, 0); // 07:00 Stockholm
const m = (min) => T0 + min * 60000;
const v = (key, line, at, o = {}) => ({
  key, line, mode: o.mode || 'BUS', direction: o.dir || 'Uppsala C', scheduled: m(at), expected: m(at + (o.delay || 0)),
  delayMin: o.delay || 0, canceled: !!o.canceled, stop: o.stop || '',
});

const home = [
  v('b1', '801', 0), v('t1', '40', 14, { mode: 'TRAIN', dir: 'Stockholm C' }), v('b2', '801', 15), v('x', '809', 16, { dir: 'Märsta' }),
];
const hubArr = [v('b1', '801', 39, { stop: 'Uppsala C' }), v('t1', '40', 56, { stop: 'Uppsala C' }), v('b2', '801', 54, { stop: 'Uppsala C' })];
const hubDep = [v('tr1', '1', 41, { mode: 'TRAM' }), v('tr2', '1', 45, { mode: 'TRAM' }), v('tr3', '1', 57, { mode: 'TRAM' }), v('tr4', '1', 60, { mode: 'TRAM' }),
  v('s6', '6', 50, { dir: 'Gottsunda' })];
const work = [v('tr1', '1', 47), v('tr2', '1', 51), v('tr3', '1', 63), v('tr4', '1', 66), v('s6', '6', 40) /* passes Science Park before Uppsala C */];

const opts = (over = {}) => ({
  first: home, transfer: { arrivals: hubArr, departures: hubDep }, dests: [{ name: 'Science Park', walk: 8, arrivals: work }],
  walkTo: 5, change: 3, now: m(-10), ...over,
});

test('journey: follows trips through the change, respects change time and direction', () => {
  const js = J.build(opts());
  // bus b1 arrives 39 -> tram 41 is too tight (3 min change) -> tram 45 -> 51 + 8 walk
  assert.strictEqual(js[0].legs[0].dep.key, 'b1');
  assert.strictEqual(js[0].legs[1].dep.key, 'tr2');
  assert.strictEqual(js[0].arrive, m(59));
  assert.strictEqual(js[0].leave, m(-5));
  assert.strictEqual(js[0].slack, 3);
  // the 809 to Märsta never reaches Uppsala; bus 6 towards Gottsunda reached Science Park before Uppsala C
  assert.ok(!js.some((j) => j.legs[0].dep.key === 'x'));
  assert.ok(!js.some((j) => j.legs[1] && j.legs[1].dep.key === 's6'));
});

test('journey: drops options that leave earlier and arrive no sooner (train vs later bus)', () => {
  const js = J.build(opts());
  // train 14 -> Uppsala 56 -> tram 60 -> 66+8; bus 15 -> 54 -> tram 57 -> 63+8: the bus wins
  assert.deepStrictEqual(js.map((j) => j.legs[0].dep.key), ['b1', 'b2']);
});

test('journey: delays propagate and cancelled departures are shown for known routes only', () => {
  const late = [v('b1', '801', 0, { delay: 4 }), v('b2', '801', 15, { canceled: true }), v('c', '999', 20, { canceled: true })];
  const arr = [v('b1', '801', 43, { stop: 'Uppsala C' })];
  const js = J.build(opts({ first: late, transfer: { arrivals: arr, departures: hubDep } }));
  assert.strictEqual(js[0].legs[1].dep.key, 'tr3'); // 43 + 3 -> 57
  assert.strictEqual(js[0].problem, true);
  assert.deepStrictEqual(js.filter((j) => j.canceled).map((j) => j.legs[0].dep.key), ['b2']);
});

test('journey: direct trips to a destination stop', () => {
  const js = J.build({ first: [v('d', '103', 0)], transfer: null, dests: [{ name: 'Science Park', walk: 5, arrivals: [v('d', '103', 50)] }], now: m(-5) });
  assert.strictEqual(js.length, 1);
  assert.strictEqual(js[0].arrive, m(55));
  assert.strictEqual(js[0].slack, null);
});

test('commute: next window skips to the next weekday after the window has passed', () => {
  const cfg = { active_hours: '06:30-09:00', weekdays_only: true };
  const fri = Date.UTC(2026, 9, 16, 10, 0); // Fri 12:00 local
  const [s, e] = nextWindow(fri, 'Europe/Stockholm', cfg);
  assert.strictEqual(new Date(s).toISOString(), '2026-10-19T04:30:00.000Z'); // Monday 06:30
  assert.strictEqual(new Date(e).toISOString(), '2026-10-19T07:00:00.000Z');
  const [s2] = nextWindow(Date.UTC(2026, 9, 13, 5, 0), 'Europe/Stockholm', cfg); // Tue 07:00 -> today
  assert.strictEqual(new Date(s2).toISOString(), '2026-10-13T04:30:00.000Z');
});

test('commute: config validation', () => {
  assert.throws(() => parseConfigs([{ id: 'a' }]), /origin/);
  const [c] = parseConfigs('[{"origin":{"id":1},"destinations":[{"id":2,"walk":"8"}]}]');
  assert.strictEqual(c.id, 'commute1');
  assert.strictEqual(c.destinations[0].walk, 8);
  assert.strictEqual(c.change_minutes, 3);
});

test('commute: car only between two addresses (no stops, no public transport calls)', async () => {
  const { Commutes } = require('../lib/commute');
  assert.throws(() => parseConfigs([{ mode: 'car', origin: { name: 'Hem' } }]), /origin needs lat\/lon/);
  const [c] = parseConfigs([{
    id: 'car', name: 'Till jobbet', mode: 'car', arrive_by: '08:00', active_hours: '06:00-09:00', weekdays_only: false, weather: true,
    origin: { name: 'Storgatan 1, Uppsala', lat: 59.858, lon: 17.639 }, place: { name: 'Kungsgatan 2, Stockholm', lat: 59.335, lon: 18.064 },
    drive: { minutes: 50, roads: 'E4' },
  }]);
  assert.strictEqual(c.mode, 'car');
  assert.deepStrictEqual(c.destinations, []);
  assert.ok(c.drive.enabled && Number.isFinite(c.drive.lat) && c.drive.radius_km > 30, 'route area worked out from the two addresses');
  assert.strictEqual(c.weather.length, 2);

  const TZ = 'Europe/Stockholm';
  const now = D.localToEpoch('2026-10-13T06:45', TZ);
  const realNow = Date.now; Date.now = () => now;
  try {
    const cm = new Commutes({ keys: () => ({}), tz: () => TZ });
    cm.drive = async () => ({ minutes: 50, incidentCount: 1, updated: now });
    cm.weather = async () => ({ places: [] });
    cm.transit = async () => { throw new Error('car-only commute must not call public transport'); };
    const r = await cm.get(c);
    assert.strictEqual(r.transit, null);
    assert.strictEqual(r.mode, 'car');
    assert.strictEqual(r.plan.target.car, true);
    assert.strictEqual(D.hhmm(r.plan.target.leave, TZ), '07:10'); // 08:00 minus 50 min
    assert.strictEqual(r.plan.target.late, false);
    const text = require('../lib/plan').briefing(r, r.plan.target, { lang: 'sv', tz: TZ });
    assert.match(text, /Åk med bil 07:10, framme 08:00/);
  } finally { Date.now = realNow; }
});

test('commute cache: widgets get the old value at once while a fresh one is fetched (stale-while-revalidate)', async () => {
  const { Commutes } = require('../lib/commute');
  const cm = new Commutes({ keys: () => ({}), tz: () => 'Europe/Stockholm' });
  let n = 0;
  let release;
  const slow = () => new Promise((ok) => { n += 1; release = () => ok({ v: n, updated: Date.now() }); });
  const first = cm.cached('x', 1000, slow);
  release();
  assert.strictEqual((await first).v, 1);
  cm.cache.get('x').at -= 5000; // expire it
  const quick = await cm.cached('x', 1000, slow, true); // swr: old value, no waiting
  assert.strictEqual(quick.v, 1);
  assert.strictEqual(n, 2, 'a refresh was started');
  release();
  await cm.cache.get('x').promise;
  assert.strictEqual((await cm.cached('x', 1000, slow, true)).v, 2);
});
