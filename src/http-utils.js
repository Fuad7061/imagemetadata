import zlib from 'node:zlib';
import { config } from './config.js';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-XSS-Protection': '0',
};

export const CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'self'; script-src 'self'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'";

export function clientIp(req, trustProxy = false) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim().slice(0, 64);
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real) return real.trim().slice(0, 64);
  }
  return (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '').slice(0, 64);
}

export function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limitBytes) {
      reject(Object.assign(new Error('Request body too large'), { code: 'TOO_LARGE' }));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('Request body too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', err => reject(err));
    req.on('aborted', () => reject(new Error('Request aborted')));
  });
}

export function send(req, res, status, headers = {}, body = Buffer.alloc(0), options = {}) {
  if (res.writableEnded) return;
  let buffer = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body));
  const out = {
    ...SECURITY_HEADERS,
    ...headers,
  };

  const acceptEncoding = req.headers['accept-encoding'] || '';
  const compressible = options.compressible !== false &&
    /gzip/i.test(acceptEncoding) &&
    buffer.length >= config.gzipThreshold &&
    !out['Content-Encoding'];

  if (compressible && res.writable) {
    buffer = zlib.gzipSync(buffer, { level: 6 });
    out['Content-Encoding'] = 'gzip';
    out.Vary = out.Vary ? `${out.Vary}, Accept-Encoding` : 'Accept-Encoding';
  }

  out['Content-Length'] = buffer.length;
  res.writeHead(status, out);
  res.end(buffer);
}

export function corsHeaders(req, extra = {}) {
  const origin = req.headers.origin || '';
  const configured = extra.__corsOrigin;
  const allow = configured && configured !== '*' ? configured : (configured || origin || '*');
  const headers = {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allow !== '*') headers['Access-Control-Allow-Credentials'] = 'true';
  return headers;
}

export function setCookie(res, name, value, { maxAge, httpOnly = true, sameSite = 'Lax', secure = false, path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (maxAge) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  const existing = res.getHeader('Set-Cookie');
  const list = Array.isArray(existing) ? existing : (existing ? [existing] : []);
  list.push(parts.join('; '));
  res.setHeader('Set-Cookie', list);
}

export function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0, httpOnly: true, sameSite: 'Lax', path: '/' });
}
