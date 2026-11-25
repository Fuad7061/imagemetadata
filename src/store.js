import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, VERSION } from './config.js';

const STATE_FILE = path.join(config.dataDir, 'state.json');
const TEMP_FILE = path.join(config.dataDir, 'state.json.tmp');
const FILES_DIR = path.join(config.dataDir, 'files');
const ADMIN_KEY_FILE = path.join(config.dataDir, 'ADMIN_KEY.txt');
const DAY = 86_400_000;

const DEFAULT_SETTINGS = {
  allowAnonymous: false,
  uploadMode: 'external',
  uploadOrder: ['tmpfiles', 'uguu', 'litterbox', 'catbox'],
  createLongLivedLink: true,
  publicBaseUrl: '',
  defaultCameraProfile: '',
  defaultLocation: null,
  rateLimitEnabled: true,
  rateLimitMax: 60,
  rateLimitWindowMs: 60000,
  logRetentionDays: config.logRetentionDays,
  localFileTtlHours: 24,
  updatedAt: null,
};

let state = null;
let writeChain = Promise.resolve();
let saveTimer = null;

function now() { return Date.now(); }

function sha256(value, salt = '') {
  return crypto.createHash('sha256').update(salt).update(value).digest('hex');
}

function makeSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: sha256(secret, salt), createdAt: now() };
}

function verifySecret(secret, record) {
  if (!record || typeof secret !== 'string' || !record.hash || !record.salt) return false;
  const actual = Buffer.from(sha256(secret, record.salt), 'hex');
  const expected = Buffer.from(record.hash, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function blankState() {
  return {
    version: VERSION,
    settings: { ...DEFAULT_SETTINGS },
    admin: null,
    apiKeys: [],
    sessions: [],
    logs: [],
    files: [],
  };
}

function sanitizeLoaded(raw) {
  const base = blankState();
  if (!raw || typeof raw !== 'object') return base;
  base.settings = { ...DEFAULT_SETTINGS, ...(raw.settings && typeof raw.settings === 'object' ? raw.settings : {}) };
  base.settings.logRetentionDays = Math.min(10, Math.max(1, Number(base.settings.logRetentionDays) || 10));
  if (!Array.isArray(base.settings.uploadOrder) || !base.settings.uploadOrder.length) {
    base.settings.uploadOrder = [...DEFAULT_SETTINGS.uploadOrder];
  }
  base.settings.uploadOrder = base.settings.uploadOrder.filter(n => ['tmpfiles', 'uguu', 'litterbox', 'catbox'].includes(n));
  if (!base.settings.uploadOrder.includes('catbox')) base.settings.uploadOrder.push('catbox');
  base.settings.uploadMode = base.settings.uploadMode === 'local' ? 'local' : 'external';
  base.admin = raw.admin && raw.admin.hash ? raw.admin : null;
  base.apiKeys = Array.isArray(raw.apiKeys) ? raw.apiKeys.filter(k => k && k.hash && k.id) : [];
  base.sessions = Array.isArray(raw.sessions) ? raw.sessions.filter(s => s && s.hash && s.expiresAt > now()) : [];
  base.logs = Array.isArray(raw.logs) ? raw.logs.filter(l => l && typeof l.ts === 'number') : [];
  base.files = Array.isArray(raw.files) ? raw.files.filter(f => f && f.id && f.path) : [];
  return base;
}

function persistSync() {
  if (!state) return;
  state.version = VERSION;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(TEMP_FILE, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(TEMP_FILE, STATE_FILE);
    fs.chmodSync(STATE_FILE, 0o600);
  } catch (err) {
    console.error('[store] failed to persist state:', err.message);
  }
}

function persist() {
  writeChain = writeChain.then(() => { persistSync(); }).catch(err => console.error('[store]', err));
  return writeChain;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, 1200);
  saveTimer.unref?.();
}

export function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  persistSync();
}

