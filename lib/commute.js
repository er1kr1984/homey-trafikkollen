'use strict';

// One commute = public transport (origin -> optional change -> stops near the destination),
// the car route (incidents, road condition, live speed, cameras) and the weather for the commute hours.
// Data is fetched only when a widget asks for it and cached, so an unopened dashboard costs no API calls.

const tl = require('./trafiklab');
const tv = require('./trafikverket');
const smhi = require('./smhi');
const D = require('./departures');
const J = require('./journey');
const trains = require('./trains');
const P = require('./plan');

const MIN = 60000;
const MAX_HOURS = 4; // how far ahead to look for a trip when the next hour has none
const TTL = {
  transitActive: 90 * 1000, transitIdle: 15 * MIN,
  roadActive: 5 * MIN, roadIdle: 30 * MIN,
  weather: 30 * MIN, cameras: 6 * 3600 * 1000, next: 3 * 3600 * 1000,
};

/** Fill in defaults and check a commute config from the app settings. Throws on missing essentials. */
function normaliseConfig(c, i = 0) {
  if (!c || typeof c !== 'object') throw new Error(`Commute ${i + 1} is not an object`);
  const id = String(c.id || `commute${i + 1}`);
  if (c.mode === 'car') return carConfig(c, id);
  if (!c.origin || !c.origin.id) throw new Error(`Commute "${id}": origin.id (Trafiklab stop area) is required`);
  const dests = [].concat(c.destinations || []).filter((d) => d && d.id);
  if (!dests.length) throw new Error(`Commute "${id}": at least one destinations[].id is required`);
  const origin = { ...c.origin, id: String(c.origin.id) };
  // the destination itself (from the address search) if known, else the first destination stop
  const end = (c.place && Number.isFinite(+c.place.lat) ? c.place : null) || dests.find((d) => Number.isFinite(+d.lat)) || null;
  // car route area: unless given, a circle around the midpoint that covers both ends
  let drive = c.drive && c.drive.enabled !== false ? { ...c.drive } : null;
  if (drive && !(Number.isFinite(+drive.lat) && Number.isFinite(+drive.lon))) {
    const a = routeArea(origin, end);
    if (a) Object.assign(drive, { lat: a.lat, lon: a.lon, radius_km: drive.radius_km || a.radius_km });
    else drive = null; // no coordinates to work with
  }
  // weather: true = at the start and at the destination
  let weather = c.weather;
  if (weather === true) {
    weather = [origin, end].filter((p) => p && Number.isFinite(+p.lat)).map((p) => ({ name: shortName(p.name), lat: +p.lat, lon: +p.lon }));
  }
  return {
    ...c,
    id,
    origin,
    name: c.name || id,
    walk_to_stop: Number(c.walk_to_stop) || 0,
    change_minutes: c.change_minutes === undefined ? 3 : Number(c.change_minutes),
    destinations: dests.map((d) => ({ ...d, id: String(d.id), walk: Number(d.walk) || 0 })),
    // change stops: several allowed, e.g. a station whose trains and trams use different stop areas
    transfers: [].concat(c.transfers || c.transfer || []).filter((x) => x && x.id).map((x) => ({ ...x, id: String(x.id) })),
    drive,
    weather: [].concat(weather || []).filter((w) => w && Number.isFinite(+w.lat) && Number.isFinite(+w.lon)),
  };
}

/** Car only: two addresses (origin and place, each { name, lat, lon }), no public transport. */
function carConfig(c, id) {
  const pt = (p) => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lon);
  if (!pt(c.origin)) throw new Error(`Commute "${id}": origin needs lat/lon (an address)`);
  if (!pt(c.place)) throw new Error(`Commute "${id}": place needs lat/lon (the destination address)`);
  const origin = { name: c.origin.name || '', lat: +c.origin.lat, lon: +c.origin.lon };
  const place = { name: c.place.name || '', lat: +c.place.lat, lon: +c.place.lon };
  const drive = { ...(c.drive || {}), enabled: true };
  drive.minutes = Number(drive.minutes) || 30;
  if (!(Number.isFinite(+drive.lat) && Number.isFinite(+drive.lon))) Object.assign(drive, routeArea(origin, place));
  else drive.radius_km = drive.radius_km || routeArea(origin, place).radius_km;
  let weather = c.weather;
  if (weather === true) weather = [origin, place].map((p) => ({ name: String(p.name).split(',')[0], lat: p.lat, lon: p.lon }));
  return {
    ...c,
    id,
    mode: 'car',
    name: c.name || id,
    origin,
    place,
    walk_to_stop: 0,
    change_minutes: 0,
    destinations: [],
    transfers: [],
    drive,
    weather: [].concat(weather || []).filter((w) => w && Number.isFinite(+w.lat) && Number.isFinite(+w.lon)),
  };
}

