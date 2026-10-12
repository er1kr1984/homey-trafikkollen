'use strict';

const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/alerts');
const P = require('../lib/plan');

const TZ = 'Europe/Stockholm';
const at = (hhmm) => P.timeOnDay(hhmm, Date.UTC(2026, 9, 13, 4, 0), TZ);
const leg = (line, hhmm, o = {}) => ({ mode: 'BUS', line, dep: { scheduled: at(hhmm), expected: at(hhmm), delayMin: 0 }, canceled: false, notes: [], ...o });
const journey = (hhmm, legs) => ({ leave: at(hhmm), arrive: at(hhmm) + 3600000, legs });

test('problems on the trips leaving soon and on the car route', () => {
  const data = {
    transit: {
      journeys: [
        journey('07:05', [leg('801', '07:10', { canceled: true })]),
        journey('07:20', [leg('801', '07:25', { dep: { scheduled: at('07:25'), expected: at('07:33'), delayMin: 8 } }), leg('1', '08:00', { mode: 'TRAM', notes: ['Diversion at Uppsala C'] })]),
        journey('07:35', [leg('801', '07:40', { dep: { scheduled: at('07:40'), expected: at('07:42'), delayMin: 2 } })]),
        journey('09:30', [leg('801', '09:35', { canceled: true })]), // too far ahead
      ],
    },
    drive: {
      incidents: [{ type: 'Olycka', road: 'E4', location: 'Uppsala S' }, { type: 'Vägarbete', road: '255', location: 'Knivsta' }],
      condition: { slippery: true, road: '255', text: 'Is' },
      speeds: [{ name: 'E4 Häggvik', speed: 35 }, { name: 'E4 Uppsala N', speed: 90 }],
    },
  };
  const issues = A.findIssues(data, {}, { tz: TZ, now: at('07:00') });
  assert.deepStrictEqual(issues.map((i) => i.key), [
    `cancel:801:${at('07:10')}`, `late:801:${at('07:25')}`, 'note:1:Diversion at Uppsala C',
    'road:E4:Uppsala S:Olycka', 'slippery', 'queue:E4 Häggvik',
  ]);
  assert.strictEqual(issues[1].text, 'bus 801 at 07:25 is 8 min late');
  assert.strictEqual(issues[2].text, 'tram 1: Diversion at Uppsala C');
  // a higher delay threshold drops the 8-minute delay
  assert.ok(!A.findIssues(data, { alert_delay: 10 }, { tz: TZ, now: at('07:00') }).some((i) => i.key.startsWith('late:')));
  const sv = A.findIssues(data, {}, { lang: 'sv', tz: TZ, now: at('07:00') });
  assert.strictEqual(sv[0].text, 'buss 801 07:10 är inställd');
});

test('with an arrive-by plan only the planned trip counts; stale data is ignored', () => {
  const planned = journey('07:20', [leg('801', '07:25', { dep: { scheduled: at('07:25'), expected: at('07:31'), delayMin: 6 } })]);
  const data = {
    transit: { journeys: [journey('07:05', [leg('801', '07:10', { canceled: true })]), planned] },
    plan: { arriveBy: at('08:30'), target: planned },
    drive: { stale: 'timeout', incidents: [{ type: 'Olycka', road: 'E4' }] },
  };
  assert.deepStrictEqual(A.findIssues(data, {}, { tz: TZ, now: at('07:00') }).map((i) => i.key), [`late:801:${at('07:25')}`]);
});

test('long-running and planned road messages are not news', () => {
  const now = at('07:00');
  const iso = (t) => new Date(t).toISOString();
  const data = {
    drive: {
      incidents: [
        { type: 'Trafikmeddelande', code: 'Vägen avstängd', road: 'E6', location: 'Rotebro', start: iso(now - 60 * 86400000) },
        { type: 'Trafikmeddelande', code: 'Hastighetsbegränsning gäller', road: 'E4', start: iso(now - 400 * 86400000) },
        { type: 'Olycka', road: 'E4', location: 'Uppsala S', start: iso(now - 20 * 60000) },
        { type: 'Trafikmeddelande', road: '255', location: 'Knivsta', start: iso(now + 86400000) },
      ],
    },
  };
  assert.deepStrictEqual(A.findIssues(data, {}, { tz: TZ, now }).map((i) => i.key), ['road:E4:Uppsala S:Olycka']);
});

test('summary is short enough for a phone', () => {
  const s = A.summary('Home → Work', [{ text: 'a' }, { text: 'b' }]);
  assert.strictEqual(s, 'Home → Work: a · b');
  assert.ok(A.summary('x', [{ text: 'y'.repeat(1000) }]).length <= 480);
});
