'use strict';

const handlers = {
  async testKeys({ homey }) {
    return homey.app.testKeys();
  },
  async getBoard({ homey, query }) {
    return homey.app.board(query.device || '', Math.max(1, Math.min(12, Number(query.rows) || 6)));
  },
  async getCommute({ homey, query }) {
    return homey.app.commute(query.commute || '');
  },
  async searchStops({ homey, query }) {
    return homey.app.searchStops(query.q || '');
  },
  async roadOptions({ homey, query }) {
    return homey.app.roadOptions(query);
  },
  async nearbyBoard({ homey, query }) {
    return homey.app.nearbyBoard({ stops: Number(query.stops) || 3, rows: Number(query.rows) || 3, hideTaxi: query.taxi !== '1' });
  },
  async searchCameras({ homey, query }) {
    return homey.app.searchCameras(query);
  },
  async geocode({ homey, query }) {
    return homey.app.geocode(query.q, query.home === '1');
  },
  async nearbyStops({ homey, query }) {
    return homey.app.nearbyStops(query);
  },
  async suggestTransfers({ homey, body }) {
    return homey.app.suggestTransfers(body || {});
  },
  async getLeave({ homey, query }) {
    return homey.app.leave(query.source || '', query.margin);
  },
  async getFerryRoute({ homey, query }) {
    return homey.app.ferryRoute(query.route || '', query.rows);
  },
  async getCameraWall({ homey, query }) {
    return homey.app.cameraWall(String(query.names || '').split('|'), query.incidents !== '0');
  },
  async getUsage({ homey }) {
    return homey.app.usageSummary();
  },
  async previewCommute({ homey, body }) {
    return homey.app.previewCommute(body || {});
  },
};

// every error leaves translated and with a hint where to fix it
module.exports = Object.fromEntries(Object.entries(handlers).map(([name, fn]) => [name, async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    throw new Error(args.homey.app.friendly(e));
  }
}]));
