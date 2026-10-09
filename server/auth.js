import crypto from 'node:crypto';

const COOKIE = 'kb_session';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function createAuth(config) {
  const enabled = !config.allowNoAuth;
  // Deriving the key from the password means changing the password logs every device out.
  const key = config.sessionSecret || sha(`kanban-session:${config.appPassword}`);
  const fails = new Map(); // ip -> { n, first }

  const sign = (data) => b64(crypto.createHmac('sha256', key).update(data).digest());

  function issue() {
    const payload = `${Date.now() + MAX_AGE_MS}.${b64(crypto.randomBytes(12))}`;
    return `${payload}.${sign(payload)}`;
  }

  function valid(token) {
    if (!token) return false;
    const i = token.lastIndexOf('.');
    if (i < 0) return false;
    const payload = token.slice(0, i);
    const given = Buffer.from(token.slice(i + 1));
    const want = Buffer.from(sign(payload));
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return false;
    return Number(payload.split('.')[0]) > Date.now();
  }

  function readCookie(req) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return decodeURIComponent(v.join('='));
    }
    return '';
  }

  const isAuthed = (req) => !enabled || valid(readCookie(req));

  function secureFlag(req) {
    if (config.cookieSecure === 'auto') return req.secure;
    return config.cookieSecure;
  }

  function limited(ip) {
    const f = fails.get(ip);
    if (!f) return false;
    if (Date.now() - f.first > WINDOW_MS) {
      fails.delete(ip);
      return false;
    }
    return f.n >= MAX_FAILS;
  }

  function login(req, res) {
    const ip = req.ip;
    if (limited(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    const ok = crypto.timingSafeEqual(sha(req.body?.password ?? ''), sha(config.appPassword));
    if (!ok) {
      const f = fails.get(ip) ?? { n: 0, first: Date.now() };
      f.n += 1;
      fails.set(ip, f);
      return res.status(401).json({ error: 'Wrong password' });
    }
    fails.delete(ip);
    res.cookie(COOKIE, issue(), {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureFlag(req),
      maxAge: MAX_AGE_MS,
      path: '/',
    });
    res.json({ ok: true });
  }

  function logout(req, res) {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  }

  function require(req, res, next) {
    if (isAuthed(req)) return next();
    res.status(401).json({ error: 'Not signed in' });
  }

  return { enabled, login, logout, require, isAuthed };
}
