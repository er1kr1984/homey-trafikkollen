'use strict';

module.exports = {
  async getBoard({ homey, query }) {
    return homey.app.board(query.device || '', Math.max(1, Math.min(12, Number(query.rows) || 6)));
  },
};
