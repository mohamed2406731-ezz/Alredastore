require('dotenv').config({ quiet: true });
const { getPrismaClient, disconnectDatabase } = require('../../src/config/prisma');
const { readAuthConfig } = require('../../src/config/auth');
const { readCheckoutPolicy } = require('../../src/config/checkout');
const { createOrderRepository } = require('../../src/repositories/order.repository');
async function main() {
  const auth = readAuthConfig(), checkout = readCheckoutPolicy(process.env, { databaseShipping: true });
  const result = await getPrismaClient().$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const tables = await tx.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    const names = ['shopping_carts', 'cart_items', 'customer_sessions', 'auth_rate_limits', 'notification_outbox'];
    const cartSchemaApplied = names.every(name => tables.some(table => table.table_name === name));
    const purchasable = await createOrderRepository(() => tx).products();
    const delivery = await createOrderRepository(() => tx).shippingRates(checkout.shippingRates);
    const columns = await tx.$queryRaw`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'variant_id' AND table_name IN ('cart_items', 'order_items')`;
    const adminCount = await tx.users.count({ where: { is_active: true, OR: [{ role: 'admin' }, { user_roles: { some: { role: 'admin' } } }] } });
    return { connected: true, cartSchemaApplied, purchasableProducts: purchasable.length,
      approvedShippingRatesConfigured: Object.keys(delivery.rates).length > 0, enabledDeliveryAreas: Object.keys(delivery.rates).length, variantCheckoutSupported: columns.length === 2, administratorConfigured: adminCount > 0 };
  });
  const checks = { ...result, googleCredentialsPresent: auth.enabled, checkoutEnabled: checkout.enabled };
  checks.checkoutPrerequisitesMet = checks.cartSchemaApplied && checks.purchasableProducts > 0 && checks.administratorConfigured && checks.googleCredentialsPresent && checks.approvedShippingRatesConfigured && checks.checkoutEnabled;
  console.info(JSON.stringify(checks));
  if (!checks.checkoutPrerequisitesMet) process.exitCode = 1;
}
main().catch(() => { console.error(JSON.stringify({ shoppingCheckFailed: true, code: 'CHECK_DATABASE_AND_CONFIGURATION' })); process.exitCode = 1; }).finally(disconnectDatabase);