/** "Uppsala Centralstation" -> "Uppsala", "Kiruna" -> "Kiruna" (first word = the town, good enough for weather labels) */
function shortName(name) {
  return String(name || '').split(/[ ,]/)[0];
}

/** Circle covering the straight line between two { lat, lon } points, plus a 5 km margin. */
function routeArea(a, b) {
  if (!a || !b || !Number.isFinite(+a.lat) || !Number.isFinite(+b.lat)) return null;
  const lat = (+a.lat + +b.lat) / 2;
  const lon = (+a.lon + +b.lon) / 2;
  const km = tv.distanceKm({ lat: +a.lat, lon: +a.lon }, { lat: +b.lat, lon: +b.lon });
  return { lat: +lat.toFixed(4), lon: +lon.toFixed(4), radius_km: Math.min(100, Math.ceil(km / 2 + 5)) };
}

function parseConfigs(json) {
  if (!json) return [];
  const list = typeof json === 'string' ? JSON.parse(json) : json;
  return [].concat(list).map(normaliseConfig);
}

/** The next commute window [startEpoch, endEpoch] (today if not over yet, else the next allowed day). */
function nextWindow(now, tz, cfg) {
  const windows = D.parseWindows(cfg.active_hours);
  const [a, b] = windows[0] || [null, null];
  if (a === null) return [now, now + 3 * 3600 * 1000];
  for (let day = 0; day < 8; day++) {
    const t = now + day * 86400000;
    const dateStr = D.localIso(t, tz).slice(0, 10);
    const { weekday } = D.localClock(D.localToEpoch(`${dateStr}T12:00`, tz), tz);
    if (cfg.weekdays_only && (weekday > 5 || D.swedishHoliday(dateStr))) continue;
    const pad = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const start = D.localToEpoch(`${dateStr}T${pad(a)}`, tz);
    const end = D.localToEpoch(`${dateStr}T${pad(b)}`, tz);
    if (end > now) return [start, end];
  }
  return [now, now + 3 * 3600 * 1000];
}

/** Distance (km) from point p to the segment a-b, on a local flat projection (fine at commute scale). */
function crossTrackKm(a, b, p) {
  const k = Math.cos((+a.lat * Math.PI) / 180);
  const ax = +a.lon * k; const ay = +a.lat; const bx = +b.lon * k; const by = +b.lat; const px = +p.lon * k; const py = +p.lat;
  const dx = bx - ax; const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * 111.2;
}

class Commutes {

  /** keys: () => ({ trafiklab, trafikverket }); log: (...args) => void */
  constructor({ keys, tz, log = () => {} }) {
    this.keys = keys;
    this.tz = tz;
    this.log = log;
    this.cache = new Map(); // "<commute id>:<part>" -> { at, value, promise }
  }

  /**
   * Cached value of `fn`. With `swr` (stale-while-revalidate, for widgets) an expired value is returned at once
   * while a fresh one is fetched in the background, so a widget never waits for Trafiklab's per-minute queue.
   */
  async cached(name, ttl, fn, swr = false) {
    const e = this.cache.get(name) || {};
    const fresh = e.at && Date.now() - e.at < ttl;
    if (fresh && !e.promise) {
      if (e.error) throw e.error;
      return e.value;
    }
    if (swr && e.value != null && !e.error) {
      if (!e.promise) this.refresh(name, ttl, fn, e).catch(() => {}); // errors are kept in the cache entry
      return e.value;
    }
    if (e.promise) return e.promise;
    return this.refresh(name, ttl, fn, e);
  }