export function init() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(FILES_DIR, { recursive: true });

  let raw = null;
  try {
    if (fs.existsSync(STATE_FILE)) raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    console.error('[store] could not read state.json, starting fresh:', err.message);
  }
  state = sanitizeLoaded(raw);

  if (config.adminKeyEnv) {
    state.admin = makeSecret(config.adminKeyEnv);
    console.log('[admin] ADMIN_KEY from environment is active.');
  } else if (!state.admin) {
    const generated = crypto.randomBytes(24).toString('base64url');
    state.admin = makeSecret(generated);
    try {
      fs.writeFileSync(ADMIN_KEY_FILE, generated + '\n', { mode: 0o600 });
      fs.chmodSync(ADMIN_KEY_FILE, 0o600);
    } catch (err) {
      console.error('[admin] could not write ADMIN_KEY.txt:', err.message);
    }
    console.log('\n  ┌────────────────────────────────────────────────────────┐');
    console.log('  │  ADMIN KEY GENERATED — save this now                  │');
    console.log('  └────────────────────────────────────────────────────────┘');
    console.log('  ' + generated);
    console.log('  Also written to ' + ADMIN_KEY_FILE + '\n');
  }

  cleanup();
  persistSync();
}

export function getSettings() { return state.settings; }

export function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch, updatedAt: now() };
  state.settings.logRetentionDays = Math.min(10, Math.max(1, Number(state.settings.logRetentionDays) || 10));
  persist();
  return state.settings;
}

export function verifyAdmin(secret) { return verifySecret(secret, state.admin); }

export function rotateAdminKey(newKey) {
  const key = newKey || crypto.randomBytes(24).toString('base64url');
  state.admin = makeSecret(key);
  state.sessions = [];
  persist();
  return key;
}

export function createSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  const rec = { hash: sha256(token), createdAt: now(), expiresAt: now() + config.sessionTtlMs };
  state.sessions.push(rec);
  scheduleSave();
  return { token, expiresAt: rec.expiresAt };
}

export function validateSession(token) {
  if (typeof token !== 'string' || !token) return false;
  const hash = sha256(token);
  return state.sessions.some(s => s.hash === hash && s.expiresAt > now());
}

export function deleteSession(token) {
  if (typeof token !== 'string') return;
  const hash = sha256(token);
  state.sessions = state.sessions.filter(s => s.hash !== hash);
  scheduleSave();
}

export function createApiKey({ name, expiresInDays = null, rateLimitMax = null } = {}) {
  const secret = 'im_' + crypto.randomBytes(24).toString('base64url');
  const rec = {
    id: crypto.randomUUID(),
    name: String(name || 'Untitled key').slice(0, 80),
    prefix: secret.slice(0, 11),
    ...makeSecret(secret),
    createdAt: now(),
    lastUsedAt: null,
    requests: 0,
    enabled: true,
    expiresAt: expiresInDays ? now() + Number(expiresInDays) * DAY : null,
    rateLimitMax: rateLimitMax ? Number(rateLimitMax) : null,
  };
  state.apiKeys.push(rec);
  persist();
  return { record: rec, secret };
}

export function findApiKey(secret) {
  if (typeof secret !== 'string' || !secret.startsWith('im_')) return null;
  return state.apiKeys.find(k => k.enabled && (!k.expiresAt || k.expiresAt > now()) && verifySecret(secret, k)) || null;
}

export function touchApiKey(id) {
  const key = state.apiKeys.find(k => k.id === id);
  if (!key) return;
  key.requests += 1;
  key.lastUsedAt = now();
  scheduleSave();
}

export function sanitizeKey(k) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt || null,
    requests: k.requests || 0,
    enabled: !!k.enabled,
    expiresAt: k.expiresAt || null,
    rateLimitMax: k.rateLimitMax || null,
  };
}

export function listApiKeys() { return state.apiKeys.map(sanitizeKey); }

export function getApiKey(id) { return state.apiKeys.find(k => k.id === id) || null; }

export function setApiKeyEnabled(id, enabled) {
  const key = getApiKey(id);
  if (!key) return null;
  key.enabled = !!enabled;
  persist();
  return sanitizeKey(key);
}

export function deleteApiKey(id) {
  const before = state.apiKeys.length;
  state.apiKeys = state.apiKeys.filter(k => k.id !== id);
  const removed = state.apiKeys.length < before;
  if (removed) persist();
  return removed;
}

export function addLog(entry) {
  state.logs.push({
    id: crypto.randomUUID(),
    ts: now(),
    method: '', path: '', status: 0, durationMs: 0,
    ip: '', apiKeyId: null, ok: false, message: '', provider: '',
    ...entry,
  });
  if (state.logs.length > config.maxLogEntries) {
    state.logs.splice(0, state.logs.length - config.maxLogEntries);
  }
  scheduleSave();
}

