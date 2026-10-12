'use strict';

// Pure helpers for the departure board - no Homey dependencies, so they can be unit tested.

/** Offset (ms) of timezone tz from UTC at instant `epoch`. */
function tzOffset(epoch, tz) {
  const p = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epoch))) p[type] = value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(epoch / 1000) * 1000;
}

/** "2025-04-01T14:30:00" in local time of tz -> epoch ms. */
function localToEpoch(str, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(str || '');
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz); // second pass handles DST edges
  return t;
}

/** Minutes past local midnight and ISO weekday (1=Mon..7=Sun) for epoch in tz. */
function localClock(epoch, tz) {
  const p = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(new Date(epoch))) p[type] = value;
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
  return { minutes: +p.hour * 60 + +p.minute, weekday: wd };
}

/** epoch -> local "YYYY-MM-DDTHH:mm" in tz (the time format Trafiklab takes in URLs). */
function localIso(epoch, tz) {
  const p = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(epoch))) p[type] = value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function hhmm(epoch, tz) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(epoch));
}

/** "06:00-09:00, 15:30-18:00" -> [[360, 540], [930, 1080]]; empty/invalid -> [] (meaning always). */
function parseWindows(text) {
  const out = [];
  for (const part of String(text || '').split(',')) {
    const m = /^\s*(\d{1,2})[:.](\d{2})\s*-\s*(\d{1,2})[:.](\d{2})\s*$/.exec(part);
    if (m) out.push([+m[1] * 60 + +m[2], +m[3] * 60 + +m[4]]);
  }
  return out;
}

/** Easter Sunday (Gregorian, anonymous algorithm) as [month 1-12, day]. */
function easter(y) {
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100; const d = Math.floor(b / 4); const e = b % 4;
  const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return [Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1];
}

/**
 * Swedish public holidays plus the days most people have off anyway (Midsummer Eve, Christmas Eve, New Year's Eve).
 * "YYYY-MM-DD" -> name, or null.
 */
