'use strict';

// Trafikverket open API (Datautbytesportalen), XML query in, JSON out.
// Docs: https://data.trafikverket.se  (key: free, from the same site)
// Query variants are tried in order and the first that works is remembered, because
// schema versions/field names differ between versions and get retired over time.

const http = require('./http');

const URL = 'https://api.trafikinfo.trafikverket.se/v2/data.json';

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

// usage counting (lib/usage.js): the app sets a listener; each query is reported with its objecttype
let listener = null;
function onRequest(fn) { listener = fn; }
function note(type) {
  if (listener) try { listener(type); } catch (e) { /* counting must never break a request */ }
}

async function post(key, queryXml) {
  if (!key) throw new Error('No Trafikverket API key - add it in the app settings');
  note((/objecttype="([^"]+)"/.exec(queryXml) || [])[1]);
  const body = `<REQUEST><LOGIN authenticationkey="${esc(key)}"/>${queryXml}</REQUEST>`;
  const res = await http.request(URL, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body, timeout: 20000 });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON error page */ }
  const result = json && json.RESPONSE && json.RESPONSE.RESULT && json.RESPONSE.RESULT[0];
  const err = result && result.ERROR ? result.ERROR.MESSAGE || JSON.stringify(result.ERROR) : null;
  if (res.status === 401 || /authentic|invalid.*key|unauthori/i.test(err || '')) {
    const e = new Error('Trafikverket rejected the API key (check it in the app settings)');
    e.auth = true;
    throw e;
  }
  if (err || !res.ok) throw new Error(`Trafikverket: ${err || `HTTP ${res.status}`}`);
  return result;
}

// Geo filter variants: NEAR (sorted, max distance) and WITHIN center/radius.
const near = (field, lon, lat, m) => `<NEAR name="${field}" value="${lon} ${lat}" mindistance="0" maxdistance="${Math.round(m)}"/>`;
const within = (field, lon, lat, m) => `<WITHIN name="${field}" shape="center" value="${lon} ${lat}" radius="${Math.round(m)}m"/>`;

const VARIANTS = {
  Situation: [
    { ns: 'road.trafficinfo', v: '1.6', field: 'Deviation.Geometry.Point.WGS84', geo: near },
    { ns: 'road.trafficinfo', v: '1.6', field: 'Deviation.Geometry.Point.WGS84', geo: within },
    { ns: 'road.trafficinfo', v: '1.5', field: 'Deviation.Geometry.Point.WGS84', geo: near },
    { ns: 'road.trafficinfo', v: '1.5', field: 'Deviation.Geometry.Point.WGS84', geo: within },
    { ns: 'road.trafficinfo', v: '1.4', field: 'Deviation.Geometry.WGS84', geo: near },
    { ns: 'road.trafficinfo', v: '1.4', field: 'Deviation.Geometry.WGS84', geo: within },
  ],
  RoadCondition: [
    { ns: 'road.trafficinfo', v: '1.2', field: 'Geometry.WGS84', geo: near },
    { ns: 'road.trafficinfo', v: '1.2', field: 'Geometry.WGS84', geo: within },
    { ns: 'road.trafficinfo', v: '1.1', field: 'Geometry.WGS84', geo: near },
  ],
  TrafficFlow: [
    { ns: 'road.trafficinfo', v: '1.5', field: 'Geometry.WGS84', geo: within },
    { ns: 'road.trafficinfo', v: '1.4', field: 'Geometry.WGS84', geo: within },
  ],
  Camera: [
    { ns: 'road.infrastructure', v: '1', field: 'Geometry.WGS84', geo: near },
    { ns: 'road.infrastructure', v: '1', field: 'Geometry.WGS84', geo: within },
    { ns: 'road.infrastructure', v: '1.0', field: 'Geometry.WGS84', geo: near },
  ],
};
const chosen = {}; // objecttype -> index of the variant that worked

