'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { rankIncidents } = require('../lib/commute');

const now = Date.parse('2026-10-23T19:30:00+02:00');
const inc = (o) => ({ road: 'E6', type: 'Trafikmeddelande', location: o.id, severity: 2, ...o });

test('road messages: ended ones go, accidents and fresh news first, old roadworks last', () => {
  const list = rankIncidents([
    inc({ id: 'old-closure', severity: 5, reported: '2026-06-05T12:40:00+02:00', end: '2026-11-02T16:00:00+01:00' }),
    inc({ id: 'ended-accident', type: 'Olycka', severity: 4, reported: '2026-10-23T08:09:00+02:00', end: '2026-10-23T09:10:00+02:00' }),
    inc({ id: 'new-queue', severity: 2, reported: '2026-10-23T18:50:00+02:00' }),
    inc({ id: 'accident', type: 'Olycka', severity: 3, reported: '2026-10-23T19:10:00+02:00' }),
    inc({ id: 'last-week', type: 'Vägarbete', severity: 3, reported: '2026-10-19T10:00:00+02:00' }),
    inc({ id: 'no-dates', severity: 1 }),
  ], now);
  assert.deepStrictEqual(list.map((i) => i.id), ['accident', 'new-queue', 'no-dates', 'last-week', 'old-closure']);
});
