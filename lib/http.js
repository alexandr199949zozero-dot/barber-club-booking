const { HttpError, safeEq } = require('./core');

function send(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function body(req) {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  try { return JSON.parse(b || '{}'); } catch (e) { return {}; }
}

function isAdmin(req) {
  const pass = process.env.ADMIN_PASSWORD;
  const got = req.headers['x-admin-key'];
  return !!pass && !!got && safeEq(pass, got);
}

// Оборачивает обработчик: методы, ошибки, JSON-ответ.
function handler(methods) {
  return async (req, res) => {
    const fn = methods[req.method];
    if (!fn) return send(res, 405, { error: 'Метод не поддерживается' });
    try {
      send(res, 200, await fn(req, res));
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.code, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'Ошибка сервера. Попробуйте ещё раз или позвоните нам.' });
    }
  };
}

module.exports = { send, body, isAdmin, handler };