async function geoQuery(key, objecttype, lon, lat, meters, extraFilter = '', limit = 200) {
  const variants = VARIANTS[objecttype];
  const order = chosen[objecttype] !== undefined ? [chosen[objecttype]] : variants.map((_, i) => i);
  let lastErr;
  for (const i of order) {
    const va = variants[i];
    const q = `<QUERY objecttype="${objecttype}" namespace="${va.ns}" schemaversion="${va.v}" limit="${limit}">`
      + `<FILTER>${extraFilter ? '<AND>' : ''}${va.geo(va.field, lon, lat, meters)}${extraFilter}${extraFilter ? '</AND>' : ''}</FILTER></QUERY>`;
    try {
      const r = await post(key, q);
      chosen[objecttype] = i;
      return r[objecttype] || [];
    } catch (e) {
      if (e.auth) throw e;
      lastErr = e;
      // "Valid versions for Situation are 1.6": learn the version the API wants and try it next.
      const m = /valid versions? for \w+ (?:is|are)\s*([\d.,\s]+)/i.exec(e.message);
      if (m) {
        for (const v of m[1].split(/[,\s]+/).filter(Boolean).reverse()) {
          if (variants.some((x) => x.v === v)) continue;
          const learned = [{ ...variants[0], v }, { ...variants[0], v, geo: variants[0].geo === near ? within : near }];
          variants.push(...learned);
          order.push(variants.length - 2, variants.length - 1);
        }
      }
    }
  }
  if (chosen[objecttype] !== undefined) delete chosen[objecttype]; // retry all variants next time
  throw lastErr;
}

/** "POINT (13.2 55.5)" -> { lon, lat } */
function parsePoint(wkt) {
  const m = /POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i.exec(wkt || '');
  return m ? { lon: +m[1], lat: +m[2] } : null;
}

function distanceKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** Road incidents (deviations) near a point: [{ id, type, message, road, roadNumeric, location, severity, severityText, start, end, reported, updated, point }] */
async function incidents(key, lon, lat, radiusKm) {
  const situations = await geoQuery(key, 'Situation', lon, lat, radiusKm * 1000);
  const out = [];
  for (const s of situations) {
    if (s.Deleted) continue;
    for (const d of s.Deviation || []) {
      const g = d.Geometry || {};
      out.push({
        id: d.Id || `${s.Id}:${d.MessageCode}:${d.StartTime}`,
        type: d.MessageType || 'Trafikmeddelande',
        code: d.MessageCode || '',
        message: d.Message || d.MessageCode || '',
        road: d.RoadNumber || '',
        roadNumeric: d.RoadNumberNumeric,
        location: d.LocationDescriptor || d.PositionalDescription || '',
        severity: d.SeverityCode || 0,
        severityText: d.SeverityText || '',
        direction: d.AffectedDirection || '',
        limit: d.TemporaryLimit || '',
        lanes: d.NumberOfLanesRestricted || null,
        start: d.StartTime || null,
        end: d.EndTime || null,
        // when Trafikverket first reported it, and when it last changed
        reported: d.CreationTime || s.PublicationTime || null,
        updated: d.VersionTime || s.VersionTime || null,
        point: parsePoint((g.Point && g.Point.WGS84) || g.WGS84),
      });
    }
  }
  return out;
}

/** Road condition segments near a point: [{ code, text, warnings, road, measure }] */
async function roadConditions(key, lon, lat, radiusKm) {
  const rows = await geoQuery(key, 'RoadCondition', lon, lat, radiusKm * 1000);
  return rows.map((r) => ({
    code: r.ConditionCode || 0,
    text: r.ConditionText || '',
    warnings: [].concat(r.Warning || []),
    road: r.RoadNumber || (r.RoadNumberNumeric ? String(r.RoadNumberNumeric) : ''),
    roadNumeric: r.RoadNumberNumeric,
    measure: r.Measurement || r.Cause || '',
  }));
}

