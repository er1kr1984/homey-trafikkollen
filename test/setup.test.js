'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { groupSplitter, toRow, walkMinutes } = require('../lib/stopindex');

test('stop list: split stop_groups out of a stream, whatever the chunk boundaries', () => {
  const json = JSON.stringify({
    timestamp: 'x',
    stop_groups: [
      { id: '1', name: 'A "quoted" {name}', average_daily_stop_times: 12.4, transport_modes: ['BUS'], stops: [{ id: 's', name: 'A', lat: 55.5, lon: 13.2 }] },
      { id: '2', name: 'B [x]', average_daily_stop_times: 0, transport_modes: [], stops: [{ id: 't', name: 'B', lat: 59.3, lon: 18.06 }] },
    ],
    trailer: { stop_groups: 'not this' },
  });
  for (const size of [1, 7, 64, json.length]) {
    const rows = [];
    const feed = groupSplitter((t) => rows.push(toRow(JSON.parse(t))));
    for (let i = 0; i < json.length; i += size) feed(json.slice(i, i + size));
    assert.deepStrictEqual(rows, [['1', 'A "quoted" {name}', 55.5, 13.2, 'BUS', 12], ['2', 'B [x]', 59.3, 18.06, '', 0]], `chunk ${size}`);
  }
});

test('walking minutes from straight-line metres', () => {
  assert.strictEqual(walkMinutes(0), 1);
  assert.strictEqual(walkMinutes(530), 9); // 530 m * 1.25 / 80 m/min
});

test('camera search: quotes ignored, word matches before substrings, nearest first, names deduped', async () => {
  const tv = require('../lib/trafikverket');
  const cams = [
    ['Gammoramotet', 63.15, 13.23], ['Mora N', 61.218, 14.524], ['Mora Södra Nordöst', 61.178, 14.48],
    ['Mora Södra Nordöst', 61.178, 14.481], ['Tpl Mora S', 61.17, 14.47], ['Orsa Ö', 61.008, 14.626],
  ];
  const http = require('../lib/http');
  const orig = http.request;
  http.request = async () => ({
    ok: true, status: 200,
    json: async () => ({ RESPONSE: { RESULT: [{ Camera: cams.map(([n, la, lo], i) => ({ Id: `c${i}`, Name: n, PhotoUrl: `u${i}`, Geometry: { WGS84: `POINT (${lo} ${la})` } })) }] } }),
  });
  try {
    const near = { lat: 61.02, lon: 14.51 };
    const r = await tv.searchCameras('k', "'Mora'", near, 10);
    assert.deepStrictEqual(r.map((c) => c.name), ['Mora Södra Nordöst', 'Mora N', 'Tpl Mora S', 'Gammoramotet']);
    assert.strictEqual((await tv.searchCameras('k', 'mora n', near))[0].name, 'Mora N');
    assert.deepStrictEqual(await tv.searchCameras('k', '  ', near), []);
  } finally { http.request = orig; }
});

test('stop table: columns give back the same rows, also after saving to JSON', () => {
  const { Table } = require('../lib/stopindex');
  const rows = [['740000005', 'Uppsala C', 59.858, 17.646, 'BUS,TRAIN', 812], ['9021014001760000', 'Odd id', 59.3, 18.06, '', 0],
    ['x-1', 'Text id, "quoted"', 57.7, 11.97, 'BUS', 3], ['740000001', 'Stockholm C', 59.33, 18.059, 'BUS,TRAIN', 4000]];
  const t = new Table(2);
  for (const r of rows) t.push(r);
  t.finish();
  assert.strictEqual(t.length, 4);
  assert.deepStrictEqual([0, 1, 2, 3].map((i) => t.row(i)), rows);
  const back = Table.fromJSON(JSON.parse(JSON.stringify(t)));
  assert.deepStrictEqual([0, 1, 2, 3].map((i) => back.row(i)), rows);
});
