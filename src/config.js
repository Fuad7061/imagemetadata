import path from 'node:path';

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export const VERSION = '2.0.0';

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: num(process.env.PORT, 3000, 1, 65535),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data')),
  adminKeyEnv: process.env.ADMIN_KEY || '',
  publicBaseUrl: String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  maxBodyBytes: num(process.env.MAX_BODY_SIZE_MB, 15, 1, 100) * 1024 * 1024,
  logRetentionDays: Math.min(num(process.env.LOG_RETENTION_DAYS, 10, 1, 10), 10),
  trustProxy: /^(1|true|yes|on)$/i.test(process.env.TRUST_PROXY || ''),
  sessionTtlMs: num(process.env.SESSION_TTL_HOURS, 168, 1, 720) * 3600_000,
  cleanupIntervalMs: num(process.env.CLEANUP_INTERVAL_MINUTES, 60, 1, 1440) * 60_000,
  gzipThreshold: 1024,
  maxLogEntries: 5000,
};
