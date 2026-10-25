// Расписание и записи. Время — в часовом поясе салона (cfg.tz).
const crypto = require('crypto');
const { exec } = require('./store');
const DEF = require('./default-config');

const pad = n => String(n).padStart(2, '0');
const mins = t => { const [h, m] = t.split(':'); return +h * 60 + +m; };
const hm = n => pad(Math.floor(n / 60)) + ':' + pad(n % 60);
const KEEP = 60 * 60 * 24 * 120; // сколько хранить блокировки слотов, сек

class HttpError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

async function getConfig() {
  const [raw] = await exec([['GET', 'config']]);
  return raw ? { ...DEF, ...JSON.parse(raw) } : DEF;
}

function cleanConfig(c) {
  const str = (v, max = 120) => String(v == null ? '' : v).trim().slice(0, max);
  const int = (v, lo, hi, d) => { const n = Math.round(+v); return n >= lo && n <= hi ? n : d; };
  const time = (v, d) => (/^\d{2}:\d{2}$/.test(v) && mins(v) < 24 * 60 ? v : d);
  const days = a => (Array.isArray(a) ? [...new Set(a.map(Number).filter(n => n >= 0 && n <= 6))] : []);
  const ids = list => { let n = Math.max(0, ...list.map(x => +x.id || 0)); return list.map(x => ({ ...x, id: +x.id > 0 ? +x.id : ++n })); };
  const out = {
    name: str(c.name, 60) || DEF.name,
    tagline: str(c.tagline, 80),
    address: str(c.address),
    phone: str(c.phone, 40),
    tz: str(c.tz, 60) || DEF.tz,
    open: time(c.open, DEF.open),
    close: time(c.close, DEF.close),
    step: [15, 20, 30, 60].includes(+c.step) ? +c.step : 30,
    days: int(c.days, 1, 60, 14),
    leadMin: int(c.leadMin, 0, 24 * 60, 30),
    closedWeekdays: days(c.closedWeekdays),
    holidays: (Array.isArray(c.holidays) ? c.holidays : []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)),
    services: ids((c.services || []).map(s => ({ id: s.id, n: str(s.n, 60), d: str(s.d, 160), min: int(s.min, 5, 480, 60), p: int(s.p, 0, 1e6, 0) })).filter(s => s.n)),
    barbers: ids((c.barbers || []).map(b => ({ id: b.id, n: str(b.n, 40), r: str(b.r, 80), off: days(b.off), tg: str(b.tg, 40) })).filter(b => b.n))
  };
  try { new Intl.DateTimeFormat('ru', { timeZone: out.tz }); } catch (e) { throw new HttpError(400, 'Неизвестный часовой пояс'); }
  if (mins(out.close) <= mins(out.open)) throw new HttpError(400, 'Время закрытия должно быть позже открытия');
  if (!out.services.length || !out.barbers.length) throw new HttpError(400, 'Нужна хотя бы одна услуга и один мастер');
  return out;
}

async function saveConfig(c) {
  const out = cleanConfig(c);
  await exec([['SET', 'config', JSON.stringify(out)]]);
  return out;
}

// Публичная часть настроек: без Telegram-чатов мастеров.
function publicConfig(c) {
  const t = now(c.tz);
  return {
    name: c.name, tagline: c.tagline, address: c.address, phone: c.phone,
    open: c.open, close: c.close, step: c.step,
    services: c.services,
    barbers: c.barbers.map(({ id, n, r }) => ({ id, n, r })),
    today: t.date,
    dates: dates(c).map(k => ({ k, wd: weekday(k), open: c.barbers.some(b => isOpen(c, k, b.id)) }))
  };
}