  refresh(name, ttl, fn, e = this.cache.get(name) || {}) {
    const promise = fn()
      .then((value) => { this.cache.set(name, { at: Date.now(), value, good: value }); return value; })
      .catch((error) => {
        // retry after 1 min; meanwhile keep serving the last good data (up to 30 min old), flagged as stale
        const good = e.good && Date.now() - e.good.updated < 30 * MIN ? { ...e.good, stale: error.message || String(error) } : null;
        this.cache.set(name, { at: Date.now() - ttl + MIN, value: good, error: good ? null : error, good: e.good });
        if (good) return good;
        throw error;
      });
    this.cache.set(name, { ...e, promise });
    return promise;
  }

  /** Fetch a commute's public transport again in the background (a "time to leave" trip is close). */
  kickTransit(cfg) {
    const name = `${cfg.id}:transit`;
    const e = this.cache.get(name) || {};
    if (e.promise) return;
    const tz = this.tz();
    const active = D.isActive(Date.now(), tz, D.parseWindows(cfg.active_hours), cfg.weekdays_only);
    this.refresh(name, active ? TTL.transitActive : TTL.transitIdle, () => this.transit(cfg, tz, Date.now(), active ? MAX_HOURS : 1), e).catch(() => {});
  }

  clear() { this.cache.clear(); }

  /** Drop one cached part ('transit', 'drive', …) of a commute so the next get() fetches it again. */
  forget(cfg, part) { this.cache.delete(`${cfg.id}:${part}`); }

  /** Everything the commute widget shows. Each section fails on its own ({ error }). */
  async get(cfg, { preview = true, swr = false } = {}) {
    const tz = this.tz();
    const now = Date.now();
    const active = D.isActive(now, tz, D.parseWindows(cfg.active_hours), cfg.weekdays_only);
    const settle = (p) => p.then((v) => v, (e) => ({ error: e.message || String(e) }));
    const [transit, drive, weather] = await Promise.all([
      cfg.mode === 'car' ? null : settle(this.cached(`${cfg.id}:transit`, active ? TTL.transitActive : TTL.transitIdle, () => this.transit(cfg, tz, Date.now(), active ? MAX_HOURS : 1), swr)),
      cfg.drive ? settle(this.cached(`${cfg.id}:drive`, active ? TTL.roadActive : TTL.roadIdle, () => this.drive(cfg), swr)) : null,
      cfg.weather.length ? settle(this.cached(`${cfg.id}:weather`, TTL.weather, () => this.weather(cfg, tz), swr)) : null,
    ]);
    if (drive && !drive.error && cfg.drive.minutes) drive.arriveIfNow = now + cfg.drive.minutes * MIN;
    // outside commute hours: the first trips of the next commute window (fetched once per window, cached)
    let next = null;
    const [winStart] = nextWindow(now, tz, cfg);
    for (const k of this.cache.keys()) if (k.startsWith(`${cfg.id}:next:`) && k !== `${cfg.id}:next:${winStart}`) this.cache.delete(k);
    if (preview && cfg.mode !== 'car' && !active && winStart > now + 60 * MIN) {
      next = await settle(this.cached(`${cfg.id}:next:${winStart}`, TTL.next, async () => {
        const r = await this.transit(cfg, tz, winStart);
        return { start: winStart, updated: r.updated, journeys: r.journeys.filter((j) => !j.canceled).slice(0, 4) };
      }, swr));
    }
    return {
      id: cfg.id, name: cfg.name, mode: cfg.mode === 'car' ? 'car' : 'transit', now, tz, active, transit, drive, weather, next,
      plan: this.plan(cfg, { transit, drive, weather }, now, tz),
    };
  }

