'use strict';

// Extra train details from Trafikverket (all trains in Sweden): the track, cancellations and the reason for
// a delay ("Signalfel", "Inställt"), added to Trafiklab departures. Trafiklab often has no platform for
// regional trains, and Trafikverket's deviation texts are more specific.

const tv = require('./trafikverket');

const stationCache = new Map(); // "lat,lon" -> { sig, at } (signature or null)

/** Trafikverket station signature (e.g. "Cst" for Stockholm C) within 800 m of a point, or null. */
async function stationNear(key, lat, lon) {
  const k = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const c = stationCache.get(k);
  if (c && Date.now() - c.at < 7 * 86400000) return c.sig;
  const r = await tv.post(key, `<QUERY objecttype="TrainStation" namespace="rail.infrastructure" schemaversion="1.5" limit="1">`
    + `<FILTER><NEAR name="Geometry.WGS84" value="${lon} ${lat}" mindistance="0" maxdistance="800"/></FILTER>`
    + '<INCLUDE>LocationSignature</INCLUDE><INCLUDE>AdvertisedLocationName</INCLUDE></QUERY>');
  const st = (r.TrainStation || [])[0];
  const sig = st ? st.LocationSignature : null;
  stationCache.set(k, { sig, at: Date.now() });
  return sig;
}

/** Departures from a station for the next ~3 hours: Map trainIdent -> [{ advertised, track, canceled, notes }] */
async function departuresAt(key, sig) {
  const r = await tv.post(key, `<QUERY objecttype="TrainAnnouncement" schemaversion="1.9" limit="400" orderby="AdvertisedTimeAtLocation">`
    + `<FILTER><AND><EQ name="LocationSignature" value="${sig}"/><EQ name="ActivityType" value="Avgang"/>`
    + '<GT name="AdvertisedTimeAtLocation" value="$dateadd(-00:30:00)"/><LT name="AdvertisedTimeAtLocation" value="$dateadd(03:00:00)"/></AND></FILTER>'
    + '<INCLUDE>AdvertisedTrainIdent</INCLUDE><INCLUDE>AdvertisedTimeAtLocation</INCLUDE><INCLUDE>TrackAtLocation</INCLUDE>'
    + '<INCLUDE>Canceled</INCLUDE><INCLUDE>Deviation</INCLUDE><INCLUDE>OtherInformation</INCLUDE><INCLUDE>EstimatedTimeAtLocation</INCLUDE></QUERY>');
  const map = new Map();
  for (const a of r.TrainAnnouncement || []) {
    const notes = [...(a.Deviation || []), ...(a.OtherInformation || [])]
      .map((x) => String(x.Description || '').trim())
      // drop ticket/boarding small print; keep anything about cancellations, replacement buses and delays
      .filter((t) => t && (/inställ|ersätt|buss|försen|orsak|stannar ej|byte/i.test(t) || !/biljett|bokning|påstigning|^spår|prel\. tid|kort tåg|långt tåg|servering|bistro|kiosk/i.test(t)));
    const e = { advertised: Date.parse(a.AdvertisedTimeAtLocation), track: a.TrackAtLocation || '', canceled: !!a.Canceled, notes };
    if (!map.has(a.AdvertisedTrainIdent)) map.set(a.AdvertisedTrainIdent, []);
    map.get(a.AdvertisedTrainIdent).push(e);
  }
  return map;
}

/**
 * Add { track, notes, canceled } from Trafikverket to normalised TRAIN departures (in place).
 * Matching: train number (line or technical number) at the station nearest the stop, scheduled time ±3 min.
 * Failures are ignored: the departures just stay as Trafiklab gave them.
 */
async function enrich(key, deps) {
  const trains = deps.filter((d) => d.mode === 'TRAIN' && d.stopLat != null);
  if (!key || !trains.length) return deps;
  const byStation = new Map();
  for (const d of trains) {
    const k = `${d.stopLat.toFixed(3)},${d.stopLon.toFixed(3)}`;
    if (!byStation.has(k)) byStation.set(k, { lat: d.stopLat, lon: d.stopLon, deps: [] });
    byStation.get(k).deps.push(d);
  }
  await Promise.all([...byStation.values()].map(async (g) => {
    try {
      const sig = await stationNear(key, g.lat, g.lon);
      if (!sig) return;
      const info = await departuresAt(key, sig);
      for (const d of g.deps) {
        const cands = [...(info.get(d.line) || []), ...(info.get(d.techNo) || [])];
        const hit = cands.find((x) => Math.abs(x.advertised - d.scheduled) <= 3 * 60000);
        if (!hit) continue;
        if (hit.track && !d.platform) d.platform = hit.track;
        d.track = hit.track;
        if (hit.canceled) d.canceled = true;
        d.notes = [...new Set([...(d.notes || []), ...hit.notes])];
      }
    } catch (e) { /* keep Trafiklab data */ }
  }));
  return deps;
}

module.exports = { enrich, stationNear, departuresAt };
