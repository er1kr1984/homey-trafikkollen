'use strict';

const Homey = require('homey');
const ferries = require('../../lib/ferries');
const D = require('../../lib/departures');

const TICK_MS = 30 * 1000;
const IDLE_POLL_MIN = 10;
const MSG_EVERY_MIN = 5;

class FerryDevice extends Homey.Device {

  async onInit() {
    const [routeId, harborId] = String(this.getData().id).split(':').map(Number);
    this.routeId = routeId; this.harborId = harborId;
    this.deps = []; this.messages = []; this.lastFetch = 0; this.lastMsg = 0;
    this.fired = {}; this.seenMsgs = null;
    this.tick().catch((e) => this.error('first tick failed:', e.message));
    this.timer = this.homey.setInterval(() => this.tick().catch((e) => this.error('tick failed:', e.message)), TICK_MS);
  }

  onDeleted() { if (this.timer) this.homey.clearInterval(this.timer); }

  async onSettings() {
    this.lastFetch = 0;
    this.homey.setTimeout(() => this.tick().catch((e) => this.error(e.message)), 500);
  }

  get tz() { return this.homey.clock.getTimezone() || 'Europe/Stockholm'; }

  async refresh() { this.lastFetch = 0; this.lastMsg = 0; await this.tick(); }

  async tick() {
    const s = this.getSettings();
    const now = Date.now();
    const active = D.isActive(now, this.tz, D.parseWindows(s.active_hours), s.weekdays_only);
    const pollMs = (active ? Math.max(1, s.poll_minutes || 3) : IDLE_POLL_MIN) * 60000;
    if (now - this.lastFetch >= pollMs - 5000) await this.fetch(now - this.lastMsg >= MSG_EVERY_MIN * 60000 - 5000);
    await this.update(Date.now(), active);
  }

  async fetch(withMessages) {
    const key = this.homey.settings.get('trafikverket_key');
    try {
      const routes = await ferries.routes(key);
      const route = routes.find((r) => r.id === this.routeId);
      if (!route) throw new Error(this.homey.__('ferry.gone'));
      this.route = route;
      this.deps = await ferries.departures(key, this.routeId, this.harborId);
      if (withMessages) { this.messages = await ferries.disruptions(key, route); this.lastMsg = Date.now(); }
      this.lastFetch = Date.now(); this.lastOk = Date.now();
      if (!this.getAvailable()) await this.setAvailable();
    } catch (e) {
      this.lastFetch = Date.now();
      this.error('fetch failed:', e.message);
      if (e.auth) await this.setUnavailable(this.homey.app.friendly(e)).catch(() => {});
    }
  }

  describe(d) { return `${D.hhmm(d.time, this.tz)} → ${d.to}`; }

