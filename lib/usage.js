'use strict';

// Counts this app's Trafiklab requests, so people can see how much of their key's allowance they use.
// Only counts requests made by this app on this Homey; the same key used elsewhere is not included.

const D = require('./departures');

const KINDS = ['boards', 'commutes', 'search', 'stoplist'];
const TV_KINDS = ['messages', 'conditions', 'cameras', 'speed', 'trains', 'ferries', 'weather', 'images'];

/** Which kind of data a Trafikverket query (its objecttype, or 'image' for a camera picture) is, for the breakdown. */
function tvKindOf(type) {
  const t = String(type || '');
  if (t === 'image') return 'images';
  if (t === 'Situation') return 'messages';
  if (t === 'RoadCondition') return 'conditions';
  if (t === 'Camera') return 'cameras';
  if (t === 'TrafficFlow') return 'speed';
  if (/^Train/.test(t)) return 'trains';
  if (/^Ferry/.test(t)) return 'ferries';
  return 'weather'; // WeatherMeasurepoint and anything new
}

/** Which part of the app a Trafiklab path belongs to (for the breakdown). */
function kindOf(path) {
  if (path.startsWith('/stops/list')) return 'stoplist';
  if (path.startsWith('/stops/')) return 'search';
  if (/^\/(departures|arrivals)\/[^/]+\/\d{4}-/.test(path) || path.startsWith('/arrivals/')) return 'commutes'; // timed boards: commute search
  return 'boards'; // departure boards, ferries, "departures near me"
}

class Usage {

  /** load(): saved object or null; save(obj); tz(): time zone; kindOf/kinds: breakdown (default: Trafiklab paths) */
  constructor({ load, save, tz, kindOf: kind = kindOf, kinds = KINDS }) {
    this.save = save;
    this.tz = tz;
    this.kindOf = kind;
    this.kindList = kinds;
    this.data = load() || {};
    this.dirty = false;
    this.minute = []; // timestamps of the last minute's requests
  }

  /** Local "YYYY-MM" and "YYYY-MM-DD" for now. */
  keys(now) {
    const day = D.localIso(now, this.tz()).slice(0, 10);
    return { month: day.slice(0, 7), day };
  }

  /** Start a new month/day when the calendar moves on. */
  roll(now) {
    const { month, day } = this.keys(now);
    const d = this.data;
    if (d.month !== month) {
      if (d.month) d.previous = { month: d.month, total: d.total || 0 };
      Object.assign(d, { month, total: 0, kinds: {}, limited: 0, warned: 0, since: now });
      this.dirty = true;
    }
    if (!d.since) { d.since = now; this.dirty = true; }
    if (d.day !== day) { Object.assign(d, { day, today: 0 }); this.dirty = true; }
  }

  /** One request to `path`; `limited` = Trafiklab answered "too many requests". */
  count(path, { limited = false, now = Date.now() } = {}) {
    this.roll(now);
    const d = this.data;
    const kind = this.kindOf(path);
    d.total += 1;
    d.today += 1;
    d.kinds[kind] = (d.kinds[kind] || 0) + 1;
    if (limited) { d.limited = (d.limited || 0) + 1; d.lastLimited = now; }
    this.minute.push(now);
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.save({ ...this.data });
  }

  /**
   * Summary for the settings page: { month, total, today, lastMinute, perMinute, monthly, percent, projected,
   * kinds: { boards, commutes, search, stoplist }, limited, lastLimited, previous }
   */
  summary({ monthly, perMinute, now = Date.now() }) {
    this.roll(now);
    while (this.minute.length && now - this.minute[0] > 60000) this.minute.shift();
    const d = this.data;
    // straight-line forecast from the rate since counting started (this month, or mid-month on a first install)
    const [y, m] = d.month.split('-').map(Number);
    const monthEnd = D.localToEpoch(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01T00:00`, this.tz());
    const since = d.since || now;
    const rate = d.total / Math.max(3600000, now - since); // per ms, at least over an hour
    // only after a few hours: early bursts (setup, searches) would make the forecast jump around
    const projected = now - since >= 6 * 3600000 ? Math.round(d.total + rate * Math.max(0, monthEnd - now)) : null;
    return {
      month: d.month,
      total: d.total,
      today: d.today,
      lastMinute: this.minute.length,
      perMinute,
      monthly,
      percent: monthly ? Math.round((d.total / monthly) * 1000) / 10 : null,
      projected,
      kinds: Object.fromEntries(this.kindList.map((k) => [k, (d.kinds && d.kinds[k]) || 0])),
      limited: d.limited || 0,
      lastLimited: d.lastLimited || null,
      previous: d.previous || null,
    };
  }

  /** Returns 80 or 100 the first time the month passes that share of `monthly`, else 0. */
  threshold(monthly) {
    const d = this.data;
    if (!monthly || !d.total) return 0;
    const pct = (d.total / monthly) * 100;
    for (const step of [100, 80]) {
      if (pct >= step && (d.warned || 0) < step) { d.warned = step; this.dirty = true; return step; }
    }
    return 0;
  }
}

module.exports = { Usage, kindOf, tvKindOf, TV_KINDS };
