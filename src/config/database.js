const { z } = require('zod');
const urlField = z.string().trim().default('').superRefine((value, ctx) => {
  if (!value) return;
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2 || !url.username || !url.password) throw new Error();
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['disable', 'allow', 'prefer'].includes(url.searchParams.get('sslmode'))) throw new Error();
  } catch { ctx.addIssue({ code: 'custom', message: 'Valid PostgreSQL URL with TLS is required' }); }
});
const schema = z.object({ DATABASE_URL: urlField, DIRECT_URL: urlField, DATABASE_URL_UNPOOLED: urlField,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
  DATABASE_REQUIRED: z.enum(['true', 'false']).optional(), NODE_ENV: z.string().optional(),
}).superRefine((value, ctx) => {
  if ((value.DATABASE_REQUIRED === 'true' || (value.DATABASE_REQUIRED === undefined && value.NODE_ENV === 'production')) && !value.DATABASE_URL) ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'Required' });
  for (const [name, candidate] of [['DIRECT_URL', value.DIRECT_URL], ['DATABASE_URL_UNPOOLED', value.DATABASE_URL_UNPOOLED]]) {
    if (candidate && !value.DATABASE_URL) ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: `Required with ${name}` });
    if (candidate && value.DATABASE_URL) {
      try {
        const runtime = new URL(value.DATABASE_URL); const direct = new URL(candidate);
        if (runtime.pathname !== direct.pathname || runtime.hostname.replace('-pooler.', '.') !== direct.hostname.replace('-pooler.', '.')) ctx.addIssue({ code: 'custom', path: [name], message: 'Must target the same database' });
      } catch { /* URL fields report their own errors without exposing values. */ }
    }
  }
});
function verifiedTls(value) {
  if (!value) return '';
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.searchParams.set('sslmode', 'verify-full');
  return url.href;
}
function readDatabaseConfig(source = process.env) {
  const normalized = { ...source, ...(typeof source.DATABASE_REQUIRED === 'string' ? { DATABASE_REQUIRED: source.DATABASE_REQUIRED.toLowerCase() } : {}) };
  const result = schema.safeParse(normalized);
  if (!result.success) throw new Error(`Invalid database configuration: ${[...new Set(result.error.issues.map(issue => issue.path.join('.')))].join(', ')}`);
  const value = result.data;
  return Object.freeze({ enabled: Boolean(value.DATABASE_URL), required: value.DATABASE_REQUIRED === 'true' || (value.DATABASE_REQUIRED === undefined && value.NODE_ENV === 'production'),
    url: verifiedTls(value.DATABASE_URL), migrationUrl: verifiedTls(value.DATABASE_URL_UNPOOLED || value.DIRECT_URL || value.DATABASE_URL),
    poolMax: value.DATABASE_POOL_MAX, connectTimeoutMs: value.DATABASE_CONNECT_TIMEOUT_MS });
}
// Runtime connections use only DATABASE_URL. The direct URL is validated by migration commands.
function readRuntimeDatabaseConfig(source = process.env) {
  return readDatabaseConfig({ ...source, DIRECT_URL: '', DATABASE_URL_UNPOOLED: '' });
}
module.exports = { readDatabaseConfig, readRuntimeDatabaseConfig };
