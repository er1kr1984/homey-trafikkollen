'use strict';

const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/plan');

const TZ = 'Europe/Stockholm';
const at = (hhmm) => P.timeOnDay(hhmm, Date.UTC(2026, 9, 13, 4, 0), TZ);
const j = (leave, arrive, o = {}) => ({ leave: at(leave), arrive: at(arrive), canceled: false, legs: [{ mode: 'BUS', line: '801', dep: { expected: at(leave) + 5 * 60000, delayMin: 0 }, notes: [] }], ...o });

test('arrive-by picks the latest trip that still makes it', () => {
  const js = [j('06:55', '07:56'), j('07:10', '08:11'), j('07:25', '08:26')];
  assert.strictEqual(P.pickTarget(js, at('06:30'), at('08:15')).leave, at('07:10'));
  assert.strictEqual(P.pickTarget(js, at('06:30'), at('08:15')).late, false);
  const late = P.pickTarget(js, at('06:30'), at('07:50'));
  assert.strictEqual(late.late, true);
  assert.strictEqual(late.leave, at('06:55')); // earliest arrival
  assert.strictEqual(P.pickTarget(js, at('07:00'), null).leave, at('07:10')); // no arrive-by: next one
  assert.strictEqual(P.pickTarget([], at('07:00'), null), null);
});

test('engine heater lead time and frost', () => {
  assert.deepStrictEqual([12, 10, 5, 0, -1, -10, -11, -25].map(P.heaterMinutes), [0, 0, 30, 30, 60, 60, 90, 120]);
  assert.strictEqual(P.frostLikely(0.5, null), true);
  assert.strictEqual(P.frostLikely(3, -0.2), true);
  assert.strictEqual(P.frostLikely(3, 2), false);
});

test('briefing text', () => {
  const data = { name: 'Home → Work', transit: { journeys: [] }, drive: { minutes: 30, incidentCount: 2, condition: { slippery: false } } };
  const target = j('07:10', '08:11');
  const en = P.briefing(data, target, { lang: 'en', tz: TZ, frost: true, weatherHour: { temp: 0.6, text: 'Clear', precip: 0 } });
  assert.strictEqual(en, 'Home → Work: Leave at 07:10: bus 801 at 07:15. There at 08:11. By car about 30 min, 2 traffic messages on the way. 1° and clear. Frost likely: scrape the car.');
  const sv = P.briefing(data, target, { lang: 'sv', tz: TZ });
  assert.ok(sv.startsWith('Home → Work: Gå 07:10: buss 801 07:15. Framme 08:11. Med bil cirka 30 min, 2 trafikmeddelanden'), sv);
});
