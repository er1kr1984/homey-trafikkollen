'use strict';

module.exports = {
  async getCommute({ homey, query }) {
    return homey.app.commute(query.commute || '');
  },
};
