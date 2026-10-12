'use strict';

// Ferry device with a fake Homey runtime and fake Trafikverket data, controlling the clock.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

class FakeDevice {
  constructor(settings) { this._s = settings; this._caps = {}; this._avail = true; this.triggered = []; }
  getSettings() { return this._s; } getData() { return { id: '28:55' }; } getName() { return 'Hönöleden: Hönö'; }
  getCapabilityValue(c) { return this._caps[c] ?? null; } async setCapabilityValue(c, v) { this._caps[c] = v; }
  getAvailable() { return this._avail; } async setAvailable() { this._avail = true; } async setUnavailable(m) { this._avail = false; }
  log() {} error() {}
}
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'homey' ? { Device: FakeDevice, Driver: class {}, App: class {} } : origLoad.call(this, req, ...rest); };

const ferries = require('../lib/ferries');
const D = require('../lib/departures');
const FerryDevice = require('../drivers/ferry/device');
const TZ = 'Europe/Stockholm';
let clock;
Date.now = () => clock;
const at = (local) => { clock = D.localToEpoch(local, TZ); };

test('ferry: next departure, time to leave once, disruption alerts only for new messages', async () => {
  let msgs = [{ text: 'Reducerad kapacitet.' }];
  ferries.routes = async () => [{ id: 28, name: 'Hönöleden', harbors: [{ id: 55, name: 'Hönö' }, { id: 56, name: 'Lilla Varholmen' }], point: { lat: 57.7, lon: 11.7 } }];
  ferries.departures = async () => ['07:15', '07:25', '07:45'].map((t) => ({ id: t, time: D.localToEpoch(`2026-10-13T${t}:00`, TZ), to: 'Lilla Varholmen', info: [] }));
  ferries.disruptions = async () => msgs;
  const dev = new FerryDevice({ walk_minutes: 10, remind_before: 5, active_hours: '06:30-09:00', weekdays_only: true, poll_minutes: 1 });
  dev.homey = {
    clock: { getTimezone: () => TZ }, settings: { get: () => 'KEY' },
    __: (k) => ({ 'ferry.leaveIn': 'Leave in {{n}} min for', 'ferry.leaveNow': 'Leave now for', 'ferry.none': 'none' }[k] || k),
    flow: { getDeviceTriggerCard: (id) => ({ trigger: async (d, tokens) => { d.triggered.push([id, tokens.text]); } }) },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
  };
  Object.assign(dev, { routeId: 28, harborId: 55, deps: [], messages: [], lastFetch: 0, lastMsg: 0, fired: {}, seenMsgs: null });

  at('2026-10-13T06:50:00'); await dev.tick(); // 07:15 is 25 min away, leave in 15
  assert.strictEqual(dev.getCapabilityValue('dep_next'), '07:15 → Lilla Varholmen');
  assert.strictEqual(dev.getCapabilityValue('dep_leave_in'), 15);
  assert.strictEqual(dev.getCapabilityValue('alarm_dep_problem'), true);
  assert.deepStrictEqual(dev.triggered, []); // the message was already there: no alert
  at('2026-10-13T07:00:00'); await dev.tick(); // leave in 5
  at('2026-10-13T07:01:00'); await dev.tick();
  assert.deepStrictEqual(dev.triggered, [['time_to_leave', 'Leave in 5 min for 07:15 → Lilla Varholmen']]);
  msgs = [{ text: 'Reducerad kapacitet.' }, { text: 'Färjan inställd på grund av hård vind.' }];
  dev.lastFetch = 0; dev.lastMsg = 0;
  at('2026-10-13T07:02:00'); await dev.tick();
  assert.deepStrictEqual(dev.triggered.slice(1), [['departure_disruption', 'Hönöleden: Färjan inställd på grund av hård vind.']]);
  assert.strictEqual(dev.board(3).departures[0].notes.length, 2);
});
