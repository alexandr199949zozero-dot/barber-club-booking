// Интеграционные тесты API: node test/run.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const PORT = 3999;
const DATA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-')), 'db.json');
const URL = 'http://localhost:' + PORT;
const KEY = 'test-pass';

const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, DATA_FILE: DATA, ADMIN_PASSWORD: KEY, TELEGRAM_BOT_TOKEN: '', KV_REST_API_URL: '', UPSTASH_REDIS_REST_URL: '' },
  stdio: ['ignore', 'pipe', 'inherit']
});

async function call(p, body, admin) {
  const h = { 'Content-Type': 'application/json' };
  if (admin) h['X-Admin-Key'] = admin;
  const r = await fetch(URL + p, { method: body ? 'POST' : 'GET', headers: h, body: body && JSON.stringify(body) });
  return { code: r.status, data: await r.json() };
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

let cfg, day;
test('конфиг отдаётся без telegram-чатов', async () => {
  const r = await call('/api/config');
  assert.equal(r.code, 200);
  cfg = r.data;
  assert.ok(cfg.services.length && cfg.barbers.length);
  assert.ok(cfg.barbers.every(b => !('tg' in b)));
  day = cfg.dates.find((d, i) => i > 0 && d.open).k;
});

let first;
test('запись создаётся, слоты на её длительность занимаются', async () => {
  const r = await call('/api/bookings', { service: 2, barber: 1, date: day, time: '12:00', name: 'Иван', phone: '+7 900 111-22-33' });
  assert.equal(r.code, 200, JSON.stringify(r.data));
  first = r.data;
  const s = (await call(`/api/slots?service=3&barber=1&date=${day}`)).data.slots;
  const f = t => s.find(x => x.t === t).free;
  assert.equal(f('11:30'), true);
  assert.equal(f('12:00'), false);
  assert.equal(f('13:00'), false);
  assert.equal(f('13:30'), true);
});

test('пересекающаяся запись к тому же мастеру отклоняется (409)', async () => {
  const r = await call('/api/bookings', { service: 1, barber: 1, date: day, time: '13:00', name: 'Пётр', phone: '+7 900 111-22-44' });
  assert.equal(r.code, 409);
});

test('параллельные запросы на одно время: проходит ровно один', async () => {
  const rs = await Promise.all([1, 2, 3, 4, 5].map(i => call('/api/bookings', { service: 3, barber: 2, date: day, time: '15:00', name: 'Гонка ' + i, phone: '+7 900 000-00-0' + i })));
  assert.equal(rs.filter(r => r.code === 200).length, 1);
  assert.equal(rs.filter(r => r.code === 409).length, 4);
});

test('«любой мастер» назначает свободного', async () => {
  const r = await call('/api/bookings', { service: 1, barber: 0, date: day, time: '12:00', name: 'Олег', phone: '+7 900 111-22-55' });
  assert.equal(r.code, 200);
  assert.notEqual(r.data.booking.barber, 1);
});

test('время после закрытия для длинной услуги недоступно', async () => {
  const r = await call('/api/bookings', { service: 2, barber: 3, date: day, time: '20:00', name: 'Поздний', phone: '+7 900 111-22-66' });
  assert.equal(r.code, 400);
});

test('валидация контактов', async () => {
  const r = await call('/api/bookings', { service: 1, barber: 3, date: day, time: '10:00', name: 'А', phone: '123' });
  assert.equal(r.code, 400);
});

test('клиент видит свою запись только с токеном', async () => {
  const ok = await call(`/api/bookings?ids=${first.booking.id}.${first.token}`);
  assert.equal(ok.data.bookings.length, 1);
  assert.ok(!('phone' in ok.data.bookings[0]) && !('token' in ok.data.bookings[0]));
  const bad = await call(`/api/bookings?ids=${first.booking.id}.wrong`);
  assert.equal(bad.data.bookings.length, 0);
});

test('отмена с чужим токеном не проходит, со своим — освобождает время', async () => {
  assert.equal((await call('/api/cancel', { id: first.booking.id, token: 'x' })).code, 404);
  const r = await call('/api/cancel', { id: first.booking.id, token: first.token });
  assert.equal(r.data.booking.status, 'cancelled');
  const again = await call('/api/bookings', { service: 1, barber: 1, date: day, time: '12:30', name: 'Пётр', phone: '+7 900 111-22-44' });
  assert.equal(again.code, 200);
});

test('админка: без пароля 401, с паролем видит записи с телефонами', async () => {
  assert.equal((await call('/api/admin?action=bookings')).code, 401);
  assert.equal((await call('/api/admin?action=bookings', null, 'wrong')).code, 401);
  const r = await call('/api/admin?action=bookings', null, KEY);
  assert.equal(r.code, 200);
  assert.ok(r.data.bookings.length >= 3 && r.data.bookings.every(b => b.phone));
});

test('админка: перерыв закрывает время', async () => {
  const r = await call('/api/admin?action=book', { kind: 'block', barber: 3, date: day, time: '16:00', min: 60, note: 'Обед' }, KEY);
  assert.equal(r.code, 200, JSON.stringify(r.data));
  const s = (await call(`/api/slots?service=3&barber=3&date=${day}`)).data.slots;
  assert.equal(s.find(x => x.t === '16:30').free, false);
});

test('админка: сохранение настроек и выходной мастера', async () => {
  const c = (await call('/api/admin?action=config', null, KEY)).data.config;
  const wd = new Date(day + 'T12:00:00Z').getUTCDay();
  c.name = 'Тест Салон';
  c.barbers[2].off = [wd];
  c.services.push({ n: 'Камуфляж седины', d: '', min: 30, p: 900 });
  const r = await call('/api/admin?action=config', c, KEY);
  assert.equal(r.code, 200, JSON.stringify(r.data));
  assert.equal(r.data.config.services.at(-1).id, 5);
  const pub = (await call('/api/config')).data;
  assert.equal(pub.name, 'Тест Салон');
  const s = (await call(`/api/slots?service=1&barber=3&date=${day}`)).data.slots;
  assert.equal(s.length, 0);
  const bad = await call('/api/admin?action=config', { ...c, open: '20:00', close: '10:00' }, KEY);
  assert.equal(bad.code, 400);
});

(async () => {
  await new Promise(r => srv.stdout.on('data', d => String(d).includes('http://') && r()));
  let fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log('✓', n); } catch (e) { fail++; console.log('✗', n, '\n ', e.message); }
  }
  srv.kill();
  console.log(fail ? `\n${fail} из ${tests.length} упало` : `\nВсе ${tests.length} тестов прошли`);
  process.exit(fail ? 1 : 0);
})();
