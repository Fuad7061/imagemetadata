import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, VERSION } from './config.js';
import * as store from './store.js';
import * as auth from './auth.js';
import * as rl from './ratelimit.js';
import * as h from './http-utils.js';
import core from './core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

store.init();

const STATIC = new Map();
for (const [route, file, type, cache] of [
  ['/', 'index.html', 'text/html; charset=utf-8', 'no-cache'],
  ['/index.html', 'index.html', 'text/html; charset=utf-8', 'no-cache'],
  ['/styles.css', 'styles.css', 'text/css; charset=utf-8', 'public, max-age=3600'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8', 'public, max-age=3600'],
  ['/favicon.svg', 'favicon.svg', 'image/svg+xml', 'public, max-age=86400'],
]) {
  try {
    const buffer = fs.readFileSync(path.join(PUBLIC_DIR, file));
    STATIC.set(route, { buffer, type, cache, etag: `"${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16)}"` });
  } catch (err) {
    console.error(`[static] missing ${file}:`, err.message);
  }
}

function elapsed(started) {
  return Math.max(0, Math.round(Number(process.hrtime.bigint() - started) / 1e6));
}

function webHeaders(response) {
  const out = {};
  for (const [key, value] of response.headers.entries()) {
    if (['content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function reply(req, res, started, status, headers, body, log = null) {
  h.send(req, res, status, headers, body);
  if (log) {
    store.addLog({
      method: req.method,
      path: String(req.url || '').split('?')[0],
      status,
      durationMs: elapsed(started),
      ip: h.clientIp(req, config.trustProxy),
      ok: status < 400,
      ...log,
    });
  }
}

function json(req, res, started, obj, status = 200, headers = {}, log = null) {
  reply(req, res, started, status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }, JSON.stringify(obj), log);
}

function errorResponse(message, details) {
  return details ? { error: message, details } : { error: message };
}

function isSecure(req) {
  if (String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https') return true;
  return /^https:\/\//i.test(config.publicBaseUrl);
}

function baseUrl(url, req) {
  return store.getSettings().publicBaseUrl || config.publicBaseUrl || `${url.protocol}//${req.headers.host || 'localhost'}`;
}

function buildCoreOptions(url, req, settings) {
  const base = baseUrl(url, req);
  const options = {
    publicBaseUrl: base,
    uploadOrder: settings.uploadMode === 'local' ? ['local'] : settings.uploadOrder,
  };
  if (settings.uploadMode === 'local') {
    options.localUpload = (bytes, filename) => {
      const rec = store.saveLocalFile(bytes, filename);
      return {
        url: `${base}/f/${rec.id}.jpg`,
        expires_at: new Date(rec.expiresAt).toISOString(),
        provider: 'local',
      };
    };
  }
  return options;
}

function applyDefaults(bodyObj, settings) {
  if (settings.defaultCameraProfile && !bodyObj.camera_profile) bodyObj.camera_profile = settings.defaultCameraProfile;
  if (settings.defaultLocation && !bodyObj.location) bodyObj.location = settings.defaultLocation;
  return bodyObj;
}

async function runCore(url, bodyObj, options) {
  const fakeRequest = { url: url.href, method: 'POST', json: async () => bodyObj };
  return core.fetch(fakeRequest, options);
}

function serveStatic(req, res, entry, started) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(req, res, started, errorResponse('Method not allowed'), 405, { Allow: 'GET, HEAD' });
  }
  const headers = {
    'Content-Type': entry.type,
    'Cache-Control': entry.cache,
    ETag: entry.etag,
    ...(entry.type.startsWith('text/html') ? { 'Content-Security-Policy': h.CSP } : {}),
  };
  if (req.headers['if-none-match'] === entry.etag) {
    h.send(req, res, 304, headers, Buffer.alloc(0));
    return;
  }
  h.send(req, res, 200, headers, req.method === 'HEAD' ? Buffer.alloc(0) : entry.buffer);
}

function serveLocalFile(req, res, url, started) {
  const match = /^\/f\/([0-9a-f-]{36})\.jpg$/i.exec(url.pathname);
  if (!match) return json(req, res, started, errorResponse('Not found'), 404);
  const record = store.getLocalFile(match[1]);
  if (!record || record.expiresAt <= Date.now()) {
    return json(req, res, started, errorResponse('File not found or expired'), 404);
  }
  let buffer;
  try { buffer = fs.readFileSync(record.path); } catch {
    return json(req, res, started, errorResponse('File not found'), 404);
  }
  h.send(req, res, 200, {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'public, max-age=3600',
    ETag: `"${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16)}"`,
  }, buffer, { compressible: false });
}

async function handlePublicApi(req, res, url, started) {
  const settings = store.getSettings();
  const cors = h.corsHeaders(req, { __corsOrigin: process.env.CORS_ORIGIN || '' });

  if (req.method === 'OPTIONS') {
    h.send(req, res, 204, { ...cors, 'Content-Length': '0' }, Buffer.alloc(0));
    return;
  }
  if (req.method !== 'POST') {
    json(req, res, started, errorResponse('Method not allowed. Use POST.'), 405, { ...cors, Allow: 'POST, OPTIONS' });
    return;
  }

  const keyAuth = auth.apiKeyFromRequest(req);
  if (!settings.allowAnonymous && !keyAuth.ok) {
    json(req, res, started, errorResponse('Unauthorized. Provide an API key: Authorization: Bearer <API_KEY>'), 401,
      { ...cors, 'WWW-Authenticate': 'Bearer' });
    return;
  }

  const ip = h.clientIp(req, config.trustProxy);
  const limitKey = keyAuth.record ? `key:${keyAuth.record.id}` : `ip:${ip}`;
  const max = keyAuth.record?.rateLimitMax || settings.rateLimitMax;
  const windowMs = settings.rateLimitWindowMs;
  const limited = rl.check(limitKey, max, windowMs);
  const rateHeaders = {
    ...cors,
    'X-RateLimit-Limit': String(max),
    'X-RateLimit-Remaining': String(limited.remaining),
    'X-RateLimit-Reset': String(Math.ceil(limited.resetAt / 1000)),
  };
  if (!limited.allowed) {
    json(req, res, started, errorResponse('Rate limit exceeded. Try again shortly.'), 429,
      { ...rateHeaders, 'Retry-After': String(limited.retryAfter) });
    return;
  }

  let raw;
  try {
    raw = await h.readBody(req, config.maxBodyBytes);
  } catch (err) {
    const status = err.code === 'TOO_LARGE' ? 413 : 400;
    json(req, res, started, errorResponse(err.message), status, rateHeaders);
    return;
  }

  let bodyObj;
  try {
    bodyObj = JSON.parse(raw.toString('utf8'));
  } catch {
    json(req, res, started, errorResponse('Invalid JSON body.'), 400, rateHeaders);
    return;
  }
  if (!bodyObj || typeof bodyObj !== 'object' || Array.isArray(bodyObj)) {
    json(req, res, started, errorResponse('JSON body must be an object.'), 400, rateHeaders);
    return;
  }

  applyDefaults(bodyObj, settings);

  let response;
  try {
    response = await runCore(url, bodyObj, buildCoreOptions(url, req, settings));
  } catch (err) {
    json(req, res, started, errorResponse(`Processing failed: ${err.message}`), 500, rateHeaders);
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  let provider = '';
  let message = '';
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    provider = parsed.upload_provider || '';
    message = parsed.error || '';
    if (parsed.details) message += ' ' + JSON.stringify(parsed.details);
  } catch { /* binary or non-json */ }

  if (keyAuth.record) store.touchApiKey(keyAuth.record.id);

  reply(req, res, started, response.status, { ...webHeaders(response), ...rateHeaders }, buffer, {
    apiKeyId: keyAuth.record?.id || null,
    provider,
    message: String(message).slice(0, 400),
  });
}

function requireJsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

async function handleAdmin(req, res, url, started) {
  const p = url.pathname;
  const method = req.method;
  const ip = h.clientIp(req, config.trustProxy);

  if (p === '/api/admin/login' && method === 'POST') {
    let body;
    try { body = JSON.parse((await h.readBody(req, 64 * 1024)).toString('utf8')); } catch {
      return json(req, res, started, errorResponse('Invalid JSON body.'), 400);
    }
    const attempt = rl.check(`login:${ip}`, 8, 60_000);
    if (!attempt.allowed) {
      return json(req, res, started, errorResponse('Too many login attempts. Try again shortly.'), 429,
        { 'Retry-After': String(attempt.retryAfter) });
    }
    if (!requireJsonObject(body) || typeof body.key !== 'string' || !store.verifyAdmin(body.key)) {
      return json(req, res, started, errorResponse('Invalid admin key.'), 401, {}, { kind: 'admin', message: 'Failed login', provider: '' });
    }
    const session = store.createSession();
    h.setCookie(res, 'im_session', session.token, {
      maxAge: config.sessionTtlMs,
      httpOnly: true,
      sameSite: 'Lax',
      secure: isSecure(req),
    });
    return json(req, res, started, { ok: true, expiresAt: session.expiresAt, version: VERSION }, 200, {},
      { kind: 'admin', message: 'Login', provider: '' });
  }

  if (!auth.isAdmin(req)) {
    return json(req, res, started, errorResponse('Unauthorized. Admin access required.'), 401);
  }

  if (p === '/api/admin/logout' && method === 'POST') {
    const token = auth.parseCookies(req).im_session;
    if (token) store.deleteSession(token);
    h.clearCookie(res, 'im_session');
    return json(req, res, started, { ok: true });
  }

  if (p === '/api/admin/me' && method === 'GET') {
    return json(req, res, started, {
      ok: true,
      version: VERSION,
      uptime: Math.floor(process.uptime()),
      retentionDays: store.getSettings().logRetentionDays,
    });
  }

  if (p === '/api/admin/overview' && method === 'GET') {
    return json(req, res, started, store.overview());
  }

  if (p === '/api/admin/keys' && method === 'GET') {
    return json(req, res, started, { items: store.listApiKeys() });
  }

  if (p === '/api/admin/keys' && method === 'POST') {
    let body;
    try { body = JSON.parse((await h.readBody(req, 32 * 1024)).toString('utf8')); } catch {
      return json(req, res, started, errorResponse('Invalid JSON body.'), 400);
    }
    if (!requireJsonObject(body)) return json(req, res, started, errorResponse('Invalid body.'), 400);
    const expiresInDays = body.expiresInDays == null || body.expiresInDays === '' ? null : Number(body.expiresInDays);
    if (expiresInDays != null && (!Number.isFinite(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650)) {
      return json(req, res, started, errorResponse('expiresInDays must be between 1 and 3650.'), 422);
    }
    const rateLimitMax = body.rateLimitMax == null || body.rateLimitMax === '' ? null : Number(body.rateLimitMax);
    if (rateLimitMax != null && (!Number.isInteger(rateLimitMax) || rateLimitMax < 1 || rateLimitMax > 1_000_000)) {
      return json(req, res, started, errorResponse('rateLimitMax must be between 1 and 1000000.'), 422);
    }
    const created = store.createApiKey({ name: String(body.name || 'Untitled key'), expiresInDays, rateLimitMax });
    return json(req, res, started, { ...store.sanitizeKey(created.record), secret: created.secret }, 201, {},
      { kind: 'admin', message: `Created key: ${created.record.name}`, provider: '' });
  }

  const keyMatch = /^\/api\/admin\/keys\/([0-9a-f-]{36})$/i.exec(p);
  if (keyMatch) {
    const id = keyMatch[1];
    if (method === 'PATCH') {
      let body;
      try { body = JSON.parse((await h.readBody(req, 16 * 1024)).toString('utf8')); } catch {
        return json(req, res, started, errorResponse('Invalid JSON body.'), 400);
      }
      if (!requireJsonObject(body) || typeof body.enabled !== 'boolean') {
        return json(req, res, started, errorResponse('enabled must be a boolean.'), 422);
      }
      const updated = store.setApiKeyEnabled(id, body.enabled);
      if (!updated) return json(req, res, started, errorResponse('Key not found.'), 404);
      return json(req, res, started, { item: updated }, 200, {},
        { kind: 'admin', message: `${body.enabled ? 'Enabled' : 'Disabled'} key: ${updated.name}`, provider: '' });
    }
    if (method === 'DELETE') {
      const removed = store.deleteApiKey(id);
      if (!removed) return json(req, res, started, errorResponse('Key not found.'), 404);
      return json(req, res, started, { ok: true }, 200, {},
        { kind: 'admin', message: `Deleted key: ${id}`, provider: '' });
    }
  }

  if (p === '/api/admin/logs' && method === 'GET') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const status = ['success', 'error'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : '';
    const q = String(url.searchParams.get('q') || '').slice(0, 100);
    return json(req, res, started, store.listLogs({ limit, offset, status, q }));
  }

  if (p === '/api/admin/logs' && method === 'DELETE') {
    store.clearLogs();
    return json(req, res, started, { ok: true }, 200, {},
      { kind: 'admin', message: 'Cleared request logs', provider: '' });
  }

  if (p === '/api/admin/settings' && method === 'GET') {
    return json(req, res, started, store.getSettings());
  }

  if (p === '/api/admin/settings' && method === 'PATCH') {
    let body;
    try { body = JSON.parse((await h.readBody(req, 32 * 1024)).toString('utf8')); } catch {
      return json(req, res, started, errorResponse('Invalid JSON body.'), 400);
    }
    if (!requireJsonObject(body)) return json(req, res, started, errorResponse('Invalid body.'), 400);

    const allowed = new Set([
      'allowAnonymous', 'uploadMode', 'uploadOrder', 'publicBaseUrl',
      'defaultCameraProfile', 'defaultLocation', 'rateLimitEnabled',
      'rateLimitMax', 'rateLimitWindowMs', 'localFileTtlHours',
    ]);
    const patch = {};
    for (const [key, value] of Object.entries(body)) {
      if (!allowed.has(key)) continue;
      if (key === 'allowAnonymous' || key === 'rateLimitEnabled') patch[key] = !!value;
      else if (key === 'uploadMode') patch[key] = value === 'local' ? 'local' : 'external';
      else if (key === 'uploadOrder') {
        if (Array.isArray(value)) {
          patch[key] = value.filter(n => ['tmpfiles', 'uguu', 'litterbox'].includes(n)).slice(0, 3);
          if (!patch[key].length) patch[key] = ['tmpfiles', 'uguu', 'litterbox'];
        }
      } else if (key === 'publicBaseUrl' || key === 'defaultCameraProfile') {
        patch[key] = String(value || '').replace(/\/$/, '').slice(0, 300);
      } else if (key === 'defaultLocation') {
        if (!value || typeof value !== 'object') patch[key] = null;
        else {
          const lat = Number(value.lat), lon = Number(value.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
            return json(req, res, started, errorResponse('Invalid location coordinates.'), 422);
          }
          patch[key] = {
            lat, lon,
            city: String(value.city || 'Unknown').slice(0, 80),
            country: String(value.country || 'Unknown').slice(0, 80),
          };
        }
      } else if (key === 'rateLimitMax') patch[key] = Math.min(1_000_000, Math.max(1, Number(value) || 60));
      else if (key === 'rateLimitWindowMs') patch[key] = Math.min(86_400_000, Math.max(1000, Number(value) || 60000));
      else if (key === 'localFileTtlHours') patch[key] = Math.min(720, Math.max(1, Number(value) || 24));
    }
    const updated = store.updateSettings(patch);
    return json(req, res, started, { ok: true, settings: updated }, 200, {},
      { kind: 'admin', message: 'Updated settings', provider: '' });
  }

  if (p === '/api/admin/settings/admin-key' && method === 'POST') {
    let body = {};
    try {
      const raw = await h.readBody(req, 16 * 1024);
      if (raw.length) body = JSON.parse(raw.toString('utf8'));
    } catch {
      return json(req, res, started, errorResponse('Invalid JSON body.'), 400);
    }
    const supplied = typeof body.newKey === 'string' && body.newKey.trim() ? body.newKey.trim() : null;
    if (supplied && supplied.length < 12) {
      return json(req, res, started, errorResponse('Admin key must be at least 12 characters.'), 422);
    }
    const key = store.rotateAdminKey(supplied);
    h.clearCookie(res, 'im_session');
    return json(req, res, started, { ok: true, key, sessionsCleared: true }, 200, {},
      { kind: 'admin', message: 'Rotated admin key', provider: '' });
  }

  if (p === '/api/admin/files' && method === 'GET') {
    return json(req, res, started, { items: store.listFiles() });
  }

  const fileMatch = /^\/api\/admin\/files\/([0-9a-f-]{36})$/i.exec(p);
  if (fileMatch && method === 'DELETE') {
    const ok = store.deleteLocalFile(fileMatch[1]);
    return json(req, res, started, { ok }, ok ? 200 : 404, {},
      { kind: 'admin', message: `Deleted local file: ${fileMatch[1]}`, provider: '' });
  }

  if (p === '/api/admin/test' && method === 'POST') {
    let bodyObj;
    try { bodyObj = JSON.parse((await h.readBody(req, config.maxBodyBytes)).toString('utf8')); } catch {
      return json(req, res, started, errorResponse('Invalid JSON body.'), 400);
    }
    if (!requireJsonObject(bodyObj)) return json(req, res, started, errorResponse('JSON body must be an object.'), 400);
    applyDefaults(bodyObj, store.getSettings());
    let response;
    try {
      response = await runCore(url, bodyObj, buildCoreOptions(url, req, store.getSettings()));
    } catch (err) {
      return json(req, res, started, errorResponse(`Processing failed: ${err.message}`), 500);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    let provider = '';
    try { provider = JSON.parse(buffer.toString('utf8')).upload_provider || ''; } catch { /* ignore */ }
    reply(req, res, started, response.status, webHeaders(response), buffer,
      { kind: 'admin', message: 'Playground test', provider });
    return;
  }

  return json(req, res, started, errorResponse('Admin endpoint not found'), 404);
}

async function handle(req, res, url, started) {
  const p = url.pathname;

  if (p === '/health' && req.method === 'GET') {
    return h.send(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify({ status: 'ok', version: VERSION, uptime: Math.floor(process.uptime()), storedLogs: store.logCount() }));
  }

  if (p === '/docs' && (req.method === 'GET' || req.method === 'HEAD')) {
    const response = await core.fetch({ url: url.href, method: 'GET' }, { publicBaseUrl: baseUrl(url, req) });
    const buffer = Buffer.from(await response.arrayBuffer());
    return h.send(req, res, response.status, webHeaders(response), req.method === 'HEAD' ? Buffer.alloc(0) : buffer);
  }

  if (p === '/embed-metadata' || p === '/strip-metadata') {
    return handlePublicApi(req, res, url, started);
  }

  if (p.startsWith('/f/')) return serveLocalFile(req, res, url, started);

  if (STATIC.has(p)) return serveStatic(req, res, STATIC.get(p), started);

  if (p.startsWith('/api/admin/')) return handleAdmin(req, res, url, started);

  return json(req, res, started, errorResponse('Not found. POST to /embed-metadata or visit / for the dashboard.'), 404);
}

const server = http.createServer((req, res) => {
  const started = process.hrtime.bigint();
  req.setTimeout(120_000, () => {
    if (!res.writableEnded) {
      res.writeHead(408, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request timeout' }));
    }
  });
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch {
    h.send(req, res, 400, { 'Content-Type': 'application/json' }, JSON.stringify(errorResponse('Invalid URL')));
    return;
  }
  handle(req, res, url, started).catch(err => {
    console.error('[server] unhandled request error:', err);
    if (!res.writableEnded) {
      h.send(req, res, 500, { 'Content-Type': 'application/json; charset=utf-8' },
        JSON.stringify(errorResponse('Internal server error')));
    }
  });
});

server.keepAliveTimeout = 5000;
server.headersTimeout = 10000;
server.requestTimeout = 130_000;

server.listen(config.port, config.host, () => {
  console.log(`\n  ImageMetadata v${VERSION} listening on http://${config.host}:${config.port}`);
  console.log(`  Dashboard:  http://localhost:${config.port}/`);
  console.log(`  Health:     http://localhost:${config.port}/health`);
  console.log(`  Data dir:   ${config.dataDir}`);
  console.log(`  Log retention: ${store.getSettings().logRetentionDays} day(s) (hard max 10)\n`);
});

setInterval(() => { store.cleanup(); rl.cleanup(); }, config.cleanupIntervalMs).unref();
setInterval(() => rl.cleanup(), 60_000).unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    store.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

process.on('uncaughtException', err => console.error('[fatal] uncaught exception:', err));
process.on('unhandledRejection', err => console.error('[fatal] unhandled rejection:', err));
