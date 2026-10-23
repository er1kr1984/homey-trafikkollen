'use strict';

module.exports = {
  async getFerry({ homey, query }) {
    return homey.app.ferryRoute(query.route || '', query.rows);
  },
};
