'use strict';

const Homey = require('homey');
const crypto = require('crypto');
const tv = require('../../lib/trafikverket');

class RoadDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getConditionCard('road_has_incidents')
      .registerRunListener(async ({ device }) => (device.getCapabilityValue('road_incidents') || 0) > 0);
    this.homey.flow.getActionCard('test_incident').registerRunListener(async ({ device }) => device.testIncident());
    const setCamera = this.homey.flow.getActionCard('set_camera');
    setCamera.registerArgumentAutocompleteListener('camera', async (query, args) => {
      const lat = args.device && args.device.getSetting('lat'); const lon = args.device && args.device.getSetting('lon');
      let list;
      if (String(query || '').trim()) list = await this.cameraOptions({ q: query, lat, lon });
      else { // nothing typed yet: the cameras nearest the device's area
        const near = Number.isFinite(lat) ? await tv.cameras(this.homey.settings.get('trafikverket_key'), lon, lat, 30) : [];
        list = near.slice(0, 10).map((c) => ({ name: c.name, km: c.km != null ? +c.km.toFixed(1) : null, photoUrl: c.photoUrl }));
      }
      return list.map((c) => ({ name: c.name, description: c.km != null ? `${c.km} km` : '', image: c.photoUrl }));
    });
    setCamera.registerRunListener(async ({ device, camera }) => device.chooseCamera(camera.name));
    this.homey.flow.getConditionCard('road_is_slippery')
      .registerRunListener(async ({ device }) => device.getCapabilityValue('alarm_road_slippery') === true);
  }

  async onPair(session) {
    session.setHandler('defaults', async () => {
      let lat = null; let lon = null;
      try {
        lat = this.homey.geolocation.getLatitude();
        lon = this.homey.geolocation.getLongitude();
      } catch (e) { /* no location permission/set */ }
      return { lat, lon, hasKey: !!this.homey.settings.get('trafikverket_key') };
    });
    session.setHandler('cameras', async (o) => this.cameraOptions(o));
    session.setHandler('create', async (o) => {
      const lat = Number(o.lat); const lon = Number(o.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Enter a valid latitude and longitude.');
      return {
        name: (o.name || '').trim() || `Traffic ${o.roads || 'nearby'}`.trim(),
        data: { id: crypto.randomUUID() },
        settings: {
          roads: (o.roads || '').trim(),
          lat: Math.round(lat * 10000) / 10000,
          lon: Math.round(lon * 10000) / 10000,
          radius_km: Math.max(1, Math.min(200, Number(o.radius_km) || 15)),
          camera: (o.camera || '').trim(),
        },
      };
    });
  }

  /** Camera suggestions while typing: { q, lat, lon } -> [{ name, km, photoUrl }] */
  async cameraOptions({ q, lat, lon }) {
    const near = Number.isFinite(+lat) && Number.isFinite(+lon) && (lat !== '' && lon !== '') ? { lat: +lat, lon: +lon } : null;
    const list = await tv.searchCameras(this.homey.settings.get('trafikverket_key'), q, near, 12);
    return list.map((c) => ({ name: c.name, km: c.km, photoUrl: c.photoUrl }));
  }

  async onRepair(session, device) {
    session.setHandler('current', async () => {
      const s = device.getSettings();
      return { camera: s.camera || '', showing: device.camera ? device.camera.name : '', lat: s.lat, lon: s.lon };
    });
    session.setHandler('cameras', async (o) => this.cameraOptions({ ...o, lat: device.getSetting('lat'), lon: device.getSetting('lon') }));
    session.setHandler('choose', async (name) => {
      await device.chooseCamera(String(name || ''));
      return true;
    });
  }
}

module.exports = RoadDriver;
