'use strict';

module.exports = {
  async getCameras({ homey, query }) {
    return homey.app.cameraWall(String(query.names || '').split('|'), query.incidents !== '0');
  },
};
