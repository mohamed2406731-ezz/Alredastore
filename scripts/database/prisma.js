require('dotenv').config({ quiet: true });
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { readDatabaseConfig } = require('../../src/config/database');
const actions = { validate: ['validate'], generate: ['generate'], status: ['migrate', 'status'], deploy: ['migrate', 'deploy'] };
function runPrisma(action) {
  if (!Object.hasOwn(actions, action)) throw new Error('UNSUPPORTED_PRISMA_ACTION');
  if (['status', 'deploy'].includes(action)) {
    const config = readDatabaseConfig({ ...process.env, DATABASE_REQUIRED: 'false' });
    if (!config.enabled) { console.error(JSON.stringify({ action, success: false, code: 'DATABASE_NOT_CONFIGURED' })); return 1; }
  }
  const root = path.resolve(__dirname, '../..');
  const cli = path.join(path.dirname(require.resolve('prisma/package.json')), 'build/index.js');
  const result = spawnSync(process.execPath, [cli, ...actions[action]], { cwd: root, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' }, maxBuffer: 4 * 1024 * 1024, timeout: 120000 });
  // Native CLI output can contain endpoint/database names or URLs. Never forward or save it.
  const output = String(result.stdout || '') + String(result.stderr || '');
  const code = output.match(/\bP\d{4}\b/)?.[0] || (action === 'status' && /not.*managed/i.test(output) ? 'PRISMA_BASELINE_REQUIRED'
    : result.error?.code === 'ETIMEDOUT' ? 'PRISMA_COMMAND_TIMEOUT' : 'PRISMA_COMMAND_FAILED');
  const migrationsPath = path.join(root, 'prisma/migrations');
  const localMigrations = fs.existsSync(migrationsPath) ? fs.readdirSync(migrationsPath).filter(name => fs.existsSync(path.join(migrationsPath, name, 'migration.sql'))).length : 0;
  const success = result.status === 0;
  const message = { action, success, ...(action === 'status' ? { localMigrations } : {}),
    ...(!success ? { code, ...(output.includes('models') ? { diagnostic: 'SCHEMA_HAS_NO_MODELS' } : {}) } : {}) };
  (success ? console.info : console.error)(JSON.stringify(message));
  return success ? 0 : 1;
}
if (require.main === module) {
  try { process.exitCode = runPrisma(process.argv[2]); }
  catch { console.error(JSON.stringify({ success: false, code: 'PRISMA_CONFIGURATION_INVALID' })); process.exitCode = 1; }
}
module.exports = { runPrisma };
