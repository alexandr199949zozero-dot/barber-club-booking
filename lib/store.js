// Хранилище с одним методом exec(commands): пакет Redis-команд.
// В продакшене — Upstash Redis (REST), локально — JSON-файл в .data/.
const fs = require('fs');
const path = require('path');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmds) {
  const r = await fetch(URL_.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds.map(c => c.map(String)))
  });
  if (!r.ok) throw new Error('Redis HTTP ' + r.status);
  return (await r.json()).map(x => {
    if (x.error) throw new Error('Redis: ' + x.error);
    return x.result;
  });
}

// Локальная эмуляция нужного подмножества команд Redis.
const FILE = process.env.DATA_FILE || path.join(process.cwd(), '.data', 'db.json');
let mem = null;
function load() {
  if (mem) return mem;
  mem = { kv: {}, sets: {} };
  if (!process.env.VERCEL) {
    try { mem = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
  }
  return mem;
}
function persist() {
  if (process.env.VERCEL) return;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(mem));
}
async function local(cmds) {
  const db = load();
  const out = cmds.map(([op, k, ...a]) => {
    switch (op) {
      case 'GET': return k in db.kv ? db.kv[k] : null;
      case 'MGET': return [k, ...a].map(x => (x in db.kv ? db.kv[x] : null));
      case 'SET':
        if (a.includes('NX') && k in db.kv) return null;
        db.kv[k] = String(a[0]);
        return 'OK';
      case 'DEL': return [k, ...a].reduce((n, x) => (x in db.kv ? (delete db.kv[x], n + 1) : n), 0);
      case 'SADD': db.sets[k] = [...new Set([...(db.sets[k] || []), ...a.map(String)])]; return 1;
      case 'SREM': db.sets[k] = (db.sets[k] || []).filter(x => !a.map(String).includes(x)); return 1;
      case 'SMEMBERS': return db.sets[k] || [];
      default: throw new Error('Unsupported command ' + op);
    }
  });
  persist();
  return out;
}

const persistent = !!(URL_ && TOKEN) || !process.env.VERCEL;
module.exports = { exec: URL_ && TOKEN ? redis : local, persistent, kind: URL_ && TOKEN ? 'redis' : 'local' };