/** Active traffic cameras near a point, nearest first: [{ id, name, photoUrl, point, km, direction }] */
async function cameras(key, lon, lat, radiusKm) {
  const rows = await geoQuery(key, 'Camera', lon, lat, radiusKm * 1000);
  const here = { lon, lat };
  return rows
    .filter((c) => c.Active !== false && c.PhotoUrl)
    .map((c) => {
      const point = parsePoint(c.Geometry && c.Geometry.WGS84);
      return {
        id: c.Id, name: c.Name || c.Id, photoUrl: c.PhotoUrl, point,
        km: point ? distanceKm(here, point) : null, direction: c.Direction,
      };
    })
    .sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9));
}

/** "E65, 108, väg 101" -> Set{"E65","108","101"} ; empty set = all roads */
function parseRoads(text) {
  return new Set(String(text || '').split(',').map((x) => x.trim().toUpperCase().replace(/^V[ÄA]G\s*/, '').replace(/\s+/g, '')).filter(Boolean));
}

function onRoads(item, roads) {
  if (!roads.size) return true;
  const r = String(item.road || '').toUpperCase().replace(/^V[ÄA]G\s*/, '').replace(/\s+/g, '');
  return roads.has(r) || (item.roadNumeric !== undefined && item.roadNumeric !== null && roads.has(String(item.roadNumeric)));
}

/**
 * Live speed from Trafikverket's road sensors within `meters` of a point (all lanes, both directions):
 * { speed (km/h, traffic-weighted), slowest, flow (vehicles/h), lanes, measured (ISO) } or null if no sensors.
 */
async function speed(key, lon, lat, meters) {
  const rows = (await geoQuery(key, 'TrafficFlow', lon, lat, meters)).filter((r) => !r.Deleted && r.AverageVehicleSpeed > 0);
  if (!rows.length) return null;
  const flow = rows.reduce((n, r) => n + (r.VehicleFlowRate || 0), 0);
  const weighted = flow
    ? rows.reduce((n, r) => n + r.AverageVehicleSpeed * (r.VehicleFlowRate || 0), 0) / flow
    : rows.reduce((n, r) => n + r.AverageVehicleSpeed, 0) / rows.length;
  return {
    speed: Math.round(weighted),
    slowest: Math.round(Math.min(...rows.map((r) => r.AverageVehicleSpeed))),
    flow,
    lanes: rows.length,
    measured: rows.map((r) => r.MeasurementTime).sort().pop() || null,
  };
}

/** Speed sensor sites within `meters`, lanes merged per ~300 m cluster: [{ lat, lon, speed, lanes }] */
async function speedSites(key, lon, lat, meters) {
  const rows = (await geoQuery(key, 'TrafficFlow', lon, lat, meters, '', 2000)).filter((r) => !r.Deleted);
  const sites = [];
  for (const r of rows) {
    const p = parsePoint(r.Geometry && r.Geometry.WGS84);
    if (!p) continue;
    let s = sites.find((x) => distanceKm(x, p) < 0.3);
    if (!s) sites.push(s = { lat: p.lat, lon: p.lon, speeds: [] });
    if (r.AverageVehicleSpeed > 0) s.speeds.push(r.AverageVehicleSpeed);
  }
  return sites.map((s) => ({
    lat: +s.lat.toFixed(4), lon: +s.lon.toFixed(4), lanes: s.speeds.length,
    speed: s.speeds.length ? Math.round(s.speeds.reduce((a, b) => a + b, 0) / s.speeds.length) : null,
  }));
}

// Every traffic camera in Sweden (~1600, ~0.4 MB), cached for camera search by name.
let allCams = null; // { at, list }
let allCamsLoading = null; // one download at a time, shared by callers asking at the same moment
async function allCameras(key) {
  if (allCams && Date.now() - allCams.at < 12 * 3600 * 1000) return allCams.list;
  if (!allCamsLoading) allCamsLoading = loadAllCameras(key).finally(() => { allCamsLoading = null; });
  return allCamsLoading;
}

