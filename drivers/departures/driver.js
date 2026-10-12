'use strict';

const crypto = require('crypto');
const Homey = require('homey');
const tl = require('../../lib/trafiklab');

class DepartureDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getConditionCard('next_is_delayed')
      .registerRunListener(async ({ device, minutes }) => device.nextDelay() >= (minutes || 0));
  }

  async onPair(session) {
    session.setHandler('search', async (query) => {
      const key = this.homey.settings.get('trafiklab_key');
      if (!key) throw new Error(this.homey.__('errors.noTrafiklabKey'));
      const stops = await tl.searchStops(key, query);
      return stops.slice(0, 25);
    });
    session.setHandler('create', async (stop) => ({
      name: stop.name,
      data: { id: stop.id, uid: crypto.randomUUID().slice(0, 8) }, // uid: the same stop can be added again (e.g. one device per direction)
      store: { name: stop.name, lat: stop.lat, lon: stop.lon, modes: stop.modes },
    }));
  }
}

module.exports = DepartureDriver;
