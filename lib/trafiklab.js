'use strict';

// Trafiklab Realtime APIs (GTFS Sweden 3 based, every regional operator in Sweden).
// Docs: https://www.trafiklab.se/api/our-apis/trafiklab-realtime-apis/
// Responses are cached server-side for 60 s, so polling faster than that is pointless.
// Data is CC BY 4.0 - credit "Trafiklab.se".

const http = require('./http');

const BASE = 'https://realtime-api.trafiklab.se/v1';

// Bronze keys allow 25 calls/min. Keep a little under that by queueing calls app-wide.
const PER_MIN = 22;
const recent = [];
async function slot() {
  for (;;) {
    const now = Date.now();
    while (recent.length && now - recent[0] > 60000) recent.shift();
    if (recent.length < PER_MIN) { recent.push(now); return; }
    await new Promise((r) => setTimeout(r, 60000 - (now - recent[0]) + 50));
  }
}

async function get(path, key) {
  if (!key) throw new Error('No Trafiklab API key - add it in the app settings');
  await slot();
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
  const res = await http.request(url, { timeout: 15000 });
  if (res.status === 401 || res.status === 403) throw new Error('Trafiklab rejected the API key (check it in the app settings)');
  if (res.status === 429) throw new Error('Trafiklab quota exceeded - poll less often or upgrade the key level');
  if (!res.ok) throw new Error(`Trafiklab HTTP ${res.status}`);
  return res.json();
}

/** Stop areas matching a name, most-served first: [{ id, name, modes, lat, lon, dailyStops }] */
async function searchStops(key, query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const data = await get(`/stops/name/${encodeURIComponent(q)}`, key);
  return (data.stop_groups || []).map((g) => ({
    id: String(g.id),
    name: g.name,
    modes: g.transport_modes || [],
    lat: g.stops && g.stops[0] ? g.stops[0].lat : null,
    lon: g.stops && g.stops[0] ? g.stops[0].lon : null,
    dailyStops: g.average_daily_stop_times || 0,
  }));
}

/** Raw departures for the next 60 minutes from a stop area (rikshållplats / meta-stop id). */
async function departures(key, areaId) {
  const data = await get(`/departures/${encodeURIComponent(areaId)}`, key);
  return { departures: data.departures || [], stops: data.stops || [] };
}

/**
 * Raw departures or arrivals for the 60 minutes starting at `at` (local "YYYY-MM-DDTHH:mm", empty = now).
 * Entries carry trip.trip_id, so the same vehicle can be followed from one stop to the next.
 */
async function board(key, kind, areaId, at = '') {
  const data = await get(`/${kind}/${encodeURIComponent(areaId)}${at ? `/${at}` : ''}`, key);
  return data[kind] || [];
}

module.exports = { searchStops, departures, board, slot, BASE };
