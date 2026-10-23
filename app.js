'use strict';

const Homey = require('homey');
const tl = require('./lib/trafiklab');
const tv = require('./lib/trafikverket');
const { Commutes, parseConfigs } = require('./lib/commute');
const { StopIndex, walkMinutes } = require('./lib/stopindex');
const geo = require('./lib/geo');
const D = require('./lib/departures');
const P = require('./lib/plan');
const A = require('./lib/alerts');

/** Widget setting value for a board device: the stop id, plus the device's uid when the stop can be added more than once. */
const boardKey = (d) => (d.getData().uid ? `${d.getData().id}#${d.getData().uid}` : d.getData().id);

class TrafikApp extends Homey.App {

  async onInit() {
    this.homey.flow.getActionCard('refresh').registerRunListener(async ({ device }) => device.refresh());
    // new/changed keys: refresh every device right away so "unavailable" clears without waiting
    this.homey.settings.on('set', (k) => {
      if (!/_key$/.test(k)) return;
      for (const driver of Object.values(this.homey.drivers.getDrivers())) {
        for (const d of driver.getDevices()) d.refresh().catch((e) => this.error(e.message));
      }
    });
    this.homey.dashboards.getWidget('board').registerSettingAutocompleteListener('device', async (query) => {
      const q = String(query || '').toLowerCase();
      return [...this.homey.drivers.getDriver('departures').getDevices(), ...this.homey.drivers.getDriver('ferry').getDevices()]
        .filter((d) => d.getName().toLowerCase().includes(q))
        .map((d) => ({ name: d.getName(), id: boardKey(d) }));
    });
    this.commutes = new Commutes({
      keys: () => ({ trafiklab: this.homey.settings.get('trafiklab_key'), trafikverket: this.homey.settings.get('trafikverket_key') }),
      tz: () => this.homey.clock.getTimezone() || 'Europe/Stockholm',
      log: (...a) => this.log(...a),
    });
    this.homey.settings.on('set', (k) => { if (k === 'commutes' || /_key$/.test(k)) this.commutes.clear(); });
    this.stopIndex = new StopIndex({
      key: () => this.homey.settings.get('trafiklab_key'), file: '/userdata/stops.json', log: (...a) => this.log(...a),
    });
    this.homey.dashboards.getWidget('commute').registerSettingAutocompleteListener('commute', async (query) => {
      const q = String(query || '').toLowerCase();
      return this.commuteConfigs().filter((c) => c.name.toLowerCase().includes(q)).map((c) => ({ name: c.name, id: c.id }));
    });
    this.initCommuteFlows();
    this.fired = new Map(); // "<card>:<commute>:<trip or day>" -> time, so each alert fires once
    this.watchTimer = this.homey.setInterval(() => this.watchCommutes().catch((e) => this.error('commute watch:', e.message)), 60 * 1000);
    this.log('Trafikkollen started');
  }

  /** Widget data for the departure board with Trafiklab id `id` (falls back to the first board). */
  board(id, limit) {
    const devices = [...this.homey.drivers.getDriver('departures').getDevices(), ...this.homey.drivers.getDriver('ferry').getDevices()];
    const dev = devices.find((d) => boardKey(d) === id) || devices.find((d) => d.getData().id === id) || (id ? null : devices[0]);
    if (!dev) throw new Error(this.homey.__(devices.length ? 'errors.boardRemoved' : 'errors.noBoard'));
    return dev.board(limit);
  }

  get tz() { return this.homey.clock.getTimezone() || 'Europe/Stockholm'; }

  /** An error as a translated, actionable text for widgets, devices and the settings page. */
  friendly(e) {
    const msg = String((e && e.message) || e || '');
    const known = [
      [/^No Trafiklab API key/, 'noTrafiklabKey'], [/^No Trafikverket API key/, 'noTrafikverketKey'],
      [/^Trafiklab rejected/, 'badTrafiklabKey'], [/^Trafikverket rejected/, 'badTrafikverketKey'],
      [/^Trafiklab quota/, 'quota'],
    ].find(([re]) => re.test(msg));
    return known ? this.homey.__(`errors.${known[1]}`) : msg;
  }

  /** Translation with {{placeholders}} filled here (Homey doesn't do it everywhere). */
  t(key, vars = {}) {
    return String(this.homey.__(key)).replace(/{{\s*(\w+)\s*}}/g, (_, n) => (vars[n] != null ? vars[n] : ''));
  }

  get lang() { return this.homey.i18n.getLanguage() === 'sv' ? 'sv' : 'en'; }

