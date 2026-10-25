const { getConfig, cancel, view } = require('../lib/core');
const { handler, body } = require('../lib/http');
const { notify } = require('../lib/notify');

module.exports = handler({
  POST: async req => {
    const { id, token } = body(req);
    const c = await getConfig();
    const { booking, changed } = await cancel(c, id, { token });
    if (changed) await notify(c, booking, 'cancelled');
    return { booking: view(booking) };
  }
});
