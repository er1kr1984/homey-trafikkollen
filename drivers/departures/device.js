'use strict';

const Homey = require('homey');
const tl = require('../../lib/trafiklab');
const D = require('../../lib/departures');
const trains = require('../../lib/trains');

const TICK_MS = 30 * 1000;            // recompute minutes / reminders from cached data
const IDLE_POLL_MIN = 10;             // outside active hours
const DELAY_REFIRE_STEP = 5;          // re-alert when a delay grows by this many more minutes
const MEMORY_MS = 3 * 3600 * 1000;    // forget fired-alert bookkeeping for trips older than this

class DepartureDevice extends Homey.Device {

  async onInit() {
    this.deps = [];
    this.lastFetch = 0;
    this.fired = {};    // trip key -> { delay, canceled, leave, at }
    this.seeded = false; // first poll after start: don't fire for things that were already true
    await this.syncFields(this.getSettings()).catch((e) => this.error('fields:', e.message));
    this.tick().catch((e) => this.error('first tick failed:', e.message));
    this.timer = this.homey.setInterval(() => this.tick().catch((e) => this.error('tick failed:', e.message)), TICK_MS);
  }

  onDeleted() {
    if (this.timer) this.homey.clearInterval(this.timer);
  }

  async onSettings({ newSettings }) {
    await this.syncFields(newSettings).catch((e) => this.error('fields:', e.message));
    this.lastFetch = 0; // refetch + re-filter with the new settings on the next tick
    this.homey.setTimeout(() => this.tick().catch((e) => this.error(e.message)), 500);
  }

  /** Show or hide the optional fields ("Leave in" is pointless with no walking time). */
  async syncFields(s) {
    const want = {
      dep_leave_in: s.show_leave_in !== false && (s.walk_minutes || 0) > 0,
      dep_delay: s.show_delay !== false,
      dep_upcoming: s.show_upcoming !== false,
    };
    for (const [cap, on] of Object.entries(want)) {
      if (on && !this.hasCapability(cap)) await this.addCapability(cap);
      if (!on && this.hasCapability(cap)) await this.removeCapability(cap);
    }
  }

  get tz() { return this.homey.clock.getTimezone() || 'Europe/Stockholm'; }

  active(now) {
    const s = this.getSettings();
    return D.isActive(now, this.tz, D.parseWindows(s.active_hours), s.weekdays_only);
  }

  async refresh() {
    this.lastFetch = 0;
    await this.tick();
  }

  async tick() {
    const now = Date.now();
    const s = this.getSettings();
    const active = this.active(now);
    const pollMs = (active ? Math.max(1, s.poll_minutes || 2) : IDLE_POLL_MIN) * 60000;
    if (now - this.lastFetch >= pollMs - 5000) await this.fetch();
    await this.update(Date.now(), active);
  }

  async fetch() {
    const key = this.homey.settings.get('trafiklab_key');
    try {
      const { departures } = await tl.departures(key, this.getData().id);
      const deps = D.normalise(departures, this.tz, this.getSettings());
      await trains.enrich(this.homey.settings.get('trafikverket_key'), deps); // tracks + delay reasons for trains
      this.deps = deps;
      this.lastFetch = Date.now();
      if (!this.getAvailable()) await this.setAvailable();
    } catch (e) {
      this.lastFetch = Date.now(); // back off a full interval, don't hammer a failing API
      this.error('fetch failed:', e.message);
      if (/key|quota/i.test(e.message)) await this.setUnavailable(this.homey.app.friendly(e)).catch(() => {});
      else if (Date.now() - (this.lastOk || 0) > 15 * 60000) await this.setWarning?.(this.homey.app.t('errors.unreachable', { msg: e.message })).catch(() => {});
      return;
    }
    this.lastOk = Date.now();
    await this.unsetWarning?.().catch(() => {});
  }

