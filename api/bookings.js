const { getConfig, create, get, view, safeEq, HttpError } = require('../lib/core');
const { handler, body } = require('../lib/http');
const { notify } = require('../lib/notify');

module.exports = handler({
  // Записи клиента: ?ids=id.token,id.token
  GET: async req => {
    const pairs = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 50);
    const list = await Promise.all(pairs.map(async p => {
      const [id, token] = p.split('.');
      const b = await get(id);
      return b && b.kind === 'booking' && safeEq(b.token, token || '') ? view(b) : null;
    }));
    return { bookings: list.filter(Boolean) };
  },
  POST: async req => {
    const inp = body(req);
    if (inp.website) throw new HttpError(400, 'Ошибка формы'); // ловушка для ботов
    const c = await getConfig();
    const b = await create(c, inp);
    await notify(c, b, 'created');
    return { booking: view(b), token: b.token };
  }
});
