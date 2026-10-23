'use strict';

// All Swedish stop areas with coordinates, for "stops near a place". Trafiklab has no nearby search, but
// /stops/list returns every stop area (~12 MB JSON). It is streamed and reduced to a compact list on the fly
// (never held as one big string), saved to disk, and refreshed weekly. Only used during setup.
// In memory it is kept as columns (typed arrays and one joined string), ~3 MB instead of ~11 MB as rows.

const fs = require('fs');
const tl = require('./trafiklab');
const http = require('./http');

const MAX_AGE = 7 * 86400000;
const FORMAT = 2;

/** Feed text chunks; calls onObject(text) for every object directly inside the "stop_groups" array. */
function groupSplitter(onObject) {
  let started = false; let head = '';
  let depth = 0; let inStr = false; let esc = false;
  let part = null; // text of the current object from earlier chunks (null = not inside an object)
  return (chunk) => {
    if (!started) {
      head += chunk;
      const at = head.indexOf('"stop_groups"');
      if (at < 0) { head = head.slice(-20); return; }
      const open = head.indexOf('[', at);
      if (open < 0) return;
      started = true; chunk = head.slice(open + 1); head = ''; depth = 0;
    }
    let from = part !== null ? 0 : -1; // where the current object starts in this chunk
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (inStr) {
        if (esc) esc = false; else if (c === 92) esc = true; else if (c === 34) inStr = false; // \ and "
        continue;
      }
      if (c === 34) inStr = true;
      else if (c === 123 || c === 91) { // { [
        if (depth === 0 && c === 123) { from = i; part = ''; }
        depth++;
      } else if (c === 125 || c === 93) { // } ]
        depth--;
        if (depth === 0 && part !== null) { onObject(part + chunk.slice(from, i + 1)); part = null; from = -1; }
        if (depth < 0) { started = false; return; } // end of stop_groups
      }
    }
    if (part !== null) part += chunk.slice(from);
  };
}

/** Compact row: [id, name, lat, lon, modes, daily] */
function toRow(g) {
  const s = (g.stops || []).find((x) => Number.isFinite(x.lat)) || null;
  if (!s) return null;
  return [String(g.id), g.name, +s.lat.toFixed(6), +s.lon.toFixed(6), (g.transport_modes || []).join(','), Math.round(g.average_daily_stop_times || 0)];
}

/** Column store of rows [id, name, lat, lon, modes, daily]. */
class Table {
  constructor(n) {
    this.n = 0;
    this.ids = new Float64Array(n); this.lat = new Float64Array(n); this.lon = new Float64Array(n);
    this.daily = new Uint32Array(n); this.mode = new Uint16Array(n);
    this.modes = []; this.names = []; this.text = null; this.offsets = null; this.textIds = null;
  }

  push(r) {
    if (this.n === this.ids.length) this.grow();
    const i = this.n++;
    const id = Number(r[0]);
    this.ids[i] = Number.isSafeInteger(id) && String(id) === r[0] ? id : NaN;
    if (Number.isNaN(this.ids[i])) (this.textIds = this.textIds || new Map()).set(i, r[0]);
    this.names.push(r[1]); this.lat[i] = r[2]; this.lon[i] = r[3]; this.daily[i] = r[5];
    let m = this.modes.indexOf(r[4]);
    if (m < 0) m = this.modes.push(r[4]) - 1;
    this.mode[i] = m;
  }

  grow() {
    const n = Math.max(1024, this.ids.length * 2);
    for (const k of ['ids', 'lat', 'lon', 'daily', 'mode']) { const a = new this[k].constructor(n); a.set(this[k]); this[k] = a; }
  }

  /** Done adding: names become one string with offsets. */
  finish() {
    const offsets = new Uint32Array(this.n + 1);
    let at = 0;
    this.names.forEach((nm, i) => { offsets[i] = at; at += nm.length + 1; });
    offsets[this.n] = at;
    this.text = this.names.join('\n'); this.offsets = offsets; this.names = null;
    for (const k of ['ids', 'lat', 'lon', 'daily', 'mode']) this[k] = this[k].slice(0, this.n);
    return this;
  }

  get length() { return this.n; }

  name(i) { return this.text.slice(this.offsets[i], this.offsets[i + 1] - 1); }

  id(i) { return Number.isNaN(this.ids[i]) ? this.textIds.get(i) : String(this.ids[i]); }

  row(i) { return [this.id(i), this.name(i), this.lat[i], this.lon[i], this.modes[this.mode[i]], this.daily[i]]; }

  /** For the saved file: columns, so reading it back doesn't build 56k small arrays. */
  toJSON() {
    const ids = [];
    for (let i = 0; i < this.n; i++) ids.push(Number.isNaN(this.ids[i]) ? this.textIds.get(i) : this.ids[i]);
    return { ids, text: this.text, lat: [...this.lat], lon: [...this.lon], daily: [...this.daily], mode: [...this.mode], modes: this.modes };
  }