  initCommuteFlows() {
    const list = async (query) => {
      const q = String(query || '').toLowerCase();
      let all = [];
      try { all = this.commuteConfigs(); } catch (e) { /* invalid config: nothing to pick */ }
      return all.filter((c) => c.name.toLowerCase().includes(q)).map((c) => ({ name: c.name, id: c.id }));
    };
    const cfgOf = (arg) => {
      const cfg = this.commuteConfigs().find((c) => c.id === (arg && arg.id));
      if (!cfg) throw new Error(this.homey.__('flow.noCommute'));
      return cfg;
    };
    const same = async (args, state) => args.commute && args.commute.id === state.id;

    this.leaveCard = this.homey.flow.getTriggerCard('commute_leave');
    this.leaveCard.registerArgumentAutocompleteListener('commute', list).registerRunListener(same);
    this.problemCard = this.homey.flow.getTriggerCard('commute_problem');
    this.problemCard.registerArgumentAutocompleteListener('commute', list).registerRunListener(same);
    this.heaterCard = this.homey.flow.getTriggerCard('commute_heater');
    this.heaterCard.registerArgumentAutocompleteListener('commute', list).registerRunListener(same);

    this.homey.flow.getConditionCard('commute_frost').registerArgumentAutocompleteListener('commute', list)
      .registerRunListener(async ({ commute }) => (await this.commutes.get(cfgOf(commute))).plan.frost);
    this.homey.flow.getConditionCard('commute_late').registerArgumentAutocompleteListener('commute', list)
      .registerRunListener(async ({ commute }) => {
        const { plan } = await this.commutes.get(cfgOf(commute));
        return !!plan.target && !plan.target.late;
      });
    this.homey.flow.getActionCard('commute_briefing').registerArgumentAutocompleteListener('commute', list)
      .registerRunListener(async ({ commute }) => {
        const data = await this.commutes.get(cfgOf(commute));
        const { plan } = data;
        return {
          briefing: P.briefing(data, plan.target, { lang: this.lang, tz: this.tz, frost: plan.frost, weatherHour: plan.hour }),
          leave: plan.target ? D.hhmm(plan.target.leave, this.tz) : '',
          arrive: plan.target ? D.hhmm(plan.target.arrive, this.tz) : '',
          temperature: Number.isFinite(plan.temp) ? Math.round(plan.temp) : 0,
        };
      });
  }

  /** Once a minute: "time to leave" in commute hours, engine heater on commute days. */
  async watchCommutes() {
    let configs = [];
    try { configs = this.commuteConfigs(); } catch (e) { return; }
    const now = Date.now(); const tz = this.tz;
    const today = D.localIso(now, tz).slice(0, 10);
    for (const [k, t] of this.fired) if (now - t > 26 * 3600000) this.fired.delete(k);
    for (const cfg of configs) {
      if (!cfg.arrive_by && !cfg.alerts) continue;
      const commuteDay = D.isActive(now, tz, [], cfg.weekdays_only);
      if (!commuteDay) continue;
      const inHours = D.isActive(now, tz, D.parseWindows(cfg.active_hours), cfg.weekdays_only);
      try {
        // engine heater: needs only the weather (no Trafiklab calls), so it also works before commute hours
        if (cfg.arrive_by && cfg.drive && cfg.drive.minutes) {
          const h = await this.commutes.heaterPlan(cfg);
          const key = `heater:${cfg.id}:${today}`;
          if (h && h.heaterAt && now >= h.heaterAt && now < h.carLeave && !this.fired.has(key)) {
            this.fired.set(key, now);
            this.log('engine heater', cfg.name, h.temp, h.heaterMinutes);
            await this.heaterCard.trigger({ temperature: Math.round(h.temp), minutes: h.heaterMinutes, leave: D.hhmm(h.carLeave, tz) }, { id: cfg.id });
          }
        }
        if (!inHours) continue;
        const data = await this.commutes.get(cfg);
        if (cfg.alerts) await this.checkProblems(cfg, data, today);
        const t = data.plan.arriveBy ? data.plan.target : null; // only when planning for the arrive-by time
        if (!t) continue;
        const left = Math.floor((t.leave - now) / 60000);
        const remind = cfg.remind_before === undefined ? 5 : Number(cfg.remind_before);
        const key = `leave:${cfg.id}:${today}`; // once per commute day
        if (left <= remind && left >= -1 && !this.fired.has(key)) {
          this.fired.set(key, now);
          const legs = t.legs.map((l) => `${l.line} ${D.hhmm(l.dep.expected, tz)}`).join(' → ');
          const text = t.car
            ? this.t('flow.leaveCarText', { n: Math.max(0, left), arrive: D.hhmm(t.arrive, tz) })
            : this.t('flow.leaveText', { n: Math.max(0, left), legs, arrive: D.hhmm(t.arrive, tz) });
          await this.leaveCard.trigger({ text, leave: D.hhmm(t.leave, tz), arrive: D.hhmm(t.arrive, tz), minutes: Math.max(0, left), late: !!t.late }, { id: cfg.id });
        }
      } catch (e) { this.error(`commute ${cfg.name}:`, e.message); }
    }
  }

