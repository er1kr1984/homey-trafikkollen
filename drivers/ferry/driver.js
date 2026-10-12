'use strict';

const crypto = require('crypto');
const Homey = require('homey');
const ferries = require('../../lib/ferries');
const tv = require('../../lib/trafikverket');

class FerryDriver extends Homey.Driver {

  async onPair(session) {
    session.setHandler('routes', async () => {
      const key = this.homey.settings.get('trafikverket_key');
      if (!key) throw new Error(this.homey.__('ferry.noKey'));
      let home = null;
      try { home = { lat: this.homey.geolocation.getLatitude(), lon: this.homey.geolocation.getLongitude() }; } catch (e) { /* no location */ }
      const list = await ferries.routes(key);
      return list.map((r) => ({
        id: r.id, name: r.name, harbors: r.harbors,
        km: home && r.point ? Math.round(tv.distanceKm(home, r.point)) : null,
      })).sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9));
    });
    session.setHandler('create', async ({ route, harbor }) => {
      const other = route.harbors.filter((h) => h.id !== harbor.id).map((h) => h.name).join(', ');
      return {
        name: `${route.name}: ${harbor.name}${other ? ` → ${other}` : ''}`,
        data: { id: `${route.id}:${harbor.id}`, uid: crypto.randomUUID().slice(0, 8) }, // the same harbor can be added again
        store: { routeName: route.name },
      };
    });
  }
}

module.exports = FerryDriver;
