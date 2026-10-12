'use strict';

const test = require('node:test');
const assert = require('node:assert');
const D = require('../lib/departures');
const tv = require('../lib/trafikverket');

const TZ = 'Europe/Stockholm';

const dep = (o) => ({
  scheduled: o.s, realtime: o.r || o.s, delay: o.delay || 0, canceled: !!o.canceled, is_realtime: true,
  route: { name: o.name, designation: o.line, transport_mode: o.mode || 'TRAIN', direction: o.dir || 'Stockholm C', destination: { name: o.dir || 'Stockholm C' } },
  trip: { trip_id: o.id || o.s, start_date: '2026-10-12' },
  agency: { name: 'SL' },
  realtime_platform: o.plat ? { designation: o.plat } : null,
});

test('local Stockholm time <-> epoch, summer and winter', () => {
  assert.strictEqual(new Date(D.localToEpoch('2026-10-12T07:42:00', TZ)).toISOString(), '2026-10-12T05:42:00.000Z'); // CEST
  assert.strictEqual(new Date(D.localToEpoch('2026-12-01T07:42:00', TZ)).toISOString(), '2026-12-01T06:42:00.000Z'); // CET
  assert.strictEqual(new Date(D.localToEpoch('2026-10-25T03:30:00', TZ)).toISOString(), '2026-10-25T02:30:00.000Z'); // after DST end
  assert.strictEqual(D.hhmm(Date.parse('2026-10-12T05:42:00Z'), TZ), '07:42');
});

test('active hours windows, weekdays and midnight crossing', () => {
  const mon0730 = Date.parse('2026-10-12T05:30:00Z');
  const sat0730 = Date.parse('2026-10-17T05:30:00Z');
  const w = D.parseWindows('06:30-09:00, 15:30-18:00');
  assert.deepStrictEqual(w, [[390, 540], [930, 1080]]);
  assert.strictEqual(D.isActive(mon0730, TZ, w, true), true);
  assert.strictEqual(D.isActive(sat0730, TZ, w, true), false);
  assert.strictEqual(D.isActive(sat0730, TZ, w, false), true);
  assert.strictEqual(D.isActive(Date.parse('2026-10-12T10:00:00Z'), TZ, w, false), false);
  assert.strictEqual(D.isActive(Date.parse('2026-10-12T23:30:00Z'), TZ, D.parseWindows('22:00-02:00'), false), true); // 01:30 local
  assert.strictEqual(D.isActive(mon0730, TZ, [], false), true);
});

test('filters: lines, direction, mode, platform', () => {
  const raw = [
    dep({ s: '2026-10-12T07:42:00', line: '1043', name: 'Pendeltåg', dir: 'Stockholm C', plat: '2' }),
    dep({ s: '2026-10-12T07:50:00', line: '1044', name: 'Pendeltåg', dir: 'Nynäshamn', plat: '1' }),
    dep({ s: '2026-10-12T07:45:00', line: '146', mode: 'BUS', dir: 'Stockholm Odenplan' }),
  ];
  assert.strictEqual(D.normalise(raw, TZ).length, 3);
  assert.deepStrictEqual(D.normalise(raw, TZ, { destination: 'stockholm' }).map((d) => d.line), ['1043', '146']);
  assert.deepStrictEqual(D.normalise(raw, TZ, { destination: 'stockholm', mode: 'TRAIN' }).map((d) => d.line), ['1043']);
  assert.deepStrictEqual(D.normalise(raw, TZ, { lines: '146, 999' }).map((d) => d.line), ['146']);
  assert.deepStrictEqual(D.normalise(raw, TZ, { lines: 'pendeltåg' }).map((d) => d.line), ['1043', '1044']);
  assert.deepStrictEqual(D.normalise(raw, TZ, { platform: '1' }).map((d) => d.line), ['1044']);
  assert.deepStrictEqual(D.normalise(raw, TZ, { destination: 'stockholm, -odenplan' }).map((d) => d.line), ['1043']);
  assert.deepStrictEqual(D.normalise(raw, TZ, { destination: '-nynäshamn' }).map((d) => d.line), ['1043', '146']);
});