  /** In commute hours: send new problems (each once a day) to the phone and to the "problem" Flow card. */
  async checkProblems(cfg, data, today) {
    const issues = A.findIssues(data, cfg, { lang: this.lang, tz: this.tz }).filter((i) => {
      const key = `problem:${cfg.id}:${today}:${i.key}`;
      if (this.fired.has(key)) return false;
      this.fired.set(key, Date.now());
      return true;
    });
    if (!issues.length) return;
    const text = A.summary(cfg.name, issues);
    this.log('commute problem', text);
    if (cfg.alerts_push !== false) await this.homey.notifications.createNotification({ excerpt: `⚠️ ${text}` }).catch((e) => this.error('notification:', e.message));
    await this.problemCard.trigger({
      text,
      transit: issues.some((i) => i.kind === 'transit'),
      road: issues.some((i) => i.kind === 'road'),
      count: issues.length,
    }, { id: cfg.id });
  }

  /** Commute configs from the app settings ('commutes', JSON array). Throws with a readable message if invalid. */
  commuteConfigs() {
    return parseConfigs(this.homey.settings.get('commutes') || []);
  }

  /** Widget data for commute `id` (falls back to the first one). */
  async commute(id) {
    const list = this.commuteConfigs();
    const cfg = list.find((c) => c.id === id) || (id ? null : list[0]);
    if (!cfg) throw new Error(this.homey.__(list.length ? 'errors.commuteRemoved' : 'errors.noCommute'));
    const data = await this.commutes.get(cfg);
    const out = { ...data };
    for (const k of ['transit', 'drive', 'weather']) if (out[k] && out[k].error) out[k] = { ...out[k], error: this.friendly(out[k].error) };
    return out;
  }

  /** Settings page: stop search (needs the Trafiklab key). */
  async searchStops(q) {
    return tl.searchStops(this.homey.settings.get('trafiklab_key'), q);
  }

