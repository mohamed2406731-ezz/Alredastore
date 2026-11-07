const { readRuntimeDatabaseConfig } = require('../config/database');
const { probeDatabase } = require('../repositories/database.repository');
function safeDatabaseCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^(P\d{4}|[A-Z0-9]{5}|DATABASE_NOT_CONFIGURED)$/.test(code) ? code : 'DATABASE_CONNECTION_FAILED';
}
async function connectDatabase() {
  const config = readRuntimeDatabaseConfig();
  if (config.enabled) await probeDatabase();
  return config.enabled;
}
async function checkDatabaseReadiness() {
  const config = readRuntimeDatabaseConfig();
  if (!config.enabled) return !config.required;
  try { return await probeDatabase(); } catch { return false; }
}
module.exports = { connectDatabase, checkDatabaseReadiness, safeDatabaseCode };
