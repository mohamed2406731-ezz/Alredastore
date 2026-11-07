const { z } = require('zod');
const { whatsappSchema } = require('./whatsapp');
const { readCloudinaryConfig } = require('./cloudinary');
const { readRuntimeDatabaseConfig } = require('./database');

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(666),
}).extend(whatsappSchema.shape);

function readEnvironment(source = process.env) {
  readCloudinaryConfig(source); // Validate optional/partial media configuration without returning secrets.
  readRuntimeDatabaseConfig(source);
  const result = environmentSchema.safeParse(source);
  if (!result.success) {
    // Report names only: environment values may contain secrets.
    throw new Error(`Invalid environment configuration: ${result.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  }
  if (result.data.NODE_ENV === 'production' && !source.HOST) result.data.HOST = '0.0.0.0';
  return Object.freeze(result.data);
}

module.exports = { readEnvironment };