  async update(now, active) {
    const s = this.getSettings();
    const walk = s.walk_minutes || 0;
    const live = this.deps.filter((d) => d.time > now - 60000);
    const next = live.find((d) => d.time - walk * 60000 >= now) || null;
    const later = live.filter((d) => next && d.time > next.time).slice(0, 3);
    const leaveIn = next ? Math.floor((next.time - now) / 60000) - walk : null;
    await this.set('dep_next', next ? this.describe(next) : this.homey.__('ferry.none'));
    await this.set('dep_minutes', next ? Math.floor((next.time - now) / 60000) : null);
    await this.set('dep_leave_in', leaveIn);
    await this.set('alarm_dep_problem', this.messages.length > 0);
    await this.set('dep_upcoming', later.length ? later.map((d) => this.describe(d)).join(' · ') : '-');

    const tokens = (d) => ({
      text: d ? this.describe(d) : '', line: this.route ? this.route.name : '', direction: d ? d.to : '',
      scheduled: d ? D.hhmm(d.time, this.tz) : '', expected: d ? D.hhmm(d.time, this.tz) : '', delay: 0, platform: '',
    });
    // disruption messages: once per message text (none for messages already there at start)
    const texts = this.messages.map((m) => m.text);
    if (this.seenMsgs) {
      for (const t of texts) {
        if (!this.seenMsgs.has(t) && active) await this.trigger('departure_disruption', { ...tokens(next), message: t, text: `${this.route ? this.route.name : ''}: ${t}` });
      }
    }
    if (this.lastMsg) this.seenMsgs = new Set(texts);
    // time to leave: once per departure
    for (const d of live) {
      const f = this.fired[d.id] = this.fired[d.id] || { at: d.time };
      // "a departure leaves in N minutes": each minute value once per departure
      const inMin = Math.floor((d.time - now) / 60000);
      f.inFired = f.inFired || [];
      if (f.inMin !== undefined && inMin < f.inMin) {
        for (let v = f.inMin - 1; v >= Math.max(0, inMin) && v >= f.inMin - 5; v--) {
          if (f.inFired.includes(v)) continue;
          f.inFired.push(v);
          if (active && this.lastOk) await this.triggerIn({ ...this.flowTokens(d, now, walk), minutes: v });
        }
      }
      f.inMin = inMin;
      const left = Math.floor((d.time - now) / 60000) - walk;
      if (!f.leave && left >= 0 && left <= (s.remind_before ?? 5)) {
        f.leave = true;
        if (active && this.lastOk) {
          await this.trigger('time_to_leave', { ...tokens(d), leave_in: left, text: `${left > 0 ? this.homey.__('ferry.leaveIn').replace('{{n}}', left) : this.homey.__('ferry.leaveNow')} ${this.describe(d)}` });
        }
      }
    }
    for (const [k, f] of Object.entries(this.fired)) if (now - f.at > 3 * 3600000) delete this.fired[k];
  }

  /** Same shape as a departure board, for the board widget. */
  board(limit = 8) {
    const now = Date.now();
    const walk = this.getSettings().walk_minutes || 0;
    const live = this.deps.filter((d) => d.time > now - 60000);
    const next = live.find((d) => d.time - walk * 60000 >= now);
    const notes = this.messages.map((m) => m.text);
    return {
      name: this.getName(), walk, now, updated: this.lastOk || null, available: this.getAvailable(),
      departures: live.slice(0, limit).map((d, i) => ({
        line: '⛴', lineName: '', mode: 'BOAT', direction: d.to, platform: '', scheduled: d.time, expected: d.time,
        delayMin: 0, canceled: false, realtime: false, notes: i === 0 ? notes : [], next: d === next,
      })),
    };
  }

  flowTokens(d, now, walk) {
    const minutes = Math.floor((d.time - now) / 60000);
    return {
      text: this.describe(d), line: this.route ? this.route.name : '', direction: d.to || '',
      time: D.hhmm(d.time, this.tz), scheduled: D.hhmm(d.time, this.tz), minutes, leave_in: minutes - walk, delay: 0, platform: '',
    };
  }

  /** "Get the next departure": the next one you can still reach. */
  nextDeparture() {
    const now = Date.now();
    const walk = this.getSettings().walk_minutes || 0;
    const next = this.deps.find((d) => d.time - walk * 60000 >= now);
    if (!next) return { text: this.homey.__('ferry.none'), line: '', direction: '', time: '', scheduled: '', minutes: 0, leave_in: 0, delay: 0, platform: '', found: false };
    return { ...this.flowTokens(next, now, walk), found: true };
  }

  nextMinutes() {
    const now = Date.now();
    const walk = this.getSettings().walk_minutes || 0;
    const next = this.deps.find((d) => d.time - walk * 60000 >= now);
    return next ? Math.floor((next.time - now) / 60000) : null;
  }

  async triggerIn(tokens) {
    this.log('trigger departure_in', tokens.minutes, tokens.text);
    await this.homey.flow.getDeviceTriggerCard('departure_in').trigger(this, tokens, { minutes: tokens.minutes })
      .catch((e) => this.error('trigger departure_in:', e.message));
  }

  async trigger(id, tokens) {
    this.log('trigger', id, tokens.text);
    await this.homey.flow.getDeviceTriggerCard(id).trigger(this, tokens).catch((e) => this.error(`trigger ${id}:`, e.message));
  }

  async set(cap, value) {
    if (this.getCapabilityValue(cap) !== value) await this.setCapabilityValue(cap, value).catch((e) => this.error(cap, e.message));
  }
}

module.exports = FerryDevice;