  /**
   * Arrive-by planning for a commute: the trip to take, when to leave by car, the temperature then,
   * engine heater lead time and frost. { arriveBy, target, carLeave, temp, heaterMinutes, heaterAt, frost }
   */
  plan(cfg, { transit, drive, weather }, now, tz) {
    const [winStart] = nextWindow(now, tz, cfg);
    const arriveBy = cfg.arrive_by ? P.timeOnDay(cfg.arrive_by, winStart, tz) : null;
    // plan for the arrive-by time only when it is close (the trips we know about cover ~2 hours)
    const soon = arriveBy && arriveBy > now && arriveBy - now <= 3 * 3600000;
    const carMin = drive && !drive.error ? drive.minutes : (cfg.drive && cfg.drive.minutes) || null;
    const carLeave = arriveBy && carMin ? arriveBy - carMin * MIN : null;
    let target = transit && !transit.error ? P.pickTarget(transit.journeys, now, soon ? arriveBy : null) : null;
    if (cfg.mode === 'car' && carMin) {
      // car only: the "trip" is leaving by car (when planning for arrive-by: at carLeave, else now)
      const leave = soon ? carLeave : now;
      target = { car: true, leave, arrive: leave + carMin * MIN, legs: [], canceled: false, late: !!soon && carLeave < now - MIN };
    }
    const leaveAt = carLeave || (target && target.leave) || winStart;
    const startWx = weather && !weather.error && weather.places && weather.places[0] ? weather.places[0] : null;
    const hour = startWx ? P.forecastAt(startWx.allHours || startWx.hours, leaveAt) : null;
    const temp = hour ? hour.temp : null;
    const roadT = drive && drive.roadWeather ? drive.roadWeather.surface : null;
    const heaterMinutes = carLeave ? P.heaterMinutes(temp) : 0;
    return {
      arriveBy: soon ? arriveBy : null, nextArriveBy: arriveBy, target, carLeave, carMinutes: carMin, temp, hour,
      heaterMinutes, heaterAt: carLeave && heaterMinutes ? carLeave - heaterMinutes * MIN : null,
      frost: P.frostLikely(temp, roadT),
    };
  }

