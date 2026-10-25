const { getConfig, publicConfig } = require('../lib/core');
const { handler } = require('../lib/http');

module.exports = handler({
  GET: async () => publicConfig(await getConfig())
});
