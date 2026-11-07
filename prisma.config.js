require('dotenv').config({ quiet: true });
const { defineConfig } = require('prisma/config');
// Prisma Client generation and schema validation do not need database credentials.
// Runtime DB commands validate and select the migration URL in scripts/database/prisma.js.
const migrationUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DIRECT_URL || process.env.DATABASE_URL;
module.exports = defineConfig({ schema: 'prisma/schema.prisma', migrations: { path: 'prisma/migrations' },
  ...(migrationUrl ? { datasource: { url: migrationUrl } } : {}),
});