  /**
   * Door-to-door trips leaving from `from` (default now). Trafiklab answers one hour per request, so start with
   * trips leaving within the hour and, when none are found (quiet lines, evenings), look one more hour ahead at a time,
   * up to `maxHours`. Each extra hour costs one request per stop and direction (about 10 for a commute with three
   * change stops), so it is only done in commute hours; outside them the "next commute" preview covers the gap.
   */
  async transit(cfg, tz, from = Date.now(), maxHours = MAX_HOURS) {
    const key = this.keys().trafiklab;
    const now = Date.now();
    const asked = new Map(); // one request per stop, direction and hour, reused while widening
    const board = (kind, id, h) => {
      const k = `${kind}|${id}|${h}`;
      if (!asked.has(k)) asked.set(k, tl.board(key, kind, id, D.localIso(from + h * 60 * MIN, tz)));
      return asked.get(k);
    };
    const hours = (n) => [...Array(n).keys()];
    const norm = (raw) => {
      const seen = new Set(); // neighbouring hours overlap at the edge
      return D.normalise(raw, tz).filter((d) => {
        const k = `${d.key}|${d.scheduled}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };
    const many = async (kind, stops, n) => (await Promise.all(stops.flatMap((x) => hours(n).map((h) => board(kind, x.id, h))))).flat();
    let journeys = []; let firstN = []; let tDepN = []; let searched = 0;
    for (let n = 1; n <= maxHours; n++) {
      // trips leaving in the first n hours; change stops and destinations one hour further for the ride itself
      const [first, tArr, tDep, ...destArr] = await Promise.all([
        many('departures', [cfg.origin], n),
        many('arrivals', cfg.transfers, n + 1),
        many('departures', cfg.transfers, n + 1),
        ...cfg.destinations.map((d) => many('arrivals', [d], n + 1)),
      ]);
      firstN = norm(first); tDepN = norm(tDep); searched = n;
      journeys = J.build({
        first: firstN,
        transfer: cfg.transfers.length ? { arrivals: norm(tArr), departures: tDepN } : null,
        dests: cfg.destinations.map((d, i) => ({ name: d.name || d.id, walk: d.walk, arrivals: norm(destArr[i]) })),
        walkTo: cfg.walk_to_stop,
        change: cfg.change_minutes,
        now,
      });
      if (journeys.some((j) => !j.canceled)) break;
    }
    const tvKey = this.keys().trafikverket;
    await Promise.all([trains.enrich(tvKey, firstN), trains.enrich(tvKey, tDepN)]); // tracks + delay reasons for trains
    const leg = ({ dep, arr }) => ({
      line: dep.line,
      lineName: dep.lineName && dep.lineName !== dep.line ? dep.lineName : '',
      mode: dep.mode,
      direction: dep.direction,
      from: dep.stop,
      platform: dep.platform,
      dep: { scheduled: dep.scheduled, expected: dep.expected, delayMin: dep.delayMin, realtime: dep.realtime },
      canceled: dep.canceled,
      notes: dep.notes || [],
      to: arr ? arr.stop : '',
      arr: arr ? { scheduled: arr.scheduled, expected: arr.expected, delayMin: arr.delayMin } : null,
    });
    return {
      origin: cfg.origin.name || cfg.origin.id,
      transfer: cfg.transfers.length ? cfg.transfers.map((x) => x.name || x.id).join(', ') : null,
      walkTo: cfg.walk_to_stop,
      updated: Date.now(),
      from,
      searchedHours: searched,
      journeys: journeys.map((j) => ({
        leave: j.leave, arrive: j.arrive, canceled: j.canceled, problem: j.problem, slack: j.slack, dest: j.dest || '', legs: j.legs.map(leg),
      })),
    };
  }

  async drive(cfg) {
    const key = this.keys().trafikverket;
    const d = cfg.drive;
    const roads = tv.parseRoads(d.roads);
    const radius = Number(d.radius_km) || 15;
    const start = cfg.origin && Number.isFinite(+cfg.origin.lat) ? { lat: +cfg.origin.lat, lon: +cfg.origin.lon } : { lat: +d.lat, lon: +d.lon };
    const [incidents, conditions, speeds, cameras, roadWx] = await Promise.all([
      tv.incidents(key, d.lon, d.lat, radius),
      tv.roadConditions(key, d.lon, d.lat, radius).catch(() => null),
      Promise.all([].concat(d.speed || []).map(async (s) => ({ name: s.name, ...(await tv.speed(key, s.lon, s.lat, s.radius_m || 300).catch(() => null)) }))),
      this.cached(`${cfg.id}:cameras`, TTL.cameras, () => this.cameras(cfg, key)).catch(() => []),
      tv.roadWeather(key, start.lat, start.lon).catch(() => null),
    ]);
    const list = rankIncidents(incidents.filter((i) => tv.onRoads(i, roads) && (i.message || i.location)));
    let condition = null;
    if (conditions) {
      const mine = conditions.filter((c) => tv.onRoads(c, roads));
      const worst = mine.sort((a, b) => b.code - a.code)[0];
      const slippery = mine.some((c) => c.code >= 2 || c.warnings.some((w) => /halk|snö|is/i.test(w)));
      condition = worst ? { text: worst.text || 'Normal', road: worst.road, warnings: worst.warnings, slippery, code: worst.code } : { text: 'Normal', slippery: false, code: 1 };
    }
    return {
      minutes: d.minutes || null,
      roads: d.roads || '',
      updated: Date.now(),
      incidents: list.slice(0, 30).map((i) => ({
        type: i.type, code: i.code, road: i.road, location: i.location, message: i.message, severity: i.severity, severityText: i.severityText,
        direction: i.direction, limit: i.limit, lanes: i.lanes, start: i.start, end: i.end,
        reported: i.reported, updated: i.updated,
      })),
      incidentCount: list.length,
      condition,
      speeds: speeds.filter((s) => s.speed),
      cameras,
      roadWeather: roadWx,
    };
  }

  /**
   * What the settings page offers for the car route between two points: cameras and speed sensors
   * in the route area, ordered from the start. Sensors are labelled with the nearest camera's name.
   */
  async roadOptions(a, b) {
    const key = this.keys().trafikverket;
    const area = routeArea(a, b);
    if (!area) throw new Error('Pick the start and destination stops first');
    const [cams, sites] = await Promise.all([
      tv.cameras(key, area.lon, area.lat, area.radius_km),
      tv.speedSites(key, area.lon, area.lat, area.radius_km * 1000).catch(() => []),
    ]);
    const off = (p) => crossTrackKm(a, b, p); // ≤ 4 km from the straight line
    const fromStart = (p) => tv.distanceKm({ lat: +a.lat, lon: +a.lon }, p);
    const cameras = cams.filter((c) => c.point && off(c.point) <= 4)
      .map((c) => ({ name: c.name, url: c.photoUrl, km: +fromStart(c.point).toFixed(1) }))
      .sort((x, y) => x.km - y.km);
    const sensors = sites.filter((p) => off(p) <= 4).map((p) => {
      const near = cams.filter((c) => c.point).map((c) => ({ c, d: tv.distanceKm(c.point, p) })).sort((x, y) => x.d - y.d)[0];
      const name = near && near.d < 1.5 ? near.c.name.replace(/\s+(norr|söder|öster|väster|nordost|nordöst|sydväst|sydost|sydöst|nordväst|norrut|söderut|österut|västerut)$/i, '') : `${fromStart(p).toFixed(0)} km`;
      return { name, lat: p.lat, lon: p.lon, speed: p.speed, km: +fromStart(p).toFixed(1) };
    }).sort((x, y) => x.km - y.km)
      .filter((p, i, all) => all.findIndex((o) => o.name === p.name) === i);
    return { area, cameras, sensors };
  }

  /**
   * Which stops to change at, tried against live departures. Candidates are the busiest stop areas
   * between the start and the destination (grouped with busy neighbours within 400 m, since a station's
   * trains and trams/buses often have separate stop areas). Returns options sorted by arrival:
   * [{ stops: [{ id, name, lat, lon }] (empty = direct), leave, arrive, legs: ["165", "1"], via }]
   */
  async suggestTransfers(raw, index) {
    const key = this.keys().trafiklab;
    const tz = this.tz();
    const origin = raw.origin;
    const dests = [].concat(raw.destinations || []).filter((d) => d && d.id);
    const end = dests.find((d) => Number.isFinite(+d.lat));
    if (!origin || !Number.isFinite(+origin.lat) || !end) throw new Error('Pick the From and To stops first');
    const a = { lat: +origin.lat, lon: +origin.lon }; const b = { lat: +end.lat, lon: +end.lon };
    const dist = tv.distanceKm(a, b);
    const ids = new Set([origin.id, ...dests.map((d) => String(d.id))]);
    const near = (p) => crossTrackKm(a, b, p) <= Math.max(3, dist * 0.3);
    const along = (p) => tv.distanceKm(a, p) > 0.8 && tv.distanceKm(p, b) < dist + 2;
    const cands = (await index.filter((r) => r[5] >= 40 && !ids.has(r[0])
      && Math.abs(r[2] - (a.lat + b.lat) / 2) < dist / 100 + 0.1 && Math.abs(r[3] - (a.lon + b.lon) / 2) < dist / 55 + 0.2))
      .filter((c) => near(c) && along(c))
      .sort((x, y) => y.daily - x.daily);
    const hubs = [];
    for (const c of cands) {
      if (hubs.length >= 3) break;
      if (hubs.some((h) => h.some((x) => tv.distanceKm(x, c) < 0.5))) continue;
      const hub = [c, ...cands.filter((o) => o !== c && o.daily >= 40 && tv.distanceKm(o, c) < 0.4)].slice(0, 3);
      hubs.push(hub);
    }
    // keep within the per-minute API budget: at most 6 hub stops (2 calls each)
    let budget = 6;
    const tried = hubs.map((h) => h.slice(0, Math.max(0, Math.min(h.length, budget))).filter(() => budget-- > 0)).filter((h) => h.length);

    const now = Date.now();
    const at = D.localIso(now, tz); const later = D.localIso(now + 60 * MIN, tz);
    const norm = (raw) => D.normalise(raw, tz);
    const [first, ...destArr] = await Promise.all([
      tl.board(key, 'departures', origin.id, at),
      ...dests.map(async (d) => [...await tl.board(key, 'arrivals', d.id, at), ...await tl.board(key, 'arrivals', d.id, later)]),
    ]);
    const base = {
      first: norm(first), dests: dests.map((d, i) => ({ name: d.name, walk: +d.walk || 0, arrivals: norm(destArr[i]) })),
      walkTo: +raw.walk_to_stop || 0, change: raw.change_minutes === undefined ? 3 : +raw.change_minutes, now,
    };
    const best = (journeys) => journeys.filter((j) => !j.canceled && j.leave >= now).sort((x, y) => x.arrive - y.arrive)[0] || null;
    const summary = (stops, j) => j && {
      stops: stops.map((x) => ({ id: x.id, name: x.name, lat: x.lat, lon: x.lon })),
      leave: j.leave, arrive: j.arrive, legs: j.legs.map((l) => `${l.dep.line}`), via: j.legs.length > 1 ? j.legs[0].arr.stop : '',
      minutes: Math.round((j.arrive - j.leave) / MIN),
    };
    const out = [];
    const direct = best(J.build({ ...base, transfer: null }));
    if (direct) out.push(summary([], direct));
    for (const hub of tried) {
      const lists = await Promise.all(hub.map(async (x) => [await tl.board(key, 'arrivals', x.id, at), await tl.board(key, 'departures', x.id, at)]));
      const j = best(J.build({ ...base, transfer: { arrivals: norm(lists.flatMap((l) => l[0])), departures: norm(lists.flatMap((l) => l[1])) } }));
      if (j) out.push(summary(hub, j));
    }
    // fastest door-to-door first; an option that is no faster than a simpler one is dropped
    out.sort((x, y) => x.minutes - y.minutes || x.stops.length - y.stops.length);
    return { options: out.filter((o, i) => !out.slice(0, i).some((p) => p.stops.length <= o.stops.length && p.minutes <= o.minutes && p.leave >= o.leave)), tried: tried.length };
  }

  /** Engine heater timing from the weather only (no public transport calls). */
  async heaterPlan(cfg) {
    if (!cfg.arrive_by || !cfg.drive || !cfg.drive.minutes || !cfg.weather.length) return null;
    const tz = this.tz(); const now = Date.now();
    const [winStart] = nextWindow(now, tz, cfg);
    const arriveBy = P.timeOnDay(cfg.arrive_by, winStart, tz);
    const carLeave = arriveBy - cfg.drive.minutes * MIN;
    const w = await this.cached(`${cfg.id}:weather`, TTL.weather, () => this.weather(cfg, tz));
    const hour = w.places && w.places[0] ? P.forecastAt(w.places[0].allHours, carLeave) : null;
    const temp = hour ? hour.temp : null;
    const heaterMinutes = P.heaterMinutes(temp);
    return { carLeave, temp, heaterMinutes, heaterAt: heaterMinutes ? carLeave - heaterMinutes * MIN : null };
  }

  /** Run an unsaved config once (for the settings page "Test" button), without touching the cache. */
  async preview(raw) {
    const cfg = normaliseConfig({ ...raw, id: `preview-${Date.now()}` });
    try {
      return await this.get(cfg, { preview: false });
    } finally {
      for (const k of [...this.cache.keys()]) if (k.startsWith(`${cfg.id}:`)) this.cache.delete(k);
    }
  }

  /** Resolve the configured camera names (substring match) to photo urls, in config order. */
  async cameras(cfg, key) {
    const d = cfg.drive;
    const want = [].concat(d.cameras || []);
    if (!want.length) return [];
    // by name anywhere in Sweden (exact name first, then the nearest partial match)
    const near = Number.isFinite(+d.lat) ? { lat: +d.lat, lon: +d.lon } : null;
    const found = await Promise.all(want.map((w) => tv.searchCameras(key, w, near, 1).then((r) => r[0] || null)));
    return found.filter(Boolean).map((c) => ({ name: c.name, url: c.photoUrl }));
  }

  async weather(cfg, tz) {
    const [start, end] = nextWindow(Date.now(), tz, cfg);
    const from = Math.ceil(start / 3600000) * 3600000; // first whole hour of the window
    const places = await Promise.all(cfg.weather.map(async (w) => {
      const f = await smhi.forecast(w.lat, w.lon);
      return { name: w.name || '', hours: f.filter((h) => h.time >= from && h.time <= end).slice(0, 4), allHours: f.filter((h) => h.time >= Date.now() - 3600000 && h.time <= Date.now() + 30 * 3600000) };
    }));
    return { start, end, places, updated: Date.now() };
  }
}

/**
 * Road messages in the order a commuter cares about: messages that have already ended are dropped,
 * then accidents, then anything reported in the last day, then by severity. Roadworks and other
 * messages that have been there for over a week go last, however severe (you already know about them).
 */
function rankIncidents(incidents, now = Date.now()) {
  const t = (x) => (x ? new Date(x).getTime() : NaN);
  const DAY = 24 * 3600000;
  const rank = (i) => {
    const age = now - (t(i.reported) || t(i.start) || now);
    if (/olycka|accident/i.test(i.type)) return 0;
    if (age < DAY) return 1;
    if (age > 7 * DAY) return 3;
    return 2;
  };
  return incidents
    .filter((i) => !(t(i.end) < now))
    .filter((i, n, all) => all.findIndex((o) => o.road === i.road && o.location === i.location && o.type === i.type) === n)
    .sort((a, b) => rank(a) - rank(b) || (b.severity || 0) - (a.severity || 0) || (t(b.reported) || 0) - (t(a.reported) || 0));
}

module.exports = { Commutes, parseConfigs, normaliseConfig, nextWindow, routeArea, rankIncidents };
