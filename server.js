// Локальный запуск без Vercel: node server.js → http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');

if (!process.env.ADMIN_PASSWORD) {
  process.env.ADMIN_PASSWORD = 'admin';
  console.log('ADMIN_PASSWORD не задан — для локальной админки пароль: admin');
}

const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const api = u.pathname.match(/^\/api\/([a-z-]+)$/);
  if (api) {
    let file;
    try { file = require.resolve('./api/' + api[1]); } catch (e) { res.statusCode = 404; return res.end(); }
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      req.query = Object.fromEntries(u.searchParams);
      try { req.body = raw ? JSON.parse(raw) : {}; } catch (e) { req.body = {}; }
      require(file)(req, res);
    });
    return;
  }
  let p = u.pathname === '/' ? '/index.html' : u.pathname;
  if (!path.extname(p)) p += '.html';
  const f = path.join(PUB, path.normalize(p));
  if (!f.startsWith(PUB)) { res.statusCode = 403; return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
    res.end(data);
  });
}).listen(process.env.PORT || 3000, () => console.log('http://localhost:' + (process.env.PORT || 3000)));