export function listLogs({ limit = 50, offset = 0, status = '', q = '' } = {}) {
  let logs = state.logs;
  if (status === 'error') logs = logs.filter(l => l.status >= 400);
  else if (status === 'success') logs = logs.filter(l => l.status < 400);
  if (q) {
    const needle = String(q).toLowerCase();
    logs = logs.filter(l => [l.path, l.message, l.ip, l.apiKeyId || ''].some(v => String(v).toLowerCase().includes(needle)));
  }
  const total = logs.length;
  const items = logs.slice(-offset - limit, offset ? -offset : undefined).reverse();
  return { total, items };
}

export function clearLogs() {
  state.logs = [];
  persist();
}

export function logCount() { return state.logs.length; }

export function saveLocalFile(bytes, filename) {
  const id = crypto.randomUUID();
  const safeName = String(filename || 'image.jpg').replace(/[^a-zA-Z0-9._-]/g, '').slice(-80) || 'image.jpg';
  const filePath = path.join(FILES_DIR, id + '.jpg');
  fs.writeFileSync(filePath, bytes);
  const rec = {
    id,
    name: safeName,
    path: filePath,
    size: bytes.length,
    createdAt: now(),
    expiresAt: Number(state.settings.localFileTtlHours) === 0
      ? null
      : now() + Math.max(1, Number(state.settings.localFileTtlHours) || 24) * 3600_000,
  };
  state.files.push(rec);
  scheduleSave();
  return rec;
}

export function getLocalFile(id) { return state.files.find(f => f.id === id) || null; }

export function listFiles() {
  return state.files.map(f => ({
    id: f.id, name: f.name, size: f.size, createdAt: f.createdAt, expiresAt: f.expiresAt,
  })).sort((a, b) => b.createdAt - a.createdAt);
}

export function deleteLocalFile(id) {
  const file = getLocalFile(id);
  if (!file) return false;
  try { fs.unlinkSync(file.path); } catch { /* already gone */ }
  state.files = state.files.filter(f => f.id !== id);
  persist();
  return true;
}

export function overview() {
  const cutoff = now() - DAY;
  const apiLogs = state.logs.filter(l => l.kind !== 'admin');
  const recent = apiLogs.filter(l => l.ts >= cutoff);
  const errors = recent.filter(l => l.status >= 400).length;
  const avg = recent.length ? Math.round(recent.reduce((s, l) => s + (l.durationMs || 0), 0) / recent.length) : 0;
  const hours = Array.from({ length: 24 }, (_, i) => {
    const start = now() - (23 - i) * 3600_000;
    const label = new Date(start).toISOString().slice(11, 13) + ':00';
    const bucket = recent.filter(l => {
      const t = new Date(l.ts).toISOString().slice(11, 13) + ':00';
      return t === label;
    });
    return { label, count: bucket.length, errors: bucket.filter(l => l.status >= 400).length };
  });
  const providers = {};
  for (const l of recent) if (l.provider) providers[l.provider] = (providers[l.provider] || 0) + 1;

  return {
    requests: apiLogs.length,
    requests24h: recent.length,
    errors24h: errors,
    successRate24h: recent.length ? Math.round(((recent.length - errors) / recent.length) * 1000) / 10 : 100,
    avgDurationMs: avg,
    activeKeys: state.apiKeys.filter(k => k.enabled && (!k.expiresAt || k.expiresAt > now())).length,
    totalKeys: state.apiKeys.length,
    storedFiles: state.files.length,
    oldestLogAt: state.logs.length ? state.logs[0].ts : null,
    retentionDays: state.settings.logRetentionDays,
    hours,
    providers,
  };
}

export function cleanup() {
  if (!state) return;
  const cutoff = now() - state.settings.logRetentionDays * DAY;
  const beforeLogs = state.logs.length;
  state.logs = state.logs.filter(l => l.ts >= cutoff);
  state.sessions = state.sessions.filter(s => s.expiresAt > now());
  for (const file of [...state.files]) {
    if (file.expiresAt !== null && file.expiresAt <= now()) {
      try { fs.unlinkSync(file.path); } catch { /* already gone */ }
      state.files = state.files.filter(f => f.id !== file.id);
    }
  }
  if (state.logs.length !== beforeLogs) persist();
  else scheduleSave();
}
