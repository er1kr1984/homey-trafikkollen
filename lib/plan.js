'use strict';

// Commute planning on top of the widget data: which trip to take for an "arrive by" time, when to start an
// engine heater, frost, and the morning briefing text. Pure functions, so they can be unit tested.

const D = require('./departures');

const MIN = 60000;

/** "08:00" on the day of `epoch` (local) -> epoch, or null. */
function timeOnDay(hhmm, epoch, tz) {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(String(hhmm || ''));
  if (!m) return null;
  return D.localToEpoch(`${D.localIso(epoch, tz).slice(0, 10)}T${m[1].padStart(2, '0')}:${m[2]}`, tz);
}

/**
 * The trip to take: the latest one that still arrives by `arriveBy` (epoch). If none makes it, the earliest
 * arrival, flagged late. Without arriveBy: the next one you can still catch.
 */
function pickTarget(journeys, now, arriveBy) {
  const ok = (journeys || []).filter((j) => !j.canceled && j.leave >= now);
  if (!ok.length) return null;
  if (!arriveBy) return { ...ok[0], late: false };
  const inTime = ok.filter((j) => j.arrive <= arriveBy).sort((a, b) => b.leave - a.leave);
  if (inTime.length) return { ...inTime[0], late: false };
  return { ...ok.sort((a, b) => a.arrive - b.arrive)[0], late: true };
}

/**
 * How long before leaving to switch on an engine heater, from the temperature (°C) when you leave.
 * Common Swedish advice: none above +10, ½ h down to 0, 1 h down to -10, 1½ h down to -20, 2 h below that.
 */
function heaterMinutes(temp) {
  if (!Number.isFinite(temp) || temp >= 10) return 0;
  if (temp >= 0) return 30;
  if (temp >= -10) return 60;
  if (temp >= -20) return 90;
  return 120;
}

/** Forecast hour nearest to `t` from SMHI hours [{ time, temp, … }] */
function forecastAt(hours, t) {
  let best = null;
  for (const h of hours || []) if (!best || Math.abs(h.time - t) < Math.abs(best.time - t)) best = h;
  return best && Math.abs(best.time - t) <= 2 * 3600000 ? best : null;
}

/** Frost on the car/road is likely: air at or below +1 °C, or a measured road surface at or below 0 °C. */
function frostLikely(airTemp, roadTemp) {
  return (Number.isFinite(airTemp) && airTemp <= 1) || (Number.isFinite(roadTemp) && roadTemp <= 0);
}

const TXT = {
  en: {
    leave: (j, hm) => `Leave at ${hm(j.leave)}: ${j.legs.map((l) => `${l.mode === 'TRAIN' ? 'train' : l.mode === 'TRAM' ? 'tram' : l.mode === 'METRO' ? 'metro' : 'bus'} ${l.line} at ${hm(l.dep.expected)}${l.dep.delayMin >= 1 ? ` (${l.dep.delayMin} min late)` : ''}`).join(', then ')}. There at ${hm(j.arrive)}.`,
    late: 'You will be late: no trip gets there in time.',
    none: 'No public transport trip found.',
    car: (min, n) => `By car about ${min} min${n ? `, ${n} traffic message${n === 1 ? '' : 's'} on the way` : ', no traffic messages'}.`,
    slippery: 'Slippery roads!',
    weather: (h) => `${Math.round(h.temp)}° and ${h.text.toLowerCase()}${h.precip >= 0.3 ? `, ${h.precip.toFixed(1)} mm/h` : ''}.`,
    frost: 'Frost likely: scrape the car.',
    notes: (n) => `Note: ${n}`,
    leaveCar: (j, hm) => `Leave by car at ${hm(j.leave)}, there at ${hm(j.arrive)}.`,
    lateCar: 'You will be late if you leave now.',
  },
  sv: {
    leave: (j, hm) => `Gå ${hm(j.leave)}: ${j.legs.map((l) => `${l.mode === 'TRAIN' ? 'tåg' : l.mode === 'TRAM' ? 'spårvagn' : l.mode === 'METRO' ? 'tunnelbana' : 'buss'} ${l.line} ${hm(l.dep.expected)}${l.dep.delayMin >= 1 ? ` (${l.dep.delayMin} min sen)` : ''}`).join(', sedan ')}. Framme ${hm(j.arrive)}.`,
    late: 'Du blir sen: ingen resa är framme i tid.',
    none: 'Ingen kollektivtrafikresa hittades.',
    car: (min, n) => `Med bil cirka ${min} min${n ? `, ${n} trafikmeddelande${n === 1 ? '' : 'n'} på vägen` : ', inga trafikmeddelanden'}.`,
    slippery: 'Halt väglag!',
    weather: (h) => `${Math.round(h.temp)}° och ${h.textSv || h.text.toLowerCase()}${h.precip >= 0.3 ? `, ${h.precip.toFixed(1).replace('.', ',')} mm/h` : ''}.`,
    frost: 'Risk för frost: skrapa bilen.',
    notes: (n) => `Obs: ${n}`,
    leaveCar: (j, hm) => `Åk med bil ${hm(j.leave)}, framme ${hm(j.arrive)}.`,
    lateCar: 'Du blir sen även om du åker nu.',
  },
};

/** One-paragraph briefing for notifications/speech. data = Commutes.get() result, target from pickTarget. */
function briefing(data, target, { lang = 'en', tz, frost, weatherHour } = {}) {
  const t = TXT[lang] || TXT.en;
  const hm = (x) => D.hhmm(x, tz);
  const parts = [`${data.name}:`];
  if (data.transit && !data.transit.error) {
    if (target) {
      parts.push(t.leave(target, hm));
      if (target.late) parts.push(t.late);
      const notes = [...new Set(target.legs.flatMap((l) => l.notes || []))];
      if (notes.length) parts.push(t.notes(notes.join(' ')));
    } else parts.push(t.none);
  }
  if (data.mode === 'car' && target && target.car) {
    parts.push(t.leaveCar(target, hm));
    if (target.late) parts.push(t.lateCar);
  }
  const d = data.drive;
  if (d && !d.error && d.minutes) {
    parts.push(t.car(d.minutes, d.incidentCount || 0));
    if (d.condition && d.condition.slippery) parts.push(t.slippery);
  }
  if (weatherHour) parts.push(t.weather(weatherHour));
  if (frost) parts.push(t.frost);
  return parts.join(' ');
}

module.exports = { timeOnDay, pickTarget, heaterMinutes, forecastAt, frostLikely, briefing };