test('sorted by expected time, delay and describe', () => {
  const raw = [
    dep({ s: '2026-10-12T07:42:00', r: '2026-10-12T07:55:00', delay: 780, line: '1043', name: 'Pendeltåg', plat: '2' }),
    dep({ s: '2026-10-12T07:50:00', line: '1045', name: 'Pendeltåg' }),
  ];
  const n = D.normalise(raw, TZ);
  assert.deepStrictEqual(n.map((d) => d.line), ['1045', '1043']);
  assert.strictEqual(n[1].delayMin, 13);
  assert.strictEqual(D.describe(n[1], TZ), '07:42 Pendeltåg 1043 → Stockholm C, platform 2 (+13 min, now 07:55)');
  assert.strictEqual(D.describe(D.normalise([dep({ s: '2026-10-12T08:00:00', line: '146', mode: 'BUS', name: '146' })], TZ)[0], TZ),
    '08:00 Bus 146 → Stockholm C');
});

test('next catchable skips cancelled and ones you cannot reach in time', () => {
  const raw = [
    dep({ s: '2026-10-12T07:40:00', line: 'A' }),                 // 3 min away, walk 5 -> missed
    dep({ s: '2026-10-12T07:45:00', line: 'B', canceled: true }), // cancelled
    dep({ s: '2026-10-12T07:50:00', line: 'C' }),
  ];
  const n = D.normalise(raw, TZ);
  const now = D.localToEpoch('2026-10-12T07:37:00', TZ);
  const next = D.nextCatchable(n, now, 5);
  assert.strictEqual(next.line, 'C');
  assert.deepStrictEqual(D.timing(next, now, 5), { minutes: 13, leaveIn: 8 });
});

test('trafikverket helpers: roads, points, distance', () => {
  const roads = tv.parseRoads('E65, väg 108 , 101');
  assert.deepStrictEqual([...roads], ['E65', '108', '101']);
  assert.strictEqual(tv.onRoads({ road: 'Väg 108' }, roads), true);
  assert.strictEqual(tv.onRoads({ road: 'E 65' }, roads), true);
  assert.strictEqual(tv.onRoads({ road: 'E6' }, roads), false);
  assert.strictEqual(tv.onRoads({ road: '', roadNumeric: 101 }, roads), true);
  assert.strictEqual(tv.onRoads({ road: 'E6' }, new Set()), true);
  assert.deepStrictEqual(tv.parsePoint('POINT (17.6389 59.8586)'), { lon: 17.6389, lat: 59.8586 });
  const km = tv.distanceKm({ lat: 59.8586, lon: 17.6389 }, { lat: 59.3303, lon: 18.0586 }); // Uppsala C -> Stockholm C
  assert.ok(km > 60 && km < 68, `distance ${km}`);
});

test('Swedish holidays', () => {
  const h = D.swedishHoliday;
  assert.strictEqual(h('2026-04-03'), 'Långfredagen'); // Easter 2026 = 5 April
  assert.strictEqual(h('2026-04-06'), 'Annandag påsk');
  assert.strictEqual(h('2026-05-14'), 'Kristi himmelsfärdsdag');
  assert.strictEqual(h('2026-06-19'), 'Midsommarafton');
  assert.strictEqual(h('2026-10-31'), 'Alla helgons dag');
  assert.strictEqual(h('2027-03-26'), 'Långfredagen'); // Easter 2027 = 28 March
  assert.strictEqual(h('2026-12-24'), 'Julafton');
  assert.strictEqual(h('2026-10-13'), null);
  // weekdays_only skips Midsummer Eve (a Friday)
  const midsummerEve8am = Date.UTC(2026, 5, 19, 6, 0);
  assert.strictEqual(D.isActive(midsummerEve8am, TZ, [], true), false);
  assert.strictEqual(D.isActive(Date.UTC(2026, 5, 18, 6, 0), TZ, [], true), true);
});

test('only specific departure times (the school bus)', () => {
  const raw = [dep({ s: '2026-10-13T07:40:00', line: '141', mode: 'BUS' }), dep({ s: '2026-10-13T07:50:00', line: '141', mode: 'BUS' }), dep({ s: '2026-10-13T15:10:00', line: '141', mode: 'BUS' })];
  assert.deepStrictEqual(D.normalise(raw, TZ, { times: '7.40, 15:10' }).map((d) => D.hhmm(d.scheduled, TZ)), ['07:40', '15:10']);
  assert.strictEqual(D.normalise(raw, TZ, { times: '' }).length, 3);
});