  /** The Homey's location, or null if unknown / not allowed. */
  home() {
    try {
      const lat = this.homey.geolocation.getLatitude(); const lon = this.homey.geolocation.getLongitude();
      return Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon) ? { lat, lon } : null;
    } catch (e) { return null; }
  }

  /** Settings page: the car route (from home if known, else from lat1/lon1) with cameras and speed sensors along it. */
  async roadOptions(q) {
    const from = (q.home === '1' && this.home()) || { lat: +q.lat1, lon: +q.lon1 };
    return { ...await this.commutes.roadOptions(from, { lat: +q.lat2, lon: +q.lon2 }), fromHome: q.home === '1' && !!this.home() };
  }

  /** Settings page: traffic cameras matching a typed name, nearest to lat/lon first. */
  async searchCameras(q) {
    const near = Number.isFinite(+q.lat) && q.lat !== undefined && q.lat !== '' ? { lat: +q.lat, lon: +q.lon } : null;
    return (await tv.searchCameras(this.homey.settings.get('trafikverket_key'), q.q, near, 10)).map((c) => ({ name: c.name, url: c.photoUrl, km: c.km }));
  }

  /** Settings page: places for an address or name. */
  async geocode(q, home) {
    if (home) {
      const at = this.home();
      if (!at) throw new Error('Your Homey has no location set (Homey settings > Location).');
      return [{ name: this.homey.__('settings.commutes.homeName'), lat: +at.lat.toFixed(6), lon: +at.lon.toFixed(6) }];
    }
    return geo.geocode(String(q || '').trim());
  }

  /** Settings page: stop areas within walking distance of a point (or of the Homey when home=1), with walking minutes. */
  async nearbyStops(q) {
    const at = q.home === '1' ? this.home() : { lat: +q.lat, lon: +q.lon };
    if (!at || !Number.isFinite(at.lat)) throw new Error(q.home === '1' ? 'Your Homey has no location set (Homey settings > Location).' : 'Missing location');
    const stops = await this.stopIndex.nearby(at.lat, at.lon, Math.min(2000, +q.meters || 900), 20);
    return stops.filter((s) => s.daily > 0).map((s) => ({ ...s, walk: walkMinutes(s.m) }));
  }

  /**
   * "Departures near me" widget: the next departures from the stops nearest the Homey, no setup needed.
   * The nearest stops are looked up once (and again only if the Homey moves); departures are cached 60 s.
   */
  async nearbyBoard({ stops = 3, rows = 3, hideTaxi = true } = {}) {
    const home = this.home();
    if (!home) throw new Error(this.t('nearby.noLocation'));
    let saved = this.homey.settings.get('nearby_stops');
    const moved = !saved || require('./lib/trafikverket').distanceKm(home, saved) > 0.1;
    if (moved) {
      const found = (await this.stopIndex.nearby(home.lat, home.lon, 1500, 25)).filter((x) => x.daily > 0 && x.modes.some((m) => m !== 'TAXI'));
      // one stop per name (östra/västra sides count as one), nearest first
      const seen = new Set();
      const list = found.filter((x) => { const k = x.name.replace(/\s+(östra|västra|norra|södra)$/i, ''); if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(0, 6).map((x) => ({ id: x.id, name: x.name, walk: walkMinutes(x.m), modes: x.modes }));
      saved = { lat: home.lat, lon: home.lon, stops: list };
      this.homey.settings.set('nearby_stops', saved);
    }
    this.nearbyCache = this.nearbyCache || new Map();
    const key = this.homey.settings.get('trafiklab_key');
    const want = Math.max(1, Math.min(4, stops));
    const fetchStop = async (st) => {
      let c = this.nearbyCache.get(st.id);
      if (!c || Date.now() - c.at > 60000) {
        try {
          const deps = D.normalise(await tl.board(key, 'departures', st.id), this.tz);
          await require('./lib/trains').enrich(this.homey.settings.get('trafikverket_key'), deps);
          c = { at: Date.now(), deps };
        } catch (e) {
          if (!c) return { ...st, error: this.friendly(e), departures: [], keys: [] };
          c = { ...c, stale: true };
        }
        this.nearbyCache.set(st.id, c);
      }
      const now = Date.now();
      const deps = c.deps.filter((d) => d.expected > now - 30000 && !(hideTaxi && d.mode === 'TAXI'));
      return {
        ...st,
        keys: deps.map((d) => d.key),
        updated: c.at,
        departures: deps.slice(0, Math.max(1, Math.min(8, rows))).map((d) => ({
          line: d.line, mode: d.mode, direction: d.direction, platform: d.platform, scheduled: d.scheduled, expected: d.expected,
          delayMin: d.delayMin, canceled: d.canceled, notes: d.notes || [],
        })),
      };
    };
    // nearest first; skip a stop whose departures are all already shown by a nearer one (e.g. "Uppsala" and
    // "Uppsala Centralstation" are separate stop areas with the same buses)
    const out = []; const shown = new Set();
    for (const st of saved.stops) {
      if (out.length >= want) break;
      const r = await fetchStop(st);
      if (r.keys.length && r.keys.every((k) => shown.has(k))) continue;
      r.keys.forEach((k) => shown.add(k));
      delete r.keys;
      out.push(r);
    }
    return { now: Date.now(), tz: this.tz, stops: out };
  }

  /** Settings page: suggested change stops for a draft commute. */
  async suggestTransfers(cfg) {
    return this.commutes.suggestTransfers(cfg, this.stopIndex);
  }

  /** Settings page: try an unsaved commute. */
  async previewCommute(cfg) {
    return this.commutes.preview(cfg);
  }

  /** Called from the settings page: checks both keys with one cheap request each. */
  async testKeys() {
    const out = { failed: false };
    const tlKey = this.homey.settings.get('trafiklab_key');
    const tvKey = this.homey.settings.get('trafikverket_key');
    const fail = (e) => { out.failed = true; return e.missing ? this.homey.__('keys.missing') : this.t('keys.failed', { msg: this.friendly(e) }); };
    const missing = () => Object.assign(new Error('missing'), { missing: true });
    try {
      if (!tlKey) throw missing();
      const r = await tl.searchStops(tlKey, 'Stockholm');
      out.trafiklab = this.t('keys.okTrafiklab', { n: r.length });
    } catch (e) { out.trafiklab = fail(e); }
    try {
      if (!tvKey) throw missing();
      const r = await tv.incidents(tvKey, 18.0686, 59.3293, 10); // central Stockholm always has something
      out.trafikverket = this.t('keys.okTrafikverket', { n: r.length });
    } catch (e) { out.trafikverket = fail(e); }
    return out;
  }
}

module.exports = TrafikApp;
