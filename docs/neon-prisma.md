# Neon / Prisma verification and Northflank deployment

## Current catalog state - 2026-11-02

The catalog/media migration is applied and the storefront now reads the catalog from PostgreSQL when `DATABASE_URL` is configured. Read-only verification reports 23 application tables, two applied Prisma migrations, 237 products, 28 categories, 1,074 variants, 263 product/collection links, and 898 product images. All product main/gallery links are Cloudinary HTTPS URLs; PostgreSQL has no binary image columns. Inventory quantities remain unset (`NULL`), and the order table is empty. The earlier verification below describes the database before this catalog import.

The image importer is resumable and performs no deletes. Product catalog reads use a short in-memory cache. Checkout remains disabled until authentication, real stock, shipping rates and origin have been configured.

## Later order-workflow changes

The local `DATABASE_URL` was changed to a new, empty Neon database. The initial Prisma migration below has been applied to that target. The previously inspected Knex-managed database was not the target of this migration. `/admin` still requires verified administrator identity and default checkout remains disabled. See [order workflow](order-workflow.md) for current activation requirements.

## Verified result

The application connects to the newly configured Neon PostgreSQL database through Prisma. A read-only check confirmed the target had zero public tables before migration. The reviewed initial migration created the application schema without resetting or overwriting records; no catalog data or seed data was added.

- Installed matching Prisma CLI, client and PostgreSQL adapter 7.10.1, with pg 8.23.1; verified under Node 24.13.1. The CommonJS application and MVC/service/repository boundaries are preserved.
- Corrected the existing bare connection URL line in the private local `.env` into a `DATABASE_URL` assignment without exposing its value. No credentials were added to source or documentation.
- Prisma CLI, client and PostgreSQL adapter are pinned to 7.10.1, with pg 8.23.1; schema validation passes under Node 24.13.1.
- Read-only connectivity check passed against PostgreSQL 18.6. The client transport reported TLS 1.3, encryption and a verified server certificate.
- Added `prisma/migrations/20261102000000_initial_schema/migration.sql` for the 20 application tables, including the PostgreSQL CHECK constraints Prisma does not model. `prisma migrate deploy` applied it; `db:status` reports one local migration applied and no incomplete migrations. A read-only schema diff reports no drift.
- The current database contains no catalog or customer data. This schema installation does not import products or media.
- Production-mode Node startup passed: homepage, liveness and readiness all returned HTTP 200, with 18 homepage collections and no observed stderr.
- Lint passed; 398 unit/integration tests and all 22 browser tests passed. Browser tests do not connect to real Neon or Cloudinary accounts.

The database already contains commerce/delivery tables and differs from the proposed future catalog design. The storefront continues reading the imported local catalog. This task does not import products, replace existing data, implement accounts or add Cloudinary media associations.

## Configuration and code

`src/config/database.js` validates URLs with Zod, rejects explicitly insecure remote TLS modes, enforces certificate verification in memory and bounds pool settings. Defaults: pool maximum 5, connection timeout 15000ms. Production requires `DATABASE_URL` unless explicitly overridden; leave that requirement enabled on Northflank. Runtime queries use Neon’s pooled `DATABASE_URL`; Prisma CLI uses `DATABASE_URL_UNPOOLED` when present, or the compatible `DIRECT_URL` alias, and validates that it targets the same database. No direct endpoint is guessed or saved.

`src/config/prisma.js` owns a lazy Prisma client using `@prisma/adapter-pg`, a bounded pg pool and driver cleanup on disconnect. `src/repositories/database.repository.js` contains fixed tagged SQL probes and a read-only metadata transaction. `src/services/database.service.js` owns readiness/startup checks and sanitized error codes. The server checks connectivity before listening and disconnects during shutdown. Health responses expose no database details.

Use these wrappers; native Prisma CLI output can reveal endpoint names, so wrapper output deliberately reports only safe status codes:

```sh
npm run db:validate
npm run db:generate
npm run db:check
npm run db:status
```

`db:check` reads table counts, server version and transport metadata, not customer records. `db:status` now succeeds for the current target. The CLI wrappers never save raw provider/CLI output. `.env` and private introspection staging under `data/database/` remain ignored.

## Migration decision

The initial migration is intended only for the currently configured, newly created empty Neon database. Do not point this initial migration at the previously inspected Knex-managed database; it has existing tables and requires a separate baseline/reconciliation first. Keep Northflank's runtime `DATABASE_URL` pointed at the intended target.

The migration SQL was reviewed and its generated tables and constraints match the current Prisma schema (`migrate diff` clean). The isolated PostgreSQL integration test applies the schema, drops only its temporary test schema, then reapplies it; this passed. The restricted runner's `uv_os_get_passwd ENOMEM` and teardown access issue were handled in the local test harness without changing application runtime behavior. The migration was applied to the authorized empty Neon target, whose post-apply checks show one completed migration and no schema drift. No reset or rollback was run on Neon. If recovery is needed before the database contains user data, use a Neon branch/restore point or carefully remove only objects created by this initial migration after verifying ownership; do not use `migrate reset` on a database with data.

The current target is ready for application connections, but product/catalog import and production checkout activation remain separate work. Do not treat this empty schema as having imported products or real orders.

## Northflank configuration

The supplied multi-stage `Dockerfile` generates the client without secrets, prunes development dependencies and runs Node 24 as a non-root user. `.dockerignore` excludes local environment files, private import/journal data and development artifacts. Local catalog data and photos under `src` are included. There is no migration command in build or startup.

1. Build with the repository Dockerfile. Alternatively, a Node 24 buildpack must install development dependencies before `npm run build` so Prisma CLI is available, then use `npm start` at runtime.
2. Inject `DATABASE_URL` as a **runtime secret** in Northflank. Do not commit `.env` or pass production credentials as Docker build arguments. Preserve required contact/media runtime configuration separately where those features are enabled.
3. Set `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3000`; expose an HTTP port matching that value and enable the Northflank HTTPS endpoint. Do not copy the local loopback HOST setting into the deployment.
4. Configure liveness `/health/live` and readiness `/health/ready`. Allow startup time for Neon wake-up. Readiness returns 503 when the database is unavailable; do not use that condition alone to restart a healthy process continuously.
5. Ensure outbound network access to Neon is allowed and any Neon network restrictions include the deployment. Keep certificate verification enabled. Tune pool maximum against total replicas and database connection limits.
6. Deploy and verify both health endpoints, storefront images and shutdown behavior in Northflank.

Docker CLI is unavailable locally, so an actual Linux image build/run was not verified. No Northflank deployment or account configuration was performed. Production-mode startup was tested locally on Windows; Linux signal handling remains to be verified in the container.

## Review and remaining work

Reviewed schema/configuration, secret handling, fixed SQL, error output, startup/shutdown, dependency version matching and deployment inputs. There is no Git repository/baseline in this workspace, so files were reviewed directly rather than via a Git diff. No commit was made.

Remaining: actual Docker/Northflank build and deployment, runtime secret injection and deployed health checks; verify migration apply/rollback/reapply on a disposable local PostgreSQL instance when its startup issue is resolved; separate catalog/media persistence mapping if requested later.

References: [Prisma 7 migration guidance](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7), [Prisma generators](https://www.prisma.io/docs/orm/v7/prisma-schema/overview/generators), [Northflank Dockerfile builds](https://northflank.com/docs/v1/application/build/build-with-a-dockerfile), [runtime variables](https://northflank.com/docs/v1/application/run/inject-runtime-variables), [exposing application ports](https://northflank.com/docs/v1/application/network/expose-your-application).