  static fromJSON(j) {
    const t = new Table(0);
    t.n = j.ids.length;
    t.ids = Float64Array.from(j.ids, (x) => (typeof x === 'number' ? x : NaN));
    j.ids.forEach((x, i) => { if (typeof x !== 'number') (t.textIds = t.textIds || new Map()).set(i, x); });
    t.lat = Float64Array.from(j.lat); t.lon = Float64Array.from(j.lon);
    t.daily = Uint32Array.from(j.daily); t.mode = Uint16Array.from(j.mode); t.modes = j.modes;
    t.text = j.text; t.names = null;
    t.offsets = new Uint32Array(t.n + 1);
    for (let i = 0, at = 0; i < t.n; i++) { t.offsets[i] = at; at = t.text.indexOf('\n', at) + 1 || t.text.length + 1; }
    t.offsets[t.n] = t.text.length + 1;
    if (t.lat.length !== t.n || t.offsets[t.n - 1] > t.text.length) throw new Error('bad stop file');
    return t;
  }
}

async function download(key) {
  if (!key) throw new Error('No Trafiklab API key - add it in the app settings');
  await tl.slot();
  const res = await http.request(`${tl.BASE}/stops/list?key=${encodeURIComponent(key)}`, { timeout: 120000 });
  tl.note('/stops/list', res.status);
  if (res.status === 401 || res.status === 403) throw new Error('Trafiklab rejected the API key (check it in the app settings)');
  if (!res.ok) throw new Error(`Trafiklab HTTP ${res.status}`);
  const rows = new Table(60000);
  const feed = groupSplitter((txt) => {
    try { const r = toRow(JSON.parse(txt)); if (r) rows.push(r); } catch (e) { /* skip a bad entry */ }
  });
  const dec = new TextDecoder();
  for await (const part of res.stream) feed(dec.decode(part, { stream: true }));
  feed(dec.decode());
  if (rows.length < 1000) throw new Error('Could not read the stop list from Trafiklab');
  return rows.finish();
}

class StopIndex {
  constructor({ key, file, log = () => {} }) {
    this.key = key; this.file = file; this.log = log;
    this.rows = null; this.loading = null; this.dropTimer = null;
  }

  async load() {
    this.touch();
    if (this.rows) return this.rows;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const saved = JSON.parse(await fs.promises.readFile(this.file, 'utf8'));
        if (saved.format === FORMAT && Date.now() - saved.at < MAX_AGE && saved.rows.ids.length > 1000) return Table.fromJSON(saved.rows);
      } catch (e) { /* no or old file */ }
      const t0 = Date.now();
      const rows = await download(this.key());
      this.log(`stop list: ${rows.length} stop areas in ${Date.now() - t0} ms`);
      await fs.promises.writeFile(this.file, JSON.stringify({ format: FORMAT, at: Date.now(), rows })).catch((e) => this.log('could not save stop list:', e.message));
      return rows;
    })();
    try { this.rows = await this.loading; } finally { this.loading = null; }
    return this.rows;
  }

  // free the memory 15 min after the last use (setup is done by then)
  touch() {
    if (this.dropTimer) clearTimeout(this.dropTimer);
    this.dropTimer = setTimeout(() => { this.rows = null; }, 15 * 60000);
    if (this.dropTimer.unref) this.dropTimer.unref();
  }

  /** Stop areas within `meters` of a point, nearest first: [{ id, name, lat, lon, modes, daily, m }] */
  async nearby(lat, lon, meters = 800, limit = 15) {
    const rows = await this.load();
    const k = Math.cos((lat * Math.PI) / 180) * 111320;
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const dy = (rows.lat[i] - lat) * 110570; const dx = (rows.lon[i] - lon) * k;
      if (Math.abs(dy) > meters || Math.abs(dx) > meters) continue;
      const m = Math.hypot(dx, dy);
      if (m <= meters) out.push({ ...asObject(rows.row(i)), m: Math.round(m) });
    }
    return out.sort((a, b) => a.m - b.m).slice(0, limit);
  }

  /** All rows passing `fn(row)` as objects (for transfer-hub candidates). */
  async filter(fn) {
    const rows = await this.load();
    const out = [];
    for (let i = 0; i < rows.length; i++) { const r = rows.row(i); if (fn(r)) out.push(asObject(r)); }
    return out;
  }
}

const asObject = (r) => ({ id: r[0], name: r[1], lat: r[2], lon: r[3], modes: r[4] ? r[4].split(',') : [], daily: r[5] });

/** Walking minutes for a straight-line distance (streets are ~25% longer, 80 m/min). */
const walkMinutes = (m) => Math.max(1, Math.ceil((m * 1.25) / 80));

module.exports = { StopIndex, Table, groupSplitter, toRow, walkMinutes };
