const core = require('../lib/core');
const { handler, body, isAdmin } = require('../lib/http');
const { notify, send } = require('../lib/notify');
const store = require('../lib/store');

const { HttpError } = core;

function guard(req) {
  if (!process.env.ADMIN_PASSWORD) throw new HttpError(503, 'Задайте переменную ADMIN_PASSWORD в настройках проекта');
  if (!isAdmin(req)) throw new HttpError(401, 'Неверный пароль');
}

// Все действия админки в одной функции: ?action=...
module.exports = handler({
  GET: async req => {
    guard(req);
    const c = await core.getConfig();
    const a = req.query.action;
    if (a === 'config') {
      return {
        config: c,
        status: {
          storage: store.kind,
          persistent: store.persistent,
          telegram: !!process.env.TELEGRAM_BOT_TOKEN,
          telegramChat: !!process.env.TELEGRAM_CHAT_ID
        }
      };
    }
    if (a === 'bookings') {
      const days = req.query.date ? [String(req.query.date)] : core.dates(c);
      const list = await core.bookingsOn(days);
      list.sort((x, y) => (x.date + x.time < y.date + y.time ? -1 : 1));
      return { bookings: list.map(b => ({ ...core.view(b), kind: b.kind, phone: b.phone, createdAt: b.createdAt })) };
    }
    throw new HttpError(400, 'Неизвестное действие');
  },
  POST: async req => {
    guard(req);
    const c = await core.getConfig();
    const inp = body(req);
    const a = req.query.action;
    if (a === 'config') return { config: await core.saveConfig(inp) };
    if (a === 'cancel') {
      const { booking, changed } = await core.cancel(c, inp.id, { admin: true });
      if (changed && booking.kind === 'booking') await notify(c, booking, 'cancelled');
      return { ok: true };
    }
    if (a === 'book') {
      const b = await core.create(c, inp, { admin: true });
      if (b.kind === 'booking') await notify(c, b, 'created');
      return { booking: core.view(b) };
    }
    if (a === 'test-telegram') {
      if (!process.env.TELEGRAM_BOT_TOKEN) throw new HttpError(400, 'Не задан TELEGRAM_BOT_TOKEN');
      const chats = [process.env.TELEGRAM_CHAT_ID, ...c.barbers.map(b => b.tg)].filter(Boolean);
      if (!chats.length) throw new HttpError(400, 'Не указан ни один чат');
      const ok = await Promise.all(chats.map(ch => send(ch, `✅ ${c.name}: уведомления о записях работают`)));
      return { sent: ok.filter(Boolean).length, total: chats.length };
    }
    throw new HttpError(400, 'Неизвестное действие');
  }
});
