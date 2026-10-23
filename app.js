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
const { Usage, tvKindOf, TV_KINDS } = require('./lib/usage');
const L = require('./lib/leave');
const ferries = require('./lib/ferries');

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
    this.homey.dashboards.getWidget('leave').registerSettingAutocompleteListener('source', async (query) => this.leaveSources(query));
    this.homey.dashboards.getWidget('ferry').registerSettingAutocompleteListener('route', async (query) => {
      const q = String(query || '').toLowerCase();
      const home = this.home();
      const list = await ferries.routes(this.homey.settings.get('trafikverket_key'));
      return list.filter((r) => `${r.name} ${r.short || ''} ${r.harbors.map((h) => h.name).join(' ')}`.toLowerCase().includes(q))
        .map((r) => ({ r, km: home && r.point ? tv.distanceKm(home, r.point) : null }))
        .sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9)).slice(0, 25)
        .map(({ r, km }) => ({ name: r.name, id: String(r.id), description: `${r.harbors.map((h) => h.name).join(' ⇄ ')}${km != null ? ` · ${Math.round(km)} km` : ''}` }));
    });
    for (const n of [1, 2, 3, 4]) {
      this.homey.dashboards.getWidget('cameras').registerSettingAutocompleteListener(`camera${n}`, async (query) => {
        if (!String(query || '').trim()) return [];
        const list = await tv.searchCameras(this.homey.settings.get('trafikverket_key'), query, this.home(), 10);
        return list.map((c) => ({ name: c.name, id: c.name, description: c.km != null ? `${c.km} km` : '' }));
      });
    }
    this.homey.dashboards.getWidget('commute').registerSettingAutocompleteListener('commute', async (query) => {
      const q = String(query || '').toLowerCase();
      return this.commuteConfigs().filter((c) => c.name.toLowerCase().includes(q)).map((c) => ({ name: c.name, id: c.id }));
    });
    this.initCommuteFlows();
    this.initMoreFlows();
    this.fired = new Map(); // "<card>:<commute>:<trip or day>" -> time, so each alert fires once
    this.watchTimer = this.homey.setInterval(() => this.watchCommutes().catch((e) => this.error('commute watch:', e.message)), 60 * 1000);
    this.initUsage();
    // warm the commute caches shortly after start (one at a time), so the first widget load doesn't wait
    this.homey.setTimeout(async () => {
      let list = [];
      try { list = this.commuteConfigs(); } catch (e) { return; }
      for (const c of list) await this.commutes.get(c).catch(() => {});
    }, 20000);
    this.log('Trafikkollen started');
  }

  /** Count Trafiklab requests (settings page shows them); warn once at 80 % and 100 % of the monthly allowance. */
  initUsage() {
    const S = this.homey.settings;
    this.usage = new Usage({ load: () => S.get('trafiklab_usage'), save: (v) => S.set('trafiklab_usage', v), tz: () => this.tz });
    // a different key has its own allowance: start counting again
    const tail = () => String(S.get('trafiklab_key') || '').slice(-6);
    if (this.usage.data.key === undefined) this.usage.data.key = tail();
    S.on('set', (k) => {
      if (k !== 'trafiklab_key' || tail() === this.usage.data.key) return;
      this.usage.data = { key: tail() };
      this.usage.dirty = true;
    });
    tl.onRequest((path, o) => this.usage.count(path, o));
    // Trafikverket has no fixed quota, but count it the same way so people can see what the app does
    this.tvUsage = new Usage({
      load: () => S.get('trafikverket_usage'), save: (v) => S.set('trafikverket_usage', v), tz: () => this.tz, kindOf: tvKindOf, kinds: TV_KINDS,
    });
    tv.onRequest((type) => this.tvUsage.count(type));
    this.usageTimer = this.homey.setInterval(() => this.checkUsage().catch((e) => this.error('usage:', e.message)), 2 * 60 * 1000);
  }

  get allowance() {
    return { monthly: Number(this.homey.settings.get('trafiklab_monthly')) || 100000, perMinute: 25 };
  }

  async checkUsage() {
    // "Trafiklab usage reaches N %": fire for every percentage passed since the last check
    const monthly = this.allowance.monthly;
    const pct = monthly ? (this.usage.data.total || 0) / monthly * 100 : 0;
    const prev = this.usage.data.lastPct;
    if (prev !== undefined && pct > prev) {
      await this.usageCard.trigger({ percent: Math.round(pct * 10) / 10, total: this.usage.data.total, monthly }, { from: prev, to: pct })
        .catch((e) => this.error('usage trigger:', e.message));
    }
    if (prev !== pct) { this.usage.data.lastPct = pct; this.usage.dirty = true; }
    const step = this.usage.threshold(this.allowance.monthly);
    this.usage.flush();
    this.tvUsage.flush();
    if (!step) return;
    const s = this.usageSummary();
    await this.homey.notifications.createNotification({
      excerpt: this.t(step >= 100 ? 'usage.warnFull' : 'usage.warn80', { total: s.total, monthly: s.monthly }),
    });
  }

  /** Trafiklab usage (top level, as before) plus Trafikverket's under `trafikverket` (no fixed limit, so no monthly/percent). */
  usageSummary() {
    const t = this.tvUsage.summary({ monthly: null, perMinute: null });
    return {
      ...this.usage.summary(this.allowance),
      trafikverket: {
        month: t.month, total: t.total, today: t.today, lastMinute: t.lastMinute, projected: t.projected, kinds: t.kinds, previous: t.previous,
      },
    };
  }

  async onUninit() {
    if (this.usage) this.usage.flush();
    if (this.tvUsage) this.tvUsage.flush();
  }

  /** Wait at most `ms` for a slow first fetch; the widget then shows "loading" and asks again soon (the fetch carries on). */
  async quick(promise, ms = 8000) {
    let timer;
    const late = new Promise((ok) => { timer = this.homey.setTimeout(() => ok({ loading: true }), ms); });
    promise.catch(() => {}); // a late failure is kept in the cache, not thrown here
    try { return await Promise.race([promise, late]); } finally { this.homey.clearTimeout(timer); }
  }

  /** Commutes and departure boards for the "time to leave" widget's source picker. */
  leaveSources(query) {
    const q = String(query || '').toLowerCase();
    const boards = [...this.homey.drivers.getDriver('departures').getDevices(), ...this.homey.drivers.getDriver('ferry').getDevices()]
      .map((d) => ({ name: d.getName(), id: `b:${boardKey(d)}`, description: this.homey.__('leave.kindBoard') }));
    let commutes = [];
    try {
      commutes = this.commuteConfigs().filter((c) => c.mode !== 'car')
        .map((c) => ({ name: c.name, id: `c:${c.id}`, description: this.homey.__('leave.kindCommute') }));
    } catch (e) { /* invalid commute settings: offer boards only */ }
    return [...commutes, ...boards].filter((x) => x.name.toLowerCase().includes(q));
  }

  /**
   * "Time to leave" widget: a cautious countdown (see lib/leave.js) for a commute ("c:<id>") or a board ("b:<key>").
   * Data is refreshed when a trip is close (every ~2.5 min within 30 min of leaving), otherwise the normal caches apply.
   */
  async leave(source, margin) {
    const now = Date.now();
    const m = Math.max(0, Math.min(15, Number.isFinite(+margin) ? +margin : 2));
    const src = String(source || '');
    const soon = (trips, walk) => trips.some((t) => !t.canceled && t.dep && t.dep.scheduled - walk * 60000 - now < 30 * 60000);
    if (src.startsWith('b:') || !src) {
      const devices = [...this.homey.drivers.getDriver('departures').getDevices(), ...this.homey.drivers.getDriver('ferry').getDevices()];
      const dev = devices.find((d) => `b:${boardKey(d)}` === src) || (src ? null : devices[0]);
      if (!dev) throw new Error(this.homey.__(devices.length ? 'errors.boardRemoved' : 'errors.noBoard'));
      const b = dev.board(20);
      const toTrip = (d) => ({ dep: { scheduled: d.scheduled, expected: d.expected, realtime: d.realtime, delayMin: d.delayMin }, canceled: d.canceled, line: d.line, mode: d.mode, direction: d.direction, platform: d.platform });
      if ((!b.updated || now - b.updated > 150000) && soon(b.departures.map(toTrip), b.walk) && now - (dev.leaveRefresh || 0) > 120000) {
        dev.leaveRefresh = now; // background: the widget asks again within 30 s
        dev.refresh().catch((e) => this.error('leave refresh:', e.message));
      }
      const t1 = Date.now(); // after any refresh, so the data's age is measured correctly
      return { name: b.name, kind: 'board', walk: b.walk, margin: m, now: t1, updated: b.updated, ...L.plan({ trips: b.departures.map(toTrip), now: t1, walk: b.walk, margin: m, updated: b.updated }) };
    }
    const id = src.replace(/^c:/, '');
    const cfg = this.commuteConfigs().find((c) => c.id === id);
    if (!cfg) throw new Error(this.homey.__('errors.commuteRemoved'));
    if (cfg.mode === 'car') throw new Error(this.homey.__('leave.carOnly'));
    const toTrips = (journeys) => (journeys || []).map((j) => ({
      dep: j.legs[0].dep, canceled: j.canceled, line: j.legs.map((l) => l.line).join(' + '), mode: j.legs[0].mode,
      direction: j.legs[0].direction, platform: j.legs[0].platform, arrive: j.arrive, from: j.legs[0].from,
    }));
    // answer at once with what we have; when a trip is close and the data is getting old, fetch in the background
    // (the widget asks again within 30 s; the countdown shows the data's age and stops if it gets too old)
    const data = await this.quick(this.commutes.get(cfg, { swr: true }));
    if (data.loading) return { name: cfg.name, kind: 'commute', loading: true, now: Date.now() };
    const t = data.transit;
    if (t && !t.error && (now - t.updated > 15 * 60000 || (now - t.updated > 150000 && soon(toTrips(t.journeys), cfg.walk_to_stop)))) {
      this.commutes.kickTransit(cfg);
    }
    const tr = data.transit;
    if (tr && tr.error && !(data.next && data.next.journeys && data.next.journeys.length)) throw new Error(this.friendly(tr.error));
    const trips = tr && !tr.error && tr.journeys.length ? toTrips(tr.journeys) : toTrips(data.next && !data.next.error ? data.next.journeys : []);
    const updated = tr && !tr.error && tr.journeys.length ? tr.updated : (data.next && data.next.updated) || (tr && tr.updated);
    const t1 = Date.now(); // after any refresh, so the data's age is measured correctly
    return {
      name: cfg.name, kind: 'commute', walk: cfg.walk_to_stop, margin: m, now: t1, updated, from: tr && tr.origin,
      ...L.plan({ trips, now: t1, walk: cfg.walk_to_stop, margin: m, updated }),
    };
  }

  /** Ferry widget: a whole road-ferry route, both directions, plus disruption messages. Cached 2 min per route. */
  async ferryRoute(routeId, rows = 3) {
    const key = this.homey.settings.get('trafikverket_key');
    if (!key) throw new Error(this.homey.__('ferry.noKey'));
    const route = (await ferries.routes(key)).find((r) => String(r.id) === String(routeId));
    if (!route) throw new Error(this.homey.__(routeId ? 'ferry.gone' : 'ferryWidget.pick'));
    this.ferryCache = this.ferryCache || new Map();
    const hit = this.ferryCache.get(route.id);
    let base = hit ? hit.value : null;
    const fetchRoute = async () => {
      const sides = route.harbors.slice(0, 2);
      const [deps, messages] = await Promise.all([
        Promise.all(sides.map((h) => ferries.departures(key, route.id, h.id).catch((e) => ({ error: this.friendly(e) })))),
        ferries.disruptions(key, route).catch(() => []),
      ]);
      const value = {
        name: route.name,
        directions: sides.map((h, i) => ({
          from: h.name, to: (sides[1 - i] || {}).name || '',
          error: deps[i].error || null,
          departures: deps[i].error ? [] : deps[i].map((d) => ({ time: d.time, to: d.to, info: d.info })),
        })),
        messages: messages.map((m) => ({ text: m.text, severity: m.severity })),
        updated: Date.now(),
      };
      this.ferryCache.set(route.id, { at: Date.now(), value });
      return value;
    };
    if (!hit) base = await fetchRoute();
    else if (Date.now() - hit.at >= 2 * 60000 && !hit.busy) { // old: answer now, fetch again in the background
      hit.busy = true;
      fetchRoute().catch(() => {}).finally(() => { hit.busy = false; });
    }
    const now = Date.now();
    const n = Math.max(1, Math.min(6, Number(rows) || 3));
    return {
      ...base, now,
      directions: base.directions.map((d) => ({ ...d, departures: d.departures.filter((x) => x.time > now - 60000).slice(0, n) })),
    };
  }

  /** Camera wall widget: camera names typed/picked in the widget settings -> pictures, plus messages near each camera. */
  async cameraWall(names, withIncidents = true) {
    const key = this.homey.settings.get('trafikverket_key');
    const home = this.home();
    this.wallCache = this.wallCache || new Map(); // "name" -> { at, value }
    const one = async (name) => {
      const hit = this.wallCache.get(name);
      if (hit && Date.now() - hit.at < 5 * 60000) return hit.value;
      if (hit && hit.value && !hit.busy) { // old: answer now, fetch again in the background
        hit.busy = true;
        fetchOne(name).catch(() => {}).finally(() => { hit.busy = false; });
        return hit.value;
      }
      if (hit && hit.value) return hit.value;
      return fetchOne(name);
    };
    const fetchOne = async (name) => {
      const cam = (await tv.searchCameras(key, name, home, 1))[0];
      if (!cam) return { name, missing: true };
      let incident = null;
      if (withIncidents && cam.point) {
        // only what is news: accidents, big disruptions, or anything reported in the last 18 hours
        // (long-running roadworks would otherwise frame the same camera for months)
        const fresh = (i) => { const t = Date.parse(i.reported || i.start || ''); return Number.isFinite(t) && Date.now() - t < 18 * 3600000; };
        const near = (await tv.incidents(key, cam.point.lon, cam.point.lat, 1.5).catch(() => []))
          .filter((i) => /olycka/i.test(i.type || '') || (i.severity || 0) >= 4 || fresh(i))
          .sort((a, b) => (/olycka/i.test(b.type) - /olycka/i.test(a.type)) || (b.severity || 0) - (a.severity || 0));
        if (near[0]) incident = { type: near[0].type, road: near[0].road, message: near[0].message, severity: near[0].severity || 0, accident: /olycka/i.test(near[0].type || '') };
      }
      const value = { name: cam.name, url: cam.photoUrl, incident };
      this.wallCache.set(name, { at: Date.now(), value });
      return value;
    };
    const list = [].concat(names || []).map((n) => String(n || '').trim()).filter(Boolean).slice(0, 4);
    return { now: Date.now(), cameras: await Promise.all(list.map((n) => one(n).catch((e) => ({ name: n, error: this.friendly(e) })))) };
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

  /** Flow cards added in 1.2: departures, cameras, pausing, commute day, problems, car vs public transport, usage. */
  initMoreFlows() {
    const F = this.homey.flow;
    const list = async (query) => {
      const q = String(query || '').toLowerCase();
      let all = [];
      try { all = this.commuteConfigs(); } catch (e) { /* invalid commute settings */ }
      return all.filter((c) => c.name.toLowerCase().includes(q)).map((c) => ({ name: c.name, id: c.id }));
    };
    const cfgOf = (arg) => {
      const cfg = this.commuteConfigs().find((c) => c.id === (arg && arg.id));
      if (!cfg) throw new Error(this.homey.__('flow.noCommute'));
      return cfg;
    };
    const same = async (args, state) => args.commute && args.commute.id === state.id;

    // departure boards and ferries
    F.getActionCard('next_departure').registerRunListener(async ({ device }) => device.nextDeparture());
    F.getConditionCard('next_within').registerRunListener(async ({ device, minutes }) => {
      const m = device.nextMinutes();
      return m !== null && m <= (Number(minutes) || 0);
    });
    F.getDeviceTriggerCard('departure_in').registerRunListener(async (args, state) => Number(args.minutes) === state.minutes);

    // roads and cameras
    F.getActionCard('road_status').registerRunListener(async ({ device }) => device.roadStatus());
    F.getActionCard('camera_picture')
      .registerArgumentAutocompleteListener('camera', async (query) => {
        if (!String(query || '').trim()) return [];
        const found = await tv.searchCameras(this.homey.settings.get('trafikverket_key'), query, this.home(), 10);
        return found.map((c) => ({ name: c.name, id: c.name, description: c.km != null ? `${c.km} km` : '' }));
      })
      .registerRunListener(async ({ camera }) => this.cameraPicture(camera && (camera.id || camera.name)));

    // pausing alerts
    const withAll = async (query) => [{ name: this.homey.__('flow.allCommutes'), id: '*' }, ...(await list(query))];
    F.getActionCard('pause_alerts').registerArgumentAutocompleteListener('commute', withAll)
      .registerRunListener(async ({ commute, period }) => this.pauseAlerts(commute && commute.id, Number(period) || 0));
    F.getActionCard('resume_alerts').registerArgumentAutocompleteListener('commute', withAll)
      .registerRunListener(async ({ commute }) => this.pauseAlerts(commute && commute.id, -1));

    // commute conditions
    F.getConditionCard('commute_day').registerRunListener(async ({ when }) => {
      const day = D.localIso(Date.now() + (when === 'tomorrow' ? 86400000 : 0), this.tz).slice(0, 10);
      return D.isCommuteDay(day, this.tz);
    });
    F.getConditionCard('commute_has_problem').registerArgumentAutocompleteListener('commute', list)
      .registerRunListener(async ({ commute }) => {
        const cfg = cfgOf(commute);
        const data = await this.commutes.get(cfg, { swr: true });
        return A.findIssues(data, cfg, { lang: this.lang, tz: this.tz }).length > 0;
      });
    F.getConditionCard('car_faster').registerArgumentAutocompleteListener('commute', list)
      .registerRunListener(async ({ commute }) => {
        const cfg = cfgOf(commute);
        const data = await this.commutes.get(cfg, { swr: true });
        const now = Date.now();
        const d = data.drive;
        if (!d || d.error || !d.minutes) return false;
        const carAt = now + d.minutes * 60000;
        const t = data.transit;
        const best = t && !t.error ? t.journeys.find((j) => !j.canceled && j.leave >= now) : null;
        return !best || carAt < best.arrive;
      });

    // commute triggers fired by watchCommutes()
    this.lateCard = F.getTriggerCard('commute_will_be_late');
    this.lateCard.registerArgumentAutocompleteListener('commute', list).registerRunListener(same);
    this.clearedCard = F.getTriggerCard('commute_problem_cleared');
    this.clearedCard.registerArgumentAutocompleteListener('commute', list).registerRunListener(same);

    // Trafiklab usage
    this.usageCard = F.getTriggerCard('usage_reached');
    this.usageCard.registerRunListener(async (args, state) => Number(args.percent) > state.from && Number(args.percent) <= state.to);
  }

  /** A still from a traffic camera as a Flow image (the last few are kept for Flows that use them a bit later). */
  async cameraPicture(name) {
    const key = this.homey.settings.get('trafikverket_key');
    const cam = (await tv.searchCameras(key, name, this.home(), 1))[0];
    if (!cam) throw new Error(this.t('camera.notFound', { name }));
    const url = cam.photoUrl + (cam.photoUrl.includes('?') ? '&' : '?') + 'type=fullsize';
    tv.note('image');
    const res = await require('./lib/http').request(url, { timeout: 20000 });
    if (!res.ok) { res.stream.resume(); throw new Error(`Camera HTTP ${res.status}`); }
    const chunks = [];
    for await (const c of res.stream) chunks.push(c);
    const jpeg = Buffer.concat(chunks);
    const image = await this.homey.images.createImage();
    image.setStream(async (stream) => { stream.end(jpeg); });
    this.pictures = (this.pictures || []).concat(image);
    while (this.pictures.length > 5) await this.pictures.shift().unregister().catch(() => {});
    return { image, camera: cam.name };
  }

  /** Pause a commute's alerts ('*' = all) until the end of today + `days` (-1 = resume now). */
  pauseAlerts(id, days) {
    if (!id) throw new Error(this.homey.__('flow.noCommute'));
    const paused = { ...(this.homey.settings.get('paused') || {}) };
    if (days < 0) delete paused[id];
    else {
      const day = D.localIso(Date.now() + days * 86400000, this.tz).slice(0, 10);
      paused[id] = D.localToEpoch(`${day}T23:59`, this.tz) + 60000;
    }
    for (const [k, until] of Object.entries(paused)) if (until < Date.now()) delete paused[k];
    this.homey.settings.set('paused', paused);
    this.log(days < 0 ? 'alerts resumed' : 'alerts paused', id, days < 0 ? '' : new Date(paused[id]).toISOString());
  }

  isPaused(cfg) {
    const paused = this.homey.settings.get('paused') || {};
    const now = Date.now();
    return (paused['*'] || 0) > now || (paused[cfg.id] || 0) > now;
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
      if (this.isPaused(cfg)) continue; // "Pause commute alerts" 
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
        // "I will be late": no trip gets there by the arrive-by time any more (once a day)
        if (t.late && !t.car && !this.fired.has(`late:${cfg.id}:${today}`)) {
          this.fired.set(`late:${cfg.id}:${today}`, now);
          const minutesLate = Math.max(1, Math.round((t.arrive - data.plan.arriveBy) / 60000));
          const text = this.t('flow.lateText', { name: cfg.name, n: minutesLate, arrive: D.hhmm(t.arrive, tz), by: D.hhmm(data.plan.arriveBy, tz) });
          this.log('commute late', text);
          await this.lateCard.trigger({ text, arrive: D.hhmm(t.arrive, tz), arrive_by: D.hhmm(data.plan.arriveBy, tz), minutes_late: minutesLate }, { id: cfg.id });
        }
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
    const all = A.findIssues(data, cfg, { lang: this.lang, tz: this.tz });
    // "problem resolved": after a warning today, two checks in a row (two minutes) without any problem
    this.problemState = this.problemState || {};
    const st = this.problemState[cfg.id] = this.problemState[cfg.id] || { day: null, empty: 0 };
    if (all.length) st.empty = 0;
    else if (st.day === today && ++st.empty >= 2) {
      st.day = null;
      const text = this.t('flow.clearedText', { name: cfg.name });
      this.log('commute problem cleared', cfg.name);
      await this.clearedCard.trigger({ text }, { id: cfg.id });
    }
    const issues = all.filter((i) => {
      const key = `problem:${cfg.id}:${today}:${i.key}`;
      if (this.fired.has(key)) return false;
      this.fired.set(key, Date.now());
      return true;
    });
    if (!issues.length) return;
    st.day = today; st.empty = 0;
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
    const data = await this.quick(this.commutes.get(cfg, { swr: true }));
    if (data.loading) return { id: cfg.id, name: cfg.name, loading: true, now: Date.now() };
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
