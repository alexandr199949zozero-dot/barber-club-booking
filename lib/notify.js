// Уведомления в Telegram: общий чат салона + личный чат мастера (если указан).
function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

async function send(chat, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chat) return false;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: ctl.signal
    });
    return r.ok;
  } catch (e) {
    console.error('telegram', e.message);
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function notify(cfg, b, kind) {
  const s = cfg.services.find(x => x.id === b.service) || { n: 'Услуга' };
  const br = cfg.barbers.find(x => x.id === b.barber) || { n: '—' };
  const head = { created: '🟢 Новая запись', cancelled: '🔴 Отмена записи' }[kind];
  const by = kind === 'cancelled' ? (b.cancelledBy === 'admin' ? ' (администратор)' : ' (клиент)') : '';
  const text = `<b>${head}</b>${by}\n${esc(b.date)}, ${esc(b.time)} — ${esc(s.n)}\nМастер: ${esc(br.n)}\nКлиент: ${esc(b.name)}, ${esc(b.phone)}`;
  const chats = [...new Set([process.env.TELEGRAM_CHAT_ID, br.tg].filter(Boolean))];
  await Promise.all(chats.map(c => send(c, text)));
}

module.exports = { notify, send };