async function loadAllCameras(key) {
  const r = await post(key, '<QUERY objecttype="Camera" namespace="road.infrastructure" schemaversion="1" limit="5000">'
    + '<INCLUDE>Id</INCLUDE><INCLUDE>Name</INCLUDE><INCLUDE>Geometry.WGS84</INCLUDE><INCLUDE>PhotoUrl</INCLUDE><INCLUDE>Active</INCLUDE><INCLUDE>Direction</INCLUDE></QUERY>');
  const list = (r.Camera || []).filter((c) => c.Active !== false && c.PhotoUrl).map((c) => ({
    id: c.Id, name: c.Name || c.Id, photoUrl: c.PhotoUrl, point: parsePoint(c.Geometry && c.Geometry.WGS84), direction: c.Direction,
  }));
  allCams = { at: Date.now(), list };
  return list;
}

/** "'Mora N'" / ' mora  n ' -> "mora n" (people paste quotes from hints) */
const cleanName = (q) => String(q || '').replace(/["'`´‘’“”]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Cameras matching a typed name anywhere in Sweden, best first: exact name, then a word starting with
 * what was typed ("mora" -> "Mora N", "Tpl Mora S"), then any substring ("Gammoramotet"); ties by distance
 * from `near` ({ lat, lon }, optional). [{ id, name, photoUrl, point, km }]
 */
async function searchCameras(key, q, near = null, limit = 12) {
  const want = cleanName(q);
  if (!want) return [];
  const list = await allCameras(key);
  const words = (n) => n.split(/[\s\-/,.()]+/);
  const scored = [];
  for (const c of list) {
    const n = c.name.toLowerCase();
    let rank = null;
    if (n === want) rank = 0;
    else if (n.startsWith(want)) rank = 1;
    else if (words(n).some((w) => w.startsWith(want)) || n.includes(` ${want}`)) rank = 2;
    else if (n.includes(want)) rank = 3;
    if (rank === null) continue;
    const km = near && c.point ? distanceKm(near, c.point) : null;
    scored.push({ ...c, km: km === null ? null : +km.toFixed(1), rank });
  }
  scored.sort((a, b) => a.rank - b.rank || (a.km ?? 1e9) - (b.km ?? 1e9) || a.name.localeCompare(b.name, 'sv'));
  const seen = new Set(); // a few cameras share a name; the nearest one is enough
  return scored.filter((c) => !seen.has(c.name) && seen.add(c.name)).slice(0, limit).map(({ rank, ...c }) => c);
}

/** Nearest Trafikverket road weather station within `meters`: { name, km, surface, air, at } (°C) or null. */
async function roadWeather(key, lat, lon, meters = 25000) {
  const r = await post(key, `<QUERY objecttype="WeatherMeasurepoint" namespace="Road.WeatherInfo" schemaversion="2.1" limit="1">`
    + `<FILTER><NEAR name="Geometry.WGS84" value="${lon} ${lat}" mindistance="0" maxdistance="${Math.round(meters)}"/></FILTER></QUERY>`);
  const w = (r.WeatherMeasurepoint || [])[0];
  if (!w || !w.Observation) return null;
  const o = w.Observation;
  const val = (x) => (x && Number.isFinite(x.Value) ? x.Value : null);
  const p = parsePoint(w.Geometry && w.Geometry.WGS84);
  return {
    name: w.Name, km: p ? +distanceKm({ lat, lon }, p).toFixed(1) : null,
    surface: val(o.Surface && o.Surface.Temperature), air: val(o.Air && o.Air.Temperature), at: o.Sample || null,
  };
}

module.exports = { onRequest, note, roadWeather, incidents, roadConditions, cameras, speed, speedSites, allCameras, searchCameras, cleanName, parseRoads, onRoads, distanceKm, parsePoint, post };