  async update(now, active) {
    const s = this.getSettings();
    const tz = this.tz;
    const walk = s.walk_minutes || 0;
    const live = this.deps.filter((d) => d.expected > now - 60000);
    const next = D.nextCatchable(live, now, walk);
    const later = live.filter((d) => d !== next && (!next || d.expected > next.expected)).slice(0, 3);

    // none in the feed, or only ones you can no longer reach on foot in time
    const none = live.some((d) => !d.canceled) ? 'device.noneReachable' : 'device.noneHour';
    await this.set('dep_next', next ? D.describe(next, tz) : this.homey.app.t(none));
    await this.set('dep_minutes', next ? D.timing(next, now, walk).minutes : null);
    await this.set('dep_leave_in', next ? D.timing(next, now, walk).leaveIn : null);
    await this.set('dep_delay', next ? Math.max(0, next.delayMin) : null);
    await this.set('alarm_dep_problem', !!next && (next.delayMin >= (s.delay_threshold || 3)
      || live.some((d) => d.canceled && d.expected <= next.expected + 60000)));
    await this.set('dep_upcoming', later.length ? later.map((d) => D.describe(d, tz)).join(' · ') : '-');

    // alerts - bookkeeping always runs so nothing stale fires when the active window opens
    for (const d of live) {
      const f = this.fired[d.key] = this.fired[d.key] || { at: d.scheduled };
      const tokens = this.tokens(d, now, walk);
      const allow = active && this.seeded;

      // "a departure leaves in N minutes": each minute value once per departure, also if a delay pushes it back
      const inMin = Math.floor((d.expected - now) / 60000);
      if (!d.canceled) {
        f.inFired = f.inFired || [];
        if (f.inMin !== undefined && inMin < f.inMin) {
          for (let v = f.inMin - 1; v >= Math.max(0, inMin) && v >= f.inMin - 5; v--) {
            if (f.inFired.includes(v)) continue;
            f.inFired.push(v);
            if (allow) await this.triggerIn({ ...this.flowTokens(d, now, walk), minutes: v });
          }
        }
        f.inMin = inMin;
      }

      for (const note of d.notes || []) {
        f.notes = f.notes || [];
        if (f.notes.includes(note)) continue;
        f.notes.push(note);
        if (allow) await this.trigger('departure_disruption', { ...tokens, message: note, text: `${tokens.text}: ${note}` });
      }
      if (d.canceled && !f.canceled) {
        f.canceled = true;
        if (allow) await this.trigger('departure_canceled', { ...tokens, text: `Cancelled: ${tokens.text}` });
      }
      if (!d.canceled && d.delayMin >= (s.delay_threshold || 3) && (f.delay === undefined || d.delayMin >= f.delay + DELAY_REFIRE_STEP)) {
        f.delay = d.delayMin;
        if (allow) await this.trigger('departure_delayed', { ...tokens, text: `${d.delayMin} min late: ${tokens.text}` });
      }
      const { leaveIn } = D.timing(d, now, walk);
      if (!d.canceled && !f.leave && leaveIn >= 0 && leaveIn <= (s.remind_before ?? 5)) {
        f.leave = true;
        if (allow) {
          const late = d.delayMin >= 1 ? ` (${d.delayMin} min late)` : '';
          await this.trigger('time_to_leave', {
            ...tokens, leave_in: leaveIn,
            text: `${leaveIn > 0 ? `Leave in ${leaveIn} min` : 'Leave now'} for the ${tokens.scheduled} ${tokens.line} → ${d.direction}${late}`,
          });
        }
      }
    }
    if (this.lastFetch) this.seeded = true;
    for (const [k, f] of Object.entries(this.fired)) if (now - f.at > MEMORY_MS) delete this.fired[k];
  }

  tokens(d, now, walk) {
    return {
      text: D.describe(d, this.tz),
      line: d.lineName && d.lineName !== d.line ? `${d.lineName} ${d.line}`.trim() : d.line,
      direction: d.direction,
      scheduled: D.hhmm(d.scheduled, this.tz),
      expected: D.hhmm(d.expected, this.tz),
      delay: Math.max(0, d.delayMin),
      platform: d.platform || '',
    };
  }

  /** Tokens for the "next departure" action and "leaves in" trigger. */
  flowTokens(d, now, walk) {
    const minutes = Math.floor((d.expected - now) / 60000);
    return {
      text: D.describe(d, this.tz),
      line: d.line || d.lineName || '', // "141", not the operator's long route name: reads well in speech
      direction: d.direction || '',
      time: D.hhmm(d.expected, this.tz),
      scheduled: D.hhmm(d.scheduled, this.tz),
      minutes,
      leave_in: minutes - walk,
      delay: Math.max(0, d.delayMin || 0),
      platform: d.platform || '',
    };
  }

  /** "Get the next departure": the next one you can still reach. */
  nextDeparture() {
    const now = Date.now();
    const walk = this.getSettings().walk_minutes || 0;
    const next = D.nextCatchable(this.deps, now, walk);
    if (!next) {
      return { text: this.homey.app.t('device.noneHour'), line: '', direction: '', time: '', scheduled: '', minutes: 0, leave_in: 0, delay: 0, platform: '', found: false };
    }
    return { ...this.flowTokens(next, now, walk), found: true };
  }

  /** Minutes until the next departure you can still reach, or null. */
  nextMinutes() {
    const now = Date.now();
    const next = D.nextCatchable(this.deps, now, this.getSettings().walk_minutes || 0);
    return next ? Math.floor((next.expected - now) / 60000) : null;
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
    if (!this.hasCapability(cap)) return; // hidden in the device settings
    if (this.getCapabilityValue(cap) !== value) await this.setCapabilityValue(cap, value).catch((e) => this.error(cap, e.message));
  }

  /** Data for the dashboard widget: upcoming departures as plain objects (times as epoch ms). */
  board(limit = 8) {
    const now = Date.now();
    const s = this.getSettings();
    const walk = s.walk_minutes || 0;
    const live = this.deps.filter((d) => d.expected > now - 60000);
    const next = D.nextCatchable(live, now, walk);
    return {
      name: this.getName(),
      walk,
      now,
      updated: this.lastOk || null,
      available: this.getAvailable(),
      departures: live.slice(0, limit).map((d) => ({
        line: d.line,
        lineName: d.lineName && d.lineName !== d.line ? d.lineName : '',
        mode: d.mode,
        direction: d.direction,
        platform: d.platform,
        scheduled: d.scheduled,
        expected: d.expected,
        delayMin: d.delayMin,
        canceled: d.canceled,
        realtime: d.realtime,
        notes: d.notes || [],
        next: d === next,
      })),
    };
  }

  nextDelay() {
    const next = D.nextCatchable(this.deps, Date.now(), this.getSettings().walk_minutes || 0);
    return next ? next.delayMin : 0;
  }
}

module.exports = DepartureDevice;
