'use strict';

module.exports = {
  async getUsage({ homey }) {
    return homey.app.usageSummary();
  },
};
