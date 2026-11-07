const { createHash, randomBytes } = require('node:crypto');
const { getPrismaClient } = require('../config/prisma');
const { selection, variantPrice } = require('../services/purchase-selection.service');
const { activeDiscounts, effectivePrice } = require('../services/discount.service');
const { optimizedImageUrl } = require('../utils/optimizedImage');

const digest = value => createHash('sha256').update(value).digest('hex');
const cartProjection = { id: true, status: true, updated_at: true, cart_items: { select: { id: true, product_id: true, variant_id: true, product_variants: true, quantity: true, products: { select: { id: true, name: true, name_ar: true, price_egp: true, sale_price_egp: true, image_url: true, stock_quantity: true, is_available: true, source_id: true, category_id: true, catalog_details: true, product_categories: { select: { category_id: true } } } } } } };

function createCartRepository(clientProvider = getPrismaClient) {
  const db = () => clientProvider();
  async function hydrate(tx, cart) {
    if (!cart.cart_items.length) return cart;
    const rules = await activeDiscounts(tx);
    for (const item of cart.cart_items) {
      item.products.image_url = optimizedImageUrl(item.products.image_url, 'thumbnail');
      item.products.sale_price_egp = item.product_variants ? variantPrice(item.products, item.product_variants, rules) : effectivePrice(item.products, rules);
      if (item.product_variants) {
        item.products.name += ' - ' + item.product_variants.title;
        item.products.name_ar += ' - ' + (item.product_variants.title_ar || item.product_variants.title);
      }
    }
    return cart;
  }
  async function resolve(tx, userId, guestHash) {
    if (userId) {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`user-cart:${userId}`}, 0))::text`;
      let cart = await tx.shopping_carts.findFirst({ where: { user_id: userId, status: 'ACTIVE' }, select: { id: true } });
      if (!cart) cart = await tx.shopping_carts.create({ data: { user_id: userId }, select: { id: true } });
      return cart;
    }
    if (!guestHash) throw new Error('GUEST_CART_TOKEN_REQUIRED');
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`guest-cart:${guestHash}`}, 0))::text`;
    let cart = await tx.shopping_carts.findUnique({ where: { guest_token_hash: guestHash }, select: { id: true, status: true } });
    if (!cart || cart.status !== 'ACTIVE') cart = await tx.shopping_carts.create({ data: { guest_token_hash: guestHash }, select: { id: true } });
    return cart;
  }
  return {
    newGuestToken() { return randomBytes(32).toString('base64url'); },
    hashGuestToken: digest,
    async get({ userId, guestToken }) {
      if (!userId && !guestToken) return { cart_items: [] };
      // Reads neither create empty carts nor acquire transaction/advisory locks.
      // Mutations still use resolve() inside their existing transactions.
      const client = db();
      const cart = await client.shopping_carts.findFirst({ where: {
        ...(userId ? { user_id: userId } : { guest_token_hash: digest(guestToken) }), status: 'ACTIVE',
      }, select: cartProjection });
      return cart ? hydrate(client, cart) : { cart_items: [] };
    },
    async add({ userId, guestToken, productId, variantId, quantity }) {
      return db().$transaction(async tx => {
        const cart = await resolve(tx, userId, guestToken ? digest(guestToken) : '');
        await selection(tx, productId, variantId, 1);
        const current = await tx.cart_items.findFirst({ where: { cart_id: cart.id, product_id: productId, variant_id: variantId || null }, select: { id: true, quantity: true } });
        const next = (current?.quantity || 0) + quantity;
        if (next > 99) throw new Error('CART_QUANTITY_LIMIT');
        const inventory = variantId
          ? await tx.product_variants.findFirst({ where: { id: variantId, product_id: productId }, select: { stock_quantity: true } })
          : await tx.products.findUnique({ where: { id: productId }, select: { stock_quantity: true } });
        if (inventory?.stock_quantity == null || next > inventory.stock_quantity) throw new Error('INSUFFICIENT_INVENTORY');
        if (current) await tx.cart_items.update({ where: { id: current.id }, data: { quantity: next, updated_at: new Date() } });
        else await tx.cart_items.create({ data: { cart_id: cart.id, product_id: productId, variant_id: variantId || null, quantity } });
        await tx.shopping_carts.update({ where: { id: cart.id }, data: { updated_at: new Date() } });
        const reminder = await tx.cart_reminders.findUnique({ where: { cart_id: cart.id }, select: { id: true } });
        if (reminder) {
          await tx.notification_outbox.deleteMany({ where: { reminder_id: reminder.id, status: 'PENDING' } });
          await tx.cart_reminders.delete({ where: { id: reminder.id } });
        }
        return hydrate(tx, await tx.shopping_carts.findUnique({ where: { id: cart.id }, select: cartProjection }));
      });
    },
    async remove({ userId, guestToken, productId, variantId }) {
      return db().$transaction(async tx => {
        const cart = await resolve(tx, userId, guestToken ? digest(guestToken) : '');
        await tx.cart_items.deleteMany({ where: { cart_id: cart.id, product_id: productId, variant_id: variantId || null } });
        await tx.shopping_carts.update({ where: { id: cart.id }, data: { updated_at: new Date() } });
        const reminder = await tx.cart_reminders.findUnique({ where: { cart_id: cart.id }, select: { id: true } });
        if (reminder) {
          await tx.notification_outbox.deleteMany({ where: { reminder_id: reminder.id, status: 'PENDING' } });
          await tx.cart_reminders.delete({ where: { id: reminder.id } });
        }
        return hydrate(tx, await tx.shopping_carts.findUnique({ where: { id: cart.id }, select: cartProjection }));
      });
    },
    async mergeGuest(userId, guestToken) {
      if (!guestToken) return;
      return db().$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`guest-cart:${digest(guestToken)}`}, 0))::text`;
        const guest = await tx.shopping_carts.findUnique({ where: { guest_token_hash: digest(guestToken) }, select: { id: true, status: true, cart_items: { select: { product_id: true, variant_id: true, quantity: true } } } });
        if (!guest || guest.status !== 'ACTIVE') return;
        const owner = await resolve(tx, userId, '');
        for (const item of guest.cart_items) {
          try { await selection(tx, item.product_id, item.variant_id, 1); } catch { continue; }
          const prior = await tx.cart_items.findFirst({ where: { cart_id: owner.id, product_id: item.product_id, variant_id: item.variant_id }, select: { id: true, quantity: true } });
          const merged = Math.min(99, (prior?.quantity || 0) + item.quantity);
          if (prior) await tx.cart_items.update({ where: { id: prior.id }, data: { quantity: merged, updated_at: new Date() } });
          else await tx.cart_items.create({ data: { cart_id: owner.id, product_id: item.product_id, variant_id: item.variant_id, quantity: merged } });
        }
        await tx.shopping_carts.delete({ where: { id: guest.id } });
      });
    },
  };
}

module.exports = { createCartRepository };
