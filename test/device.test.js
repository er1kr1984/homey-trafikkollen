'use strict';

// Drives the departure device with a fake Homey runtime and a fake Trafiklab, controlling the clock.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

class FakeDevice {
  constructor(settings) { this._s = settings; this._caps = {}; this._avail = true; this.triggered = []; }
  getSettings() { return this._s; } getData() { return { id: '740000999' }; }
  getCapabilityValue(c) { return this._caps[c] ?? null; } async setCapabilityValue(c, v) { this._caps[c] = v; }
  hasCapability(c) { return !(this._off || new Set()).has(c); }
  async addCapability(c) { (this._off || new Set()).delete(c); } async removeCapability(c) { (this._off = this._off || new Set()).add(c); delete this._caps[c]; }
  getAvailable() { return this._avail; } async setAvailable() { this._avail = true; } async setUnavailable(m) { this._avail = false; this.why = m; }
  log() {} error(...a) { this.errors = (this.errors || []).concat(a.join(' ')); }
}
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'homey' ? { Device: FakeDevice, Driver: class {}, App: class {} } : origLoad.call(this, req, ...rest); };

const tl = require('../lib/trafiklab');
const D = require('../lib/departures');
const DepartureDevice = require('../drivers/departures/device');
const App = require('../app');
const TZ = 'Europe/Stockholm';

function make(settings, feed) {
  const dev = new DepartureDevice({
    walk_minutes: 5, remind_before: 5, delay_threshold: 3, active_hours: '06:30-09:00', weekdays_only: true, poll_minutes: 1, mode: 'any', ...settings,
  });
  dev.homey = {
    clock: { getTimezone: () => TZ },
    settings: { get: () => 'KEY' },
    flow: { getDeviceTriggerCard: (id) => ({ trigger: async (d, tokens, state) => { if (id === 'departure_in') (d.inTriggered = d.inTriggered || []).push(state.minutes); else d.triggered.push([id, tokens.text]); } }) },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
    app: { friendly: (e) => App.prototype.friendly.call({ homey: { __: (k) => k } }, e), t: (k) => k },
  };
  Object.assign(dev, { deps: [], lastFetch: 0, fired: {}, triggered: [], seeded: false }); // what onInit() sets up
  tl.departures = async () => ({ departures: feed() });
  return dev;
}
const dep = (s, o = {}) => ({
  scheduled: s, realtime: o.r || s, delay: o.delay || 0, canceled: !!o.canceled, is_realtime: true,
  route: { name: 'Pendeltåg', designation: o.line || '1043', transport_mode: 'TRAIN', direction: 'Stockholm C' },
  trip: { trip_id: o.id || s, start_date: '2026-10-12' },
});
let clock;
const realNow = Date.now;
const at = (local) => { clock = D.localToEpoch(local, TZ); };
Date.now = () => clock;

test('time to leave fires once, at remind_before, during active hours', async () => {
  const feed = [dep('2026-10-12T07:42:00')];
  const dev = make({}, () => feed);
  at('2026-10-12T07:20:00'); await dev.tick();                 // seeding, 22 min away
  assert.deepStrictEqual(dev.triggered, []);
  assert.strictEqual(dev.getCapabilityValue('dep_leave_in'), 17);
  at('2026-10-12T07:31:00'); await dev.tick();                 // leave in 6 -> nothing yet
  assert.deepStrictEqual(dev.triggered, []);
  at('2026-10-12T07:32:00'); await dev.tick();                 // leave in 5 -> fire
  at('2026-10-12T07:33:00'); await dev.tick();                 // no repeat
  assert.deepStrictEqual(dev.triggered, [['time_to_leave', 'Leave in 5 min for the 07:42 Pendeltåg 1043 → Stockholm C']]);
});

test('delay fires at threshold, again only when +5 more; cancel fires once', async () => {
  let feed = [dep('2026-10-12T07:42:00')];
  const dev = make({ remind_before: 0 }, () => feed);
  at('2026-10-12T07:00:00'); await dev.tick();
  feed = [dep('2026-10-12T07:42:00', { r: '2026-10-12T07:44:00', delay: 120 })];
  at('2026-10-12T07:02:00'); await dev.tick();                 // 2 min: below threshold
  feed = [dep('2026-10-12T07:42:00', { r: '2026-10-12T07:46:00', delay: 240 })];
  at('2026-10-12T07:03:00'); await dev.tick();                 // 4 min: fire
  feed = [dep('2026-10-12T07:42:00', { r: '2026-10-12T07:48:00', delay: 360 })];
  at('2026-10-12T07:04:00'); await dev.tick();                 // 6: not +5 yet
  feed = [dep('2026-10-12T07:42:00', { r: '2026-10-12T07:51:00', delay: 540 })];
  at('2026-10-12T07:05:00'); await dev.tick();                 // 9: fire again
  feed = [dep('2026-10-12T07:42:00', { canceled: true })];
  at('2026-10-12T07:06:00'); await dev.tick();
  at('2026-10-12T07:07:00'); await dev.tick();
  assert.deepStrictEqual(dev.triggered.map((f) => f[0]), ['departure_delayed', 'departure_delayed', 'departure_canceled']);
  assert.match(dev.triggered[0][1], /^4 min late: 07:42 Pendeltåg 1043/);
  assert.strictEqual(dev.getCapabilityValue('alarm_dep_problem'), false); // cancelled one is no longer "next"; nothing else in feed
});

