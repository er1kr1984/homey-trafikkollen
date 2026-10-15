'use strict';

// Commute problem alerts: what is wrong right now on a commute (cancelled or late trips, messages on the
// lines, accidents and other road messages on the car route, slippery roads, queues at the speed sensors).
// Pure functions: the app keeps track of what it already sent, so each problem is sent once a day.

const D = require('./departures');

const MIN = 60000;
const LOOKAHEAD = 45 * MIN; // trips leaving within this time are the ones you could still take
const QUEUE_KMH = 50; // average speed at a road sensor below this = queue

const MODE = {
  en: { TRAIN: 'train', TRAM: 'tram', METRO: 'metro', FERRY: 'boat', BUS: 'bus' },
  sv: { TRAIN: 'tåg', TRAM: 'spårvagn', METRO: 'tunnelbana', FERRY: 'båt', BUS: 'buss' },
};

const TXT = {
  en: {
    canceled: (l, hm) => `${l} at ${hm} is cancelled`,
    late: (l, hm, n) => `${l} at ${hm} is ${n} min late`,
    note: (l, n) => `${l}: ${n}`,
    road: (i, hm) => `${i.type || 'Traffic message'} on ${i.road ? `road ${i.road}` : 'the route'}${i.location ? ` (${i.location})` : ''}${i.message ? `: ${i.message}` : ''}${i.reported ? ` (reported ${hm(i.reported)})` : ''}`,
    slippery: (c) => `Slippery roads${c.road ? ` on ${c.road}` : ''}${c.text && c.text !== 'Normal' ? ` (${c.text})` : ''}`,
    queue: (s) => `Slow traffic at ${s.name}: ${s.speed} km/h`,
  },
  sv: {
    canceled: (l, hm) => `${l} ${hm} är inställd`,
    late: (l, hm, n) => `${l} ${hm} är ${n} min sen`,
    note: (l, n) => `${l}: ${n}`,
    road: (i, hm) => `${i.type || 'Trafikmeddelande'} på ${i.road ? `väg ${i.road}` : 'vägen'}${i.location ? ` (${i.location})` : ''}${i.message ? `: ${i.message}` : ''}${i.reported ? ` (rapporterad ${hm(i.reported)})` : ''}`,
    slippery: (c) => `Halt väglag${c.road ? ` på ${c.road}` : ''}${c.text && c.text !== 'Normal' ? ` (${c.text})` : ''}`,
    queue: (s) => `Långsam trafik vid ${s.name}: ${s.speed} km/h`,
  },
};

const FRESH = 18 * 3600000; // road messages older than this are long-running (closures for months, speed limits)

/** Roadworks are on the route for months; only messages that change your trip today count. */
function isRoadwork(i) {
  return /vägarbete|roadwork/i.test(`${i.type || ''}`);
}

/** A road message that is news today: started in the last 18 hours (and not planned for later). */
function isFresh(i, now) {
  const start = Date.parse(i.start);
  if (!Number.isFinite(start)) return true;
  return start <= now + 5 * MIN && now - start <= FRESH;
}

/**
 * Problems on a commute right now. data = Commutes.get() result.
 * Returns [{ key, kind: 'transit'|'road', text }], where `key` is stable for the same problem.
 */
function findIssues(data, cfg, { lang = 'en', tz, now = Date.now() } = {}) {
  const t = TXT[lang] || TXT.en;
  const modes = MODE[lang] || MODE.en;
  const hm = (x) => D.hhmm(x, tz);
  const minDelay = cfg.alert_delay === undefined ? 5 : Math.max(1, Number(cfg.alert_delay) || 5);
  const out = [];
  const add = (key, kind, text) => { if (!out.some((o) => o.key === key)) out.push({ key, kind, text }); };

  const transit = data.transit;
  if (transit && !transit.error && !transit.stale) {
    // the trips you could take: the planned one if there is an arrive-by time, else everything leaving soon
    const soon = (transit.journeys || []).filter((j) => j.leave >= now - MIN && j.leave <= now + LOOKAHEAD);
    const target = data.plan && data.plan.arriveBy && data.plan.target;
    const trips = target ? [target] : soon;
    for (const j of trips) {
      for (const l of j.legs || []) {
        const name = `${modes[l.mode] || modes.BUS} ${l.line}`;
        const id = `${l.line}:${l.dep.scheduled}`;
        if (l.canceled) add(`cancel:${id}`, 'transit', t.canceled(name, hm(l.dep.scheduled)));
        else if (l.dep.delayMin >= minDelay) add(`late:${id}`, 'transit', t.late(name, hm(l.dep.scheduled), l.dep.delayMin));
        for (const n of l.notes || []) add(`note:${l.line}:${n}`, 'transit', t.note(name, n));
      }
    }
  }

  const drive = data.drive;
  if (drive && !drive.error && !drive.stale) {
    for (const i of drive.incidents || []) {
      if (isRoadwork(i) || !isFresh(i, now)) continue;
      add(`road:${i.road}:${i.location}:${i.type}`, 'road', t.road(i, hm));
    }
    if (drive.condition && drive.condition.slippery) add('slippery', 'road', t.slippery(drive.condition));
    for (const s of drive.speeds || []) {
      if (s.speed && s.speed < QUEUE_KMH) add(`queue:${s.name}`, 'road', t.queue(s));
    }
  }
  return out;
}

/** One notification text for new problems: "Home → Work: a · b · c" (shortened for a phone). */
function summary(name, issues, max = 480) {
  let text = `${name}: ${issues.map((i) => i.text).join(' · ')}`;
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`;
  return text;
}

module.exports = { findIssues, summary, isRoadwork, isFresh, QUEUE_KMH };
