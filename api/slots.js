const { getConfig, slots, nearest } = require('../lib/core');
const { handler } = require('../lib/http');

// GET /api/slots?service=1&barber=2&date=2026-10-27 — слоты на день
// GET /api/slots?service=1&nearest=1               — ближайшее время мастеров
module.exports = handler({
  GET: async req => {
    const c = await getConfig();
    const q = req.query;
    if (q.nearest) return { nearest: await nearest(c, +q.service) };
    return { slots: await slots(c, String(q.date), +q.barber || 0, +q.service) };
  }
});
