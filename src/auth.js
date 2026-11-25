import * as store from './store.js';

export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function getBearer(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  return match[1].trim();
}

export function isAdmin(req) {
  const cookies = parseCookies(req);
  if (cookies.im_session && store.validateSession(cookies.im_session)) return true;

  const adminKey = req.headers['x-admin-key'];
  if (typeof adminKey === 'string' && store.verifyAdmin(adminKey)) return true;

  const bearer = getBearer(req);
  if (bearer && store.verifyAdmin(bearer)) return true;

  return false;
}

export function apiKeyFromRequest(req) {
  const bearer = getBearer(req);
  if (!bearer) return { ok: false, reason: 'missing', record: null };
  const record = store.findApiKey(bearer);
  if (!record) return { ok: false, reason: 'invalid', record: null };
  return { ok: true, reason: null, record };
}
