'use strict';

// OpenStreetMap's Nominatim, for the address search in the settings.
// A free public service with fair-use rules: identify the app, keep requests occasional and user-driven.
// Data © OpenStreetMap contributors (ODbL).

const http = require('./http');

const UA = 'Trafikkollen Homey app (com.erikrichardson.trafik)';

/** Places in Sweden matching a free-text query: [{ name, lat, lon }] */
async function geocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=se&limit=6&accept-language=sv&q=${encodeURIComponent(q)}`;
  const res = await http.request(url, { headers: { 'User-Agent': UA }, timeout: 15000 });
  if (!res.ok) throw new Error(`Address search failed (HTTP ${res.status})`);
  return (await res.json()).map((x) => {
    const parts = String(x.display_name || '').split(', ');
    const short = parts.filter((p) => !/kommun$|län$|^Sverige$|^\d{3} \d{2}$/.test(p)).slice(0, 4).join(', ');
    return { name: short || x.name || parts[0], lat: +(+x.lat).toFixed(6), lon: +(+x.lon).toFixed(6) };
  }).filter((x) => x.name);
}

module.exports = { geocode, UA };