test('already-delayed trip at startup does not alert; outside active hours nothing fires', async () => {
  const feed = [dep('2026-10-12T07:42:00', { r: '2026-10-12T07:52:00', delay: 600 })];
  const dev = make({}, () => feed);
  at('2026-10-12T07:00:00'); await dev.tick();
  assert.deepStrictEqual(dev.triggered, []);
  assert.strictEqual(dev.getCapabilityValue('alarm_dep_problem'), true);
  assert.strictEqual(dev.getCapabilityValue('dep_delay'), 10);

  const feed2 = [dep('2026-10-12T12:42:00')];
  const dev2 = make({}, () => feed2);
  at('2026-10-12T12:00:00'); await dev2.tick();
  at('2026-10-12T12:32:00'); await dev2.tick();                // leave time hits but 12:32 is outside 06:30-09:00
  assert.deepStrictEqual(dev2.triggered, []);
});

test('bad key makes the device unavailable with a clear message', async () => {
  const dev = make({}, () => []);
  tl.departures = async () => { throw new Error('Trafiklab rejected the API key (check it in the app settings)'); };
  at('2026-10-12T07:00:00'); await dev.tick();
  assert.strictEqual(dev._avail, false);
  assert.strictEqual(dev.why, 'errors.badTrafiklabKey'); // translated, with where to fix it
});

test.after(() => { Date.now = realNow; Module._load = origLoad; });

test('operator messages fire "a departure has a message" once per message', async () => {
  const feed = [{ ...dep('2026-10-12T07:42:00'), alerts: [{ title: 'Försening', text: 'Tåget är försenat. Orsaken är tågkö.' }] }];
  const dev = make({}, () => feed);
  at('2026-10-12T07:20:00'); await dev.tick(); // seeding: already there at start, no alert
  feed[0] = { ...feed[0], alerts: [...feed[0].alerts, { text: 'Ersättningsbussar ersätter tåg.' }] };
  dev.lastFetch = 0;
  at('2026-10-12T07:22:00'); await dev.tick();
  dev.lastFetch = 0;
  at('2026-10-12T07:23:00'); await dev.tick();
  assert.deepStrictEqual(dev.triggered.filter(([id]) => id === 'departure_disruption').map(([, t]) => t),
    ['07:42 Pendeltåg 1043 → Stockholm C: Ersättningsbussar ersätter tåg.']);
});

test('fields to show: hidden fields are removed, "leave in" goes when there is no walk', async () => {
  const dev = make({}, () => []);
  await dev.syncFields({ walk_minutes: 5, show_leave_in: true, show_delay: false, show_upcoming: true });
  assert.deepStrictEqual([dev.hasCapability('dep_leave_in'), dev.hasCapability('dep_delay'), dev.hasCapability('dep_upcoming')], [true, false, true]);
  await dev.syncFields({ walk_minutes: 0, show_leave_in: true, show_delay: true, show_upcoming: false });
  assert.deepStrictEqual([dev.hasCapability('dep_leave_in'), dev.hasCapability('dep_delay'), dev.hasCapability('dep_upcoming')], [false, true, false]);
  at('2026-10-12T07:00:00');
  await dev.tick(); // must not try to write hidden fields
  assert.strictEqual(dev.getCapabilityValue('dep_leave_in'), null);
  assert.ok(!dev.errors, String(dev.errors));
});

test('no catchable departure: says whether there are none, or none you can reach in time', async () => {
  at('2026-10-12T07:15:00');
  const dev = make({ walk_minutes: 25 }, () => [dep('2026-10-12T07:30:00')]); // 15 min away, 25 min walk
  await dev.tick();
  assert.strictEqual(dev.getCapabilityValue('dep_next'), 'device.noneReachable');
  const empty = make({ walk_minutes: 25 }, () => []);
  await empty.tick();
  assert.strictEqual(empty.getCapabilityValue('dep_next'), 'device.noneHour');
});

test('"a departure leaves in N minutes": every minute value once, none at start, not again after a delay', async () => {
  let feed = [dep('2026-10-12T07:42:00')];
  const dev = make({}, () => feed);
  at('2026-10-12T07:30:00'); await dev.tick(); // seeding, 12 min away
  assert.deepStrictEqual(dev.inTriggered || [], []);
  at('2026-10-12T07:31:00'); await dev.tick(); // 11
  at('2026-10-12T07:33:00'); await dev.tick(); // 9: 10 and 9 (a skipped tick still fires the minute in between)
  assert.deepStrictEqual(dev.inTriggered, [11, 10, 9]);
  feed = [dep('2026-10-12T07:42:00', { r: '2026-10-12T07:45:00', delay: 180 })]; dev.lastFetch = 0;
  at('2026-10-12T07:34:00'); await dev.tick(); // now 11 away (delayed): nothing
  at('2026-10-12T07:36:00'); await dev.tick(); // 9 again: 10 and 9 already fired
  assert.deepStrictEqual(dev.inTriggered, [11, 10, 9]);
  const n = dev.nextDeparture();
  assert.strictEqual(n.found, true);
  assert.strictEqual(n.minutes, 9);
  assert.strictEqual(n.leave_in, 4);
  assert.strictEqual(n.delay, 3);
  assert.strictEqual(dev.nextMinutes(), 9);
});

