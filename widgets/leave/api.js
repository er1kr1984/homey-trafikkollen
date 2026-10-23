'use strict';

module.exports = {
  async getLeave({ homey, query }) {
    return homey.app.leave(query.source || '', query.margin);
  },
};
