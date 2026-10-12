'use strict';

// Trafikverket's road ferries (vägfärjor, ~40 routes: Hönö, Vaxholm, Visingsö …): live departures and
// disruption messages. Uses the Trafikverket key.

const tv = require('./trafikverket');

let routeCache = null; // { at, list }

/** All ferry routes: [{ id, name, short, harbors: [{ id, name }], deviationId, point }] (cached a day) */
async function routes(key) {
  if (routeCache && Date.now() - routeCache.at < 86400000) return routeCache.list;
  const r = await tv.post(key, '<QUERY objecttype="FerryRoute" namespace="ferry.trafficinfo" schemaversion="1.2" limit="500"></QUERY>');
  const list = (r.FerryRoute || []).filter((x) => !x.Deleted).map((x) => ({
    id: x.Id, name: x.Name, short: x.Shortname,
    harbors: (x.Harbor || []).sort((a, b) => (a.SortOrder || 0) - (b.SortOrder || 0)).map((h) => ({ id: h.Id, name: h.Name })),
    deviationId: x.DeviationId || null,
    point: tv.parsePoint(x.Geometry && x.Geometry.WGS84),
  })).sort((a, b) => a.name.localeCompare(b.name, 'sv'));
  routeCache = { at: Date.now(), list };
  return list;
}

/** Departures from a harbor on a route, next 6 hours: [{ time, from, to, info: [] }] */
async function departures(key, routeId, harborId) {
  const r = await tv.post(key, `<QUERY objecttype="FerryAnnouncement" namespace="ferry.trafficinfo" schemaversion="1.2" limit="60" orderby="DepartureTime">`
    + `<FILTER><AND><EQ name="Route.Id" value="${Number(routeId)}"/><EQ name="FromHarbor.Id" value="${Number(harborId)}"/>`
    + '<GT name="DepartureTime" value="$dateadd(-00:05:00)"/><LT name="DepartureTime" value="$dateadd(06:00:00)"/></AND></FILTER></QUERY>');
  return (r.FerryAnnouncement || []).filter((a) => !a.Deleted).map((a) => ({
    id: String(a.Id), time: Date.parse(a.DepartureTime), from: a.FromHarbor && a.FromHarbor.Name, to: a.ToHarbor && a.ToHarbor.Name,
    info: (a.Info || []).map((x) => String(x).trim()).filter(Boolean),
  }));
}

/** Current disruption messages for a route (Trafikverket traffic messages of type "Färjor" for it). */
async function disruptions(key, route) {
  if (!route.point) return [];
  const r = await tv.post(key, `<QUERY objecttype="Situation" namespace="road.trafficinfo" schemaversion="1.6" limit="50">`
    + `<FILTER><AND><EQ name="Deviation.MessageType" value="Färjor"/>`
    + `<NEAR name="Deviation.Geometry.Point.WGS84" value="${route.point.lon} ${route.point.lat}" mindistance="0" maxdistance="15000"/></AND></FILTER></QUERY>`)
    .catch(() => ({}));
  const out = [];
  for (const s of r.Situation || []) {
    for (const d of s.Deviation || []) {
      const about = `${d.Header || ''} ${d.RoadName || ''} ${d.LocationDescriptor || ''}`.toLowerCase();
      if (d.Id !== route.deviationId && !about.includes(route.name.toLowerCase())) continue;
      const text = String(d.Message || '').trim();
      if (text) out.push({ id: d.Id, text, severity: d.SeverityCode || 0, start: d.StartTime, end: d.EndTime });
    }
  }
  return out.filter((x, i, a) => a.findIndex((y) => y.text === x.text) === i);
}

module.exports = { routes, departures, disruptions };
