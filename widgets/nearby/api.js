'use strict';

module.exports = {
  async getNearby({ homey, query }) {
    return homey.app.nearbyBoard({ stops: Number(query.stops) || 3, rows: Number(query.rows) || 3, hideTaxi: query.taxi !== '1' });
  },
};