function swedishHoliday(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const ymd = (m, day) => `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const shift = (m, day, n) => { const t = new Date(Date.UTC(y, m - 1, day + n)); return ymd(t.getUTCMonth() + 1, t.getUTCDate()); };
  const [em, ed] = easter(y);
  // the Saturday/Friday within a date range
  const weekdayIn = (m, from, to, wd) => { for (let x = from; x <= to; x++) if (new Date(Date.UTC(y, m - 1, x)).getUTCDay() === wd) return ymd(m, x); return null; };
  const allSaints = (() => { for (let x = 31; x <= 37; x++) { const t = new Date(Date.UTC(y, 9, x)); if (t.getUTCDay() === 6) return ymd(t.getUTCMonth() + 1, t.getUTCDate()); } return null; })();
  const days = {
    [ymd(1, 1)]: 'Nyårsdagen', [ymd(1, 6)]: 'Trettondedag jul', [shift(em, ed, -2)]: 'Långfredagen', [shift(em, ed, -1)]: 'Påskafton',
    [ymd(em, ed)]: 'Påskdagen', [shift(em, ed, 1)]: 'Annandag påsk', [ymd(5, 1)]: 'Första maj', [shift(em, ed, 39)]: 'Kristi himmelsfärdsdag',
    [ymd(6, 6)]: 'Sveriges nationaldag', [weekdayIn(6, 19, 25, 5)]: 'Midsommarafton', [weekdayIn(6, 20, 26, 6)]: 'Midsommardagen',
    [allSaints]: 'Alla helgons dag', [ymd(12, 24)]: 'Julafton', [ymd(12, 25)]: 'Juldagen', [ymd(12, 26)]: 'Annandag jul', [ymd(12, 31)]: 'Nyårsafton',
  };
  return days[ymd(mo, d)] || null;
}

/** Is epoch inside the active hours? windows [] = always. Windows may cross midnight (22:00-02:00).
 *  weekdaysOnly also skips Swedish public holidays. */
function isActive(epoch, tz, windows, weekdaysOnly) {
  const { minutes, weekday } = localClock(epoch, tz);
  if (weekdaysOnly && (weekday > 5 || swedishHoliday(localIso(epoch, tz).slice(0, 10)))) return false;
  if (!windows.length) return true;
  return windows.some(([a, b]) => (a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b));
}

const splitList = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

/**
 * Normalise + filter raw Trafiklab departures.
 * filters: { lines: "1043, 5", destination: "stockholm, -arlanda", mode: "any"|"TRAIN"|..., platform: "2", times: "07:40, 15:10" }
 * A destination term starting with "-" excludes matches ("stockholm, -arlanda" = Stockholm but not Stockholm Arlanda).
 */
function normalise(raw, tz, filters = {}) {
  const lines = splitList(filters.lines);
  const terms = splitList(filters.destination);
  const dests = terms.filter((x) => !x.startsWith('-'));
  const notDests = terms.filter((x) => x.startsWith('-')).map((x) => x.slice(1).trim()).filter(Boolean);
  const mode = (filters.mode || 'any').toUpperCase();
  const platform = String(filters.platform || '').trim().toLowerCase();
  // "07:40, 15:10" -> only trips scheduled at those local times (e.g. the school bus)
  const times = new Set(String(filters.times || '').split(',').map((x) => x.trim().replace('.', ':')).filter((x) => /^\d{1,2}:\d{2}$/.test(x)).map((x) => x.padStart(5, '0')));
  const out = [];
  for (const d of raw || []) {
    const route = d.route || {};
    const line = String(route.designation || route.name || '').trim();
    const dir = String(route.direction || (route.destination && route.destination.name) || '').trim();
    if (mode !== 'ANY' && String(route.transport_mode || '').toUpperCase() !== mode) continue;
    if (lines.length && !lines.includes(line.toLowerCase()) && !lines.includes(String(route.name || '').toLowerCase())) continue;
    const where = `${dir} | ${(route.destination && route.destination.name) || ''}`.toLowerCase();
    if (dests.length && !dests.some((x) => where.includes(x))) continue;
    if (notDests.some((x) => where.includes(x))) continue;
    const plat = (d.realtime_platform && d.realtime_platform.designation) || (d.scheduled_platform && d.scheduled_platform.designation) || '';
    if (platform && String(plat).toLowerCase() !== platform) continue;
    const scheduled = localToEpoch(d.scheduled, tz);
    const expected = localToEpoch(d.realtime, tz) || scheduled;
    if (!scheduled) continue;
    if (times.size && !times.has(hhmm(scheduled, tz))) continue;
    const trip = d.trip || {};
    out.push({
      key: `${trip.trip_id || line + dir + d.scheduled}|${trip.start_date || ''}`,
      line,
      lineName: route.name || '',
      mode: route.transport_mode || '',
      direction: dir,
      scheduled,
      expected,
      delayMin: Math.round((d.delay || 0) / 60),
      canceled: d.canceled === true || d.canceled === 'true',
      realtime: !!d.is_realtime,
      platform: String(plat),
      stop: (d.stop && d.stop.name) || '',
      stopLat: d.stop && Number.isFinite(d.stop.lat) ? d.stop.lat : null,
      stopLon: d.stop && Number.isFinite(d.stop.lon) ? d.stop.lon : null,
      techNo: trip.technical_number != null ? String(trip.technical_number) : '',
      // operator messages ("Tåget är försenat. Orsaken är tågkö.", track work, replacement buses …)
      notes: [...new Set((d.alerts || []).map((a) => String(a.text || a.title || '').trim()).filter(Boolean))],
      agency: (d.agency && (d.agency.operator || d.agency.name)) || '',
    });
  }
  out.sort((a, b) => a.expected - b.expected);
  return out;
}

const MODE_WORD = { TRAIN: 'Train', BUS: 'Bus', TRAM: 'Tram', METRO: 'Metro', BOAT: 'Boat', TAXI: 'Taxi' };

/** "07:42 Pendeltåg 43 → Stockholm C, platform 2 (+3 min)" */
function describe(dep, tz) {
  const what = dep.lineName && dep.lineName !== dep.line ? `${dep.lineName} ${dep.line}`.trim() : `${MODE_WORD[dep.mode] || ''} ${dep.line}`.trim();
  let s = `${hhmm(dep.scheduled, tz)} ${what} → ${dep.direction}`;
  if (dep.platform) s += `, platform ${dep.platform}`;
  if (dep.canceled) s += ' (CANCELLED)';
  else if (dep.delayMin >= 1) s += ` (+${dep.delayMin} min, now ${hhmm(dep.expected, tz)})`;
  else if (dep.delayMin <= -1) s += ` (${-dep.delayMin} min early)`;
  return s;
}

/** Minutes (rounded down) from now until the departure, and until you must leave. */
function timing(dep, now, walkMin) {
  const minutes = Math.floor((dep.expected - now) / 60000);
  return { minutes, leaveIn: minutes - (walkMin || 0) };
}

/** Next departure you can still catch (not cancelled, leave time not passed). */
function nextCatchable(deps, now, walkMin) {
  return deps.find((d) => !d.canceled && timing(d, now, walkMin).leaveIn >= 0) || null;
}

module.exports = {
  tzOffset, localToEpoch, localClock, localIso, hhmm, swedishHoliday, parseWindows, isActive, normalise, describe, timing, nextCatchable,
};
