const { readRuntimeDatabaseConfig } = require('./database');
let instance;
const transports = new WeakMap();
function createPrismaClient(config = readRuntimeDatabaseConfig()) {
  if (!config.enabled) { const error = new Error('DATABASE_NOT_CONFIGURED'); error.code = 'DATABASE_NOT_CONFIGURED'; throw error; }
  const { PrismaClient } = require('@prisma/client');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: config.url, max: config.poolMax, connectionTimeoutMillis: config.connectTimeoutMs,
    idleTimeoutMillis: 30000, statement_timeout: 15000, enableChannelBinding: true });
  const transport = { encrypted: null, certificateVerified: null, protocol: null };
  pool.on('connect', connection => {
    const stream = connection.connection?.stream;
    transport.encrypted = stream?.encrypted === true;
    transport.certificateVerified = stream?.authorized === true;
    transport.protocol = stream?.getProtocol?.() || null;
  });
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });
  const client = new PrismaClient({ adapter, log: [], errorFormat: 'minimal' });
  transports.set(client, transport);
  return client;
}
function getPrismaClient() { instance ||= createPrismaClient(); return instance; }
async function disconnectDatabase() { if (instance) { const current = instance; instance = undefined; await current.$disconnect(); } }
function getDatabaseTransport(client) { return transports.get(client) || null; }
module.exports = { createPrismaClient, getPrismaClient, disconnectDatabase, getDatabaseTransport };