function now(tz) {
  const s = new Date().toLocaleString('sv-SE', { timeZone: tz, hour12: false });
  return { date: s.slice(0, 10), min: +s.slice(11, 13) * 60 + +s.slice(14, 16) };
}
function addDays(k, n) {
  const d = new Date(k + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekday = k => new Date(k + 'T12:00:00Z').getUTCDay();
const dates = c => Array.from({ length: c.days }, (_, i) => addDays(now(c.tz).date, i));

function isOpen(c, k, barber) {
  if (c.closedWeekdays.includes(weekday(k)) || c.holidays.includes(k)) return false;
  const b = c.barbers.find(x => x.id === barber);
  return !!b && !(b.off || []).includes(weekday(k));
}

async function bookingsOn(days) {
  const sets = await exec(days.map(k => ['SMEMBERS', 'd:' + k]));
  const ids = [].concat(...sets.map(x => x || []));
  if (!ids.length) return [];
  const [vals] = await exec([['MGET', ...ids.map(i => 'b:' + i)]]);
  return vals.filter(Boolean).map(v => JSON.parse(v)).filter(b => b.status === 'active');
}

const cells = (c, start, len) => {
  const a = [];
  for (let m = start; m < start + len; m += c.step) a.push(m);
  return a;
};

// Слоты одного мастера на день: [{t, free}]
function barberSlots(c, k, barber, dur, list, t) {
  if (!isOpen(c, k, barber)) return [];
  const mine = list.filter(b => b.date === k && b.barber === barber);
  const out = [];
  for (let s = mins(c.open); s + dur <= mins(c.close); s += c.step) {
    const late = k < t.date || (k === t.date && s <= t.min + c.leadMin);
    const clash = mine.some(b => { const a = mins(b.time); return s < a + b.min && a < s + dur; });
    out.push({ t: hm(s), free: !late && !clash });
  }
  return out;
}

// barber = 0 — «любой мастер»: слот свободен, если свободен хоть у кого-то.
async function slots(c, k, barber, serviceId) {
  const s = c.services.find(x => x.id === serviceId);
  if (!s) throw new HttpError(400, 'Неизвестная услуга');
  if (!dates(c).includes(k)) return [];
  const list = await bookingsOn([k]);
  const t = now(c.tz);
  const ids = barber ? [barber] : c.barbers.map(b => b.id);
  const by = new Map();
  ids.forEach(id => barberSlots(c, k, id, s.min, list, t).forEach(x => {
    by.set(x.t, (by.get(x.t) || false) || x.free);
  }));
  return [...by].sort().map(([t, free]) => ({ t, free }));
}

// Ближайшее свободное время каждого мастера: {barberId: {date, time}}
async function nearest(c, serviceId) {
  const s = c.services.find(x => x.id === serviceId);
  if (!s) throw new HttpError(400, 'Неизвестная услуга');
  const days = dates(c);
  const list = await bookingsOn(days);
  const t = now(c.tz);
  const out = {};
  c.barbers.forEach(b => {
    for (const k of days) {
      const f = barberSlots(c, k, b.id, s.min, list, t).find(x => x.free);
      if (f) { out[b.id] = { date: k, time: f.t }; break; }
    }
  });
  return out;
}

// Занимает ячейки расписания атомарно (SET NX), чтобы два клиента
// не записались на одно время.
async function lock(c, b) {
  const keys = cells(c, mins(b.time), b.min).map(m => `l:${b.barber}:${b.date}:${m}`);
  const res = await exec(keys.map(k => ['SET', k, b.id, 'NX', 'EX', KEEP]));
  if (res.every(r => r === 'OK')) return true;
  const got = keys.filter((_, i) => res[i] === 'OK');
  if (got.length) await exec([['DEL', ...got]]);
  return false;
}
async function unlock(c, b) {
  const keys = cells(c, mins(b.time), b.min).map(m => `l:${b.barber}:${b.date}:${m}`);
  await exec([['DEL', ...keys]]);
}

async function store(b) {
  await exec([['SET', 'b:' + b.id, JSON.stringify(b)], ['SADD', 'd:' + b.date, b.id]]);
}

async function create(c, inp, { admin = false } = {}) {
  const s = c.services.find(x => x.id === +inp.service);
  const name = String(inp.name || '').trim().slice(0, 60);
  const phone = String(inp.phone || '').trim().slice(0, 30);
  const kind = admin && inp.kind === 'block' ? 'block' : 'booking';
  const min = kind === 'block' ? Math.max(c.step, Math.min(720, +inp.min || c.step)) : s && s.min;
  if (kind === 'booking' && !s) throw new HttpError(400, 'Выберите услугу');
  if (!/^\d{2}:\d{2}$/.test(inp.time || '')) throw new HttpError(400, 'Выберите время');
  if (kind === 'booking' && name.length < 2) throw new HttpError(400, 'Укажите имя');
  if (kind === 'booking' && phone.replace(/\D/g, '').length < 10) throw new HttpError(400, 'Укажите телефон');
  const t = now(c.tz);
  const start = mins(inp.time);
  if (!dates(c).includes(inp.date)) throw new HttpError(400, 'На эту дату запись недоступна');
  if ((start - mins(c.open)) % c.step || start < mins(c.open) || start + min > mins(c.close)) throw new HttpError(400, 'Время вне графика работы');
  if (!admin && inp.date === t.date && start <= t.min + c.leadMin) throw new HttpError(409, 'Это время уже прошло');

  const pick = +inp.barber ? [+inp.barber] : c.barbers.map(b => b.id);
  const base = {
    kind, service: s ? s.id : 0, date: inp.date, time: hm(start), min,
    name: kind === 'block' ? String(inp.note || 'Перерыв').slice(0, 60) : name,
    phone: kind === 'block' ? '' : phone,
    status: 'active', createdAt: new Date().toISOString(),
    token: crypto.randomBytes(16).toString('hex')
  };
  for (const barber of pick) {
    if (!isOpen(c, inp.date, barber) && !admin) continue;
    const b = { ...base, id: crypto.randomBytes(5).toString('hex'), barber };
    if (await lock(c, b)) { await store(b); return b; }
  }
  throw new HttpError(409, 'Это время только что заняли. Выберите другое.');
}

async function get(id) {
  if (!/^[0-9a-f]{10}$/.test(id || '')) return null;
  const [raw] = await exec([['GET', 'b:' + id]]);
  return raw ? JSON.parse(raw) : null;
}

async function cancel(c, id, { token, admin = false } = {}) {
  const b = await get(id);
  if (!b || (!admin && !safeEq(b.token, token || ''))) throw new HttpError(404, 'Запись не найдена');
  if (b.status !== 'active') return { booking: b, changed: false };
  const t = now(c.tz);
  if (!admin && (b.date < t.date || (b.date === t.date && mins(b.time) <= t.min))) throw new HttpError(409, 'Визит уже начался, отменить онлайн нельзя');
  b.status = 'cancelled';
  b.cancelledBy = admin ? 'admin' : 'client';
  b.cancelledAt = new Date().toISOString();
  await exec([['SET', 'b:' + b.id, JSON.stringify(b)], ['SREM', 'd:' + b.date, b.id]]);
  await unlock(c, b);
  return { booking: b, changed: true };
}

function safeEq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// Что видит клиент о своей записи.
const view = b => ({ id: b.id, service: b.service, barber: b.barber, date: b.date, time: b.time, min: b.min, name: b.name, status: b.status });

module.exports = { HttpError, getConfig, saveConfig, publicConfig, slots, nearest, create, get, cancel, bookingsOn, view, safeEq, dates, now };
