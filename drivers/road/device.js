'use strict';

const Homey = require('homey');
const http = require('../../lib/http');
const tv = require('../../lib/trafikverket');
const D = require('../../lib/departures');

const IDLE_POLL_MIN = 15;
const CAMERA_REFRESH_MIN = 5;
const SLIPPERY_WORDS = /halk|is- och snö|snö|ising|frost/i;

class RoadDevice extends Homey.Device {

  async onInit() {
    this.known = null;          // incident id -> incident (null until the first successful poll = seeding)
    this.lastFetch = 0;
    this.lastCamera = 0;
    this.camera = null;
    this.conditionsOk = true;
    await this.setupImage().catch((e) => this.error('camera image setup failed:', e.message));
    this.tick().catch((e) => this.error('first tick failed:', e.message));
    this.timer = this.homey.setInterval(() => this.tick().catch((e) => this.error('tick failed:', e.message)), 60 * 1000);
  }

  onDeleted() {
    if (this.timer) this.homey.clearInterval(this.timer);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('camera') && tv.cleanName(newSettings.camera)) {
      const key = this.homey.settings.get('trafikverket_key');
      const found = await tv.searchCameras(key, newSettings.camera, { lat: newSettings.lat, lon: newSettings.lon }, 5).catch(() => null);
      if (found && !found.length) {
        throw new Error(String(this.homey.__('road.noCamera')).replace(/{{\s*name\s*}}/g, String(newSettings.camera).trim()));
      }
    }
    this.lastFetch = 0;
    this.lastCamera = 0;
    this.camera = null;
    this.known = null; // re-seed: a changed area shouldn't flood triggers
    this.homey.setTimeout(() => this.tick().catch((e) => this.error(e.message)), 500);
  }

  get tz() { return this.homey.clock.getTimezone() || 'Europe/Stockholm'; }

  async refresh() {
    this.lastFetch = 0;
    this.lastCamera = 0;
    await this.tick();
  }

  async tick() {
    const s = this.getSettings();
    const now = Date.now();
    const active = D.isActive(now, this.tz, D.parseWindows(s.active_hours), s.weekdays_only);
    const pollMs = (active ? Math.max(2, s.poll_minutes || 5) : IDLE_POLL_MIN) * 60000;
    if (now - this.lastFetch >= pollMs - 5000) await this.poll(active);
    if (now - this.lastCamera >= CAMERA_REFRESH_MIN * 60000) await this.updateCamera();
  }

  wanted(i, s, roads) {
    if (!tv.onRoads(i, roads)) return false;
    const t = (i.type || '').toLowerCase();
    if (!s.include_roadworks && t.includes('vägarbete')) return false;
    if (!s.include_ferries && t.includes('färj')) return false;
    if (s.min_severity && i.severity && i.severity < s.min_severity) return false;
    return true;
  }

  async poll(active) {
    const s = this.getSettings();
    const key = this.homey.settings.get('trafikverket_key');
    const roads = tv.parseRoads(s.roads);
    this.lastFetch = Date.now();
    let list;
    try {
      list = (await tv.incidents(key, s.lon, s.lat, s.radius_km)).filter((i) => this.wanted(i, s, roads));
      if (!this.getAvailable()) await this.setAvailable();
    } catch (e) {
      this.error('incidents failed:', e.message);
      if (e.auth || /key/i.test(e.message)) await this.setUnavailable(this.homey.app.friendly(e)).catch(() => {});
      return;
    }

    const byId = new Map(list.map((i) => [i.id, i]));
    if (this.known) {
      for (const [id, i] of byId) {
        if (!this.known.has(id) && active) {
          await this.trigger('road_incident_new', {
            text: `${i.type}${i.road ? ` on ${i.road}` : ''}${i.location ? ` (${i.location})` : ''}: ${i.message}`.trim(),
            type: i.type, road: i.road, location: i.location, message: i.message, severity: i.severity || 0,
          });
        }
      }
      for (const [id, i] of this.known) {
        if (!byId.has(id) && active) {
          await this.trigger('road_incident_cleared', {
            text: `Cleared: ${i.type}${i.road ? ` on ${i.road}` : ''}`, type: i.type, road: i.road, location: i.location,
          });
        }
      }
    }
    this.known = byId;

    const sorted = [...list].sort((a, b) => (b.severity || 0) - (a.severity || 0) || String(b.start).localeCompare(String(a.start)));
    await this.set('road_incidents', list.length);
    await this.set('road_summary', sorted.length
      ? sorted.slice(0, 3).map((i) => `${i.type}${i.road ? ` ${i.road}` : ''}${i.location ? `, ${i.location}` : ''}`).join(' · ')
      : 'No incidents');

    // road conditions (slippery). Optional: if the object type isn't available, just leave it blank.
    try {
      const conds = (await tv.roadConditions(key, s.lon, s.lat, s.radius_km)).filter((c) => tv.onRoads(c, roads));
      const bad = conds.filter((c) => c.code >= 2 || c.warnings.some((w) => SLIPPERY_WORDS.test(w)) || SLIPPERY_WORDS.test(c.text));
      const worst = bad.sort((a, b) => b.code - a.code)[0];
      const text = worst ? `${worst.text || 'Difficult'}${worst.road ? ` (${worst.road})` : ''}${worst.warnings.length ? `: ${worst.warnings.join(', ')}` : ''}` : 'Normal';
      await this.set('road_condition', text);
      const was = this.getCapabilityValue('alarm_road_slippery');
      const now = !!worst;
      await this.set('alarm_road_slippery', now);
      if (was !== null && was !== now && active) {
        await this.trigger('road_slippery_changed', { slippery: now, text: now ? `Slippery roads: ${text}` : 'Roads back to normal' });
      }
      this.conditionsOk = true;
    } catch (e) {
      if (this.conditionsOk) this.error('road conditions unavailable:', e.message);
      this.conditionsOk = false;
      await this.set('road_condition', 'Unavailable');
    }
  }

  async setupImage() {
    this.image = await this.homey.images.createImage();
    this.image.setStream(async (stream) => {
      if (!this.camera) throw new Error('No camera');
      const url = this.camera.photoUrl + (this.camera.photoUrl.includes('?') ? '&' : '?') + 'type=fullsize';
      const res = await http.request(url, { timeout: 20000 });
      if (!res.ok) { res.stream.resume(); throw new Error(`Camera HTTP ${res.status}`); }
      res.stream.pipe(stream);
    });
    await this.setCameraImage('traffic', 'Traffic camera', this.image);
  }

  async updateCamera() {
    this.lastCamera = Date.now();
    const s = this.getSettings();
    const key = this.homey.settings.get('trafikverket_key');
    try {
      if (!this.camera) {
        // a named camera can be anywhere in Sweden (best match, nearest first); otherwise the nearest in the area
        const matches = tv.cleanName(s.camera) ? await tv.searchCameras(key, s.camera, { lat: s.lat, lon: s.lon }, 6) : [];
        this.camera = matches[0] || (await tv.cameras(key, s.lon, s.lat, s.radius_km))[0] || null;
        await this.reportCamera(matches.slice(1));
        this.log('camera:', this.camera ? `${this.camera.name} (${this.camera.km?.toFixed(1)} km)` : 'none in area');
      }
      if (this.camera && this.image) await this.image.update();
    } catch (e) {
      this.error('camera failed:', e.message);
    }
  }

  /** Show the camera in use and other matches in the (read-only) settings lines. */
  async reportCamera(others) {
    const fmt = (c) => (c.km != null ? `${c.name} (${c.km} km)` : c.name);
    const inUse = this.camera ? fmt(this.camera) : '–';
    const more = others.length ? others.map(fmt).join(', ') : '–';
    const s = this.getSettings();
    if (s.camera_in_use !== inUse || s.camera_matches !== more) {
      await this.setSettings({ camera_in_use: inUse, camera_matches: more }).catch((e) => this.error('camera labels:', e.message));
    }
  }

  /** Repair view: use this camera (exact name). */
  async chooseCamera(name) {
    await this.setSettings({ camera: name });
    this.camera = null;
    this.lastCamera = 0;
    await this.updateCamera();
  }

  async trigger(id, tokens) {
    this.log('trigger', id, tokens.text);
    await this.homey.flow.getDeviceTriggerCard(id).trigger(this, tokens).catch((e) => this.error(`trigger ${id}:`, e.message));
  }

  async set(cap, value) {
    if (this.getCapabilityValue(cap) !== value) await this.setCapabilityValue(cap, value).catch((e) => this.error(cap, e.message));
  }
}

module.exports = RoadDevice;
