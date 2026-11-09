const { getPrismaClient } = require('../config/prisma');
const { randomUUID } = require('node:crypto');
const { OrderError } = require('../validators/order.validator');
const { adminPermissions } = require('../services/admin-access.service');
const { activeDiscounts, effectivePrice } = require('../services/discount.service');
const { selection, variantPrice } = require('../services/purchase-selection.service');
const { invalidateDatabaseCatalog } = require('../services/catalog.repository');
// One projection is used for admin listing, admin detail and post-commit verification.
const orderSelect = {
  id: true, order_number: true, user_id: true, customer_name: true, customer_phone: true, address_snapshot: true,
  status: true, payment_method: true, payment_status: true, subtotal_egp: true, delivery_fee_egp: true, total_egp: true,
  notes: true, created_at: true,
  order_items: { select: { product_id: true, variant_id: true, options: true, product_name_ar: true, product_name: true, quantity: true, unit_price_egp: true, line_total_egp: true } },
};
function createOrderRepository(clientProvider = getPrismaClient) {
  const db = () => clientProvider();
  async function withProof(order) {
    if (order?.payment_method === 'INSTAPAY') order.payment_proof = await db().payment_proofs.findUnique({ where: { order_id: order.id }, select: { id: true, status: true } });
    return order;
  }
  return {
    async canUploadProof(userId) { return await db().payment_proofs.count({ where: { user_id: userId, created_at: { gt: new Date(Date.now()-3600000) } } }) < 8; },
    async createProof(userId, asset) {
      try { return await db().payment_proofs.create({ data: { ...asset, user_id: userId, expires_at: new Date(Date.now()+86400000) } }); }
      catch (error) {
        if (error.code !== 'P2002') throw error;
        const existing = await db().payment_proofs.findUnique({ where: { content_hash: asset.content_hash } });
        if (existing?.user_id === userId && existing.status === 'UPLOADED' && existing.expires_at > new Date()) return existing;
        throw new OrderError('PAYMENT_PROOF_ALREADY_USED', 409);
      }
    },
    async proofForAdmin(orderId) { return db().payment_proofs.findUnique({ where: { order_id: orderId } }); },
    async dashboard(permissions) {
      const canOrders = permissions.includes('orders');
      const canCatalog = permissions.includes('catalog');
      const canRoles = permissions.includes('roles');
      const client = db();
      const jobs = [];
      const keys = [];
      const add = (key, query) => { keys.push(key); jobs.push(query); };
      if (canCatalog) {
        add('products', client.products.count()); add('categories', client.categories.count({ where: { is_active: true } }));
        add('discounts', client.discount_rules.count({ where: { is_active: true, starts_at: { lte: new Date() }, ends_at: { gt: new Date() } } }));
      }
      if (canOrders) {
        add('orders', client.orders.count());
        add('pending', client.orders.count({ where: { status: { in: ['PLACED', 'CONFIRMED', 'PROCESSING'] } } }));
      }
      if (canRoles) add('team', client.admin_access_grants.count({ where: { is_active: true } }));
      const values = await Promise.all(jobs);
      const stats = Object.fromEntries(keys.map((key, index) => [key, values[index]]));
      const latestOrders = canOrders ? await client.orders.findMany({ orderBy: { created_at: 'desc' }, take: 6,
        select: { id: true, order_number: true, customer_name: true, status: true, total_egp: true, created_at: true } }) : [];

      return { stats, latestOrders };
    },
    async shippingRates(fallback) { return require('./store-settings.repository').readDelivery(db(), fallback); },
    storeSettings() { return require('./store-settings.repository').createStoreSettingsRepository(clientProvider); },
    async principal(id) {
      const user = await db().users.findFirst({ where: { id, is_active: true }, select: { id: true, email: true, google_id: true, role: true, user_roles: { select: { role: true } } } });
      return user ? { ...user, admin_permissions: await adminPermissions(db(), user) } : null;
    },
    async products() {
      const rows = await db().products.findMany({ where: { is_available: true, product_options: { none: {} } },
        select: { id: true, source_id: true, name: true, price_egp: true, sale_price_egp: true, stock_quantity: true, category_id: true, catalog_details: true, product_categories: { select: { category_id: true } }, product_variants: { take: 2 } }, orderBy: { name: 'asc' }, take: 500 });
      const rules = await activeDiscounts(db());
      return rows.filter(product => !product.catalog_details?.presentation?.archivedAt && product.product_variants.length <= 1 && (!product.product_variants.length || product.product_variants[0].is_available)).map(product => {
        const result = { ...product };
        const variant = product.product_variants[0];
        if (variant) { result.variant_id = variant.id; result.stock_quantity = variant.stock_quantity; }
        result.sale_price_egp = variant ? variantPrice(product, variant, rules) : effectivePrice(product, rules);
        delete result.product_variants;
        return result;
      });
    },
    async findRequest(userId, key) { return db().order_requests.findUnique({ where: { user_id_request_key: { user_id: userId, request_key: key } } }); },
    async getAdminOrder(id) { return withProof(await db().orders.findUnique({ where: { id }, select: orderSelect })); },
    async listCustomerOrders(userId, page) {
      return db().orders.findMany({ where: { user_id: userId }, select: orderSelect,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }], skip: (page - 1) * 20, take: 21 });
    },
    async getCustomerOrder(userId, id) {
      return db().orders.findFirst({ where: { id, user_id: userId }, select: orderSelect });
    },
    async latestCustomerOrder(userId) {
      return db().orders.findFirst({ where: { user_id: userId },
        select: { customer_name: true, customer_phone: true, address_snapshot: true },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }] });
    },
    async listAdminOrders(cursor, filters = {}) {
      const where = {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.payment ? { payment_status: filters.payment } : {}),
        ...(filters.method ? { payment_method: filters.method } : {}),
        ...(filters.q ? { OR: ['order_number', 'customer_name', 'customer_phone'].map(field => ({ [field]: { contains: filters.q, mode: 'insensitive' } })) } : {}),
      };
      const rows = await db().orders.findMany({ where, select: orderSelect, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 51,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      return Promise.all(rows.map(withProof));
    },
    async newAdminOrdersSince(since) {
      return db().orders.findMany({
        where: { created_at: { gt: since } },
        select: { id: true, order_number: true, created_at: true },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        take: 20,
      });
    },
    async create({ userId, key, hash, input, shippingFee }) {
      const savedId = await db().$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL synchronous_commit = on`;
        // Transaction-scoped lock serializes the same key across processes, including ambiguous retries.
        // READ COMMITTED ensures the request lookup sees a preceding lock holder's commit.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${key}`}, 0))::text`;
        const existing = await tx.order_requests.findUnique({ where: { user_id_request_key: { user_id: userId, request_key: key } } });
        if (existing) { if (existing.request_hash !== hash) throw new OrderError('IDEMPOTENCY_CONFLICT'); return existing.order_id; }
        const user = await tx.users.findFirst({ where: { id: userId, is_active: true }, select: { id: true } });
        if (!user) throw new OrderError('AUTHENTICATION_REQUIRED', 401);
        if (input.paymentMethod === 'INSTAPAY') {
          const proof = await tx.payment_proofs.findFirst({ where: { id: input.paymentProofId, user_id: userId, order_id: null, status: 'UPLOADED', expires_at: { gt: new Date() } } });
          if (!proof) throw new OrderError('PAYMENT_PROOF_REQUIRED', 400);
        }
        let subtotal = 0;
        const lines = [];
        const rules = await activeDiscounts(tx);
        for (const item of input.items) {
          let chosen;
          try { chosen = await selection(tx, item.productId, item.variantId, item.quantity, rules); }
          catch (error) { throw new OrderError(['PRODUCT_UNAVAILABLE','INSUFFICIENT_INVENTORY','PRODUCT_OPTIONS_REQUIRED','PRICE_CHANGED'].includes(error.message) ? error.message : 'ORDER_SELECTION_UNAVAILABLE'); }
          const { product, variant, price } = chosen;
          if (price !== item.unitPriceEgp) throw new OrderError('PRICE_CHANGED');
          const lineTotal = price * item.quantity;
          subtotal += lineTotal;
          if (!Number.isSafeInteger(subtotal) || subtotal + shippingFee > 100000000) throw new OrderError('INVALID_TOTAL', 400);
          lines.push({ product_id: product.id, variant_id: variant?.id || null, options: variant?.options || '[]', product_name: (product.name + (variant ? ' - ' + variant.title : '')).slice(0,120), product_name_ar: (product.name_ar + (variant ? ' - ' + (variant.title_ar || variant.title) : '')).slice(0,160), quantity: item.quantity, unit_price_egp: price, line_total_egp: lineTotal });
        }
        if (input.expectedTotalEgp !== subtotal + shippingFee) throw new OrderError('PRICE_CHANGED');
        const order = await tx.orders.create({ data: {
          order_number: `AS-${randomUUID().replaceAll('-', '').slice(0, 20)}`, user_id: userId,
          customer_name: input.customer.name, customer_phone: input.customer.phone,
          address_snapshot: JSON.stringify({ ...input.shipping, email: input.customer.email }), notes: input.notes,
          status: 'PLACED', fulfillment_type: 'DELIVERY', payment_method: input.paymentMethod, payment_status: 'UNPAID',
          subtotal_egp: subtotal, delivery_fee_egp: shippingFee, total_egp: subtotal + shippingFee,
          order_items: { create: lines }, order_events: { create: { status: 'PLACED', note: 'Order recorded; payment unconfirmed.' } },
          order_requests: { create: { user_id: userId, request_key: key, request_hash: hash } },
        }, select: { id: true, order_number: true } });
        if (input.paymentMethod === 'INSTAPAY') {
          const claimed = await tx.payment_proofs.updateMany({ where: { id: input.paymentProofId, user_id: userId, order_id: null, status: 'UPLOADED', expires_at: { gt: new Date() } }, data: { order_id: order.id, status: 'PENDING' } });
          if (claimed.count !== 1) throw new OrderError('PAYMENT_PROOF_ALREADY_USED', 409);
        }
        await tx.notification_outbox.create({ data: { user_id: userId, order_id: order.id, event_type: 'ORDER_PLACED', dedupe_key: `${order.id}:ORDER_PLACED`,
          payload: { orderId: order.id, reference: order.order_number } } });
        const reminders = await tx.cart_reminders.findMany({ where: { carts: { is: { user_id: userId, status: 'ACTIVE' } }, status: 'SCHEDULED' }, select: { id: true } });
        if (reminders.length) {
          await tx.notification_outbox.deleteMany({ where: { reminder_id: { in: reminders.map(item => item.id) }, status: 'PENDING' } });
          await tx.cart_reminders.deleteMany({ where: { id: { in: reminders.map(item => item.id) } } });
        }
        await tx.cart_items.deleteMany({ where: { carts: { is: { user_id: userId, status: 'ACTIVE' } }, OR: input.items.map(item => ({ product_id: item.productId, variant_id: item.variantId || null })) } });
        await tx.shopping_carts.updateMany({ where: { user_id: userId, status: 'ACTIVE' }, data: { updated_at: new Date() } });
        return order.id;
      }, { isolationLevel: 'ReadCommitted', maxWait: 10000, timeout: 20000 });
      invalidateDatabaseCatalog();
      return savedId;
    },
    async settle(event) {
      return db().$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL synchronous_commit = on`;
        await tx.$queryRaw`SELECT id FROM public.orders WHERE id = ${event.orderId}::uuid FOR UPDATE`;
        const order = await tx.orders.findUnique({ where: { id: event.orderId } });
        if (!order || order.payment_method !== 'ONLINE' || order.status === 'CANCELLED' || order.total_egp !== event.amountEgp) throw new OrderError('PAYMENT_MISMATCH');
        const existing = await tx.payment_receipts.findUnique({ where: { order_id: order.id } });
        if (existing) {
          if (existing.provider !== event.provider || existing.payment_reference !== event.paymentReference || existing.amount_egp !== event.amountEgp) throw new OrderError('PAYMENT_CONFLICT');
          return order.id;
        }
        if (order.payment_status === 'PAID') throw new OrderError('PAYMENT_CONFLICT');
        await tx.payment_receipts.create({ data: { order_id: order.id, provider: event.provider, event_id: event.eventId, payment_reference: event.paymentReference, amount_egp: event.amountEgp, currency: event.currency } });
        await tx.orders.update({ where: { id: order.id }, data: { payment_status: 'PAID', paid_at: new Date(), payment_provider_reference: `${event.provider}:${event.paymentReference}`,
          amount_received_egp: event.amountEgp, change_due_egp: 0, updated_at: new Date() } });
        await tx.order_events.create({ data: { order_id: order.id, status: order.status, note: 'Payment verified by trusted provider.' } });
        return order.id;
      });
    },
    async updateStatus(orderId, status, actorId) {
      const saved = await db().$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL synchronous_commit = on`;
        await tx.$queryRaw`SELECT id FROM public.orders WHERE id = ${orderId}::uuid FOR UPDATE`;
        const order = await tx.orders.findUnique({ where: { id: orderId }, select: { id: true, user_id: true, status: true, order_number: true, payment_status: true, payment_method: true, order_items: { select: { product_id: true, variant_id: true, quantity: true } } } });
        if (!order) throw new OrderError('ORDER_NOT_FOUND', 404);
        if (order.status === status) return { ...order, changed: false };
        if (order.payment_method === 'INSTAPAY' && order.payment_status !== 'PAID' && status !== 'CANCELLED') throw new OrderError('PAYMENT_REVIEW_REQUIRED', 409);
        if (status === 'CANCELLED' && order.payment_status === 'PAID') throw new OrderError('PAID_ORDER_REFUND_REQUIRED', 409);
        if (order.status === 'DELIVERED' || order.status === 'CANCELLED' || !({ PLACED: ['CONFIRMED', 'PROCESSING', 'CANCELLED'], CONFIRMED: ['PROCESSING', 'CANCELLED'], PROCESSING: ['SHIPPED', 'CANCELLED'], SHIPPED: ['DELIVERED'] }[order.status] || []).includes(status)) throw new OrderError('INVALID_STATUS_TRANSITION', 409);
        await tx.orders.update({ where: { id: order.id }, data: { status, updated_at: new Date() } });
        await tx.order_events.create({ data: { order_id: order.id, actor_id: actorId, status, note: `Administrator changed status to ${status}.` } });
        if (order.user_id) await tx.notification_outbox.create({ data: { user_id: order.user_id, order_id: order.id, event_type: 'ORDER_STATUS', dedupe_key: `${order.id}:ORDER_STATUS:${status}`,
          payload: { orderId: order.id, reference: order.order_number, status } } });
        return { ...order, status, changed: true };
      });
      invalidateDatabaseCatalog();
      return saved;
    },
    async reviewProof(orderId, actorId, decision, reference) {
      reference = typeof reference === 'string' ? reference.trim().toUpperCase() : '';
      try {
        const result = await db().$transaction(async tx => {
          const actor = await tx.users.findFirst({ where: { id: actorId, is_active: true }, include: { user_roles: true } });
          if (!actor || !(await adminPermissions(tx, actor)).includes('orders')) throw new OrderError('ADMIN_REQUIRED', 403);
          await tx.$queryRaw`SELECT id FROM orders WHERE id=${orderId}::uuid FOR UPDATE`;
          const order = await tx.orders.findUnique({ where: { id: orderId }, include: { order_items: true } });
          const proof = await tx.payment_proofs.findUnique({ where: { order_id: orderId } });
          if (!order || order.payment_method !== 'INSTAPAY' || !proof) throw new OrderError('PAYMENT_PROOF_NOT_FOUND', 404);
          if (decision === 'APPROVE' && proof.status === 'APPROVED' && proof.transfer_reference === reference) return { id: order.id, changed: false };
          if (decision === 'REJECT' && proof.status === 'REJECTED') return { id: order.id, changed: false };
          if (proof.status !== 'PENDING' || order.status === 'CANCELLED' || order.payment_status === 'PAID') throw new OrderError('PAYMENT_REVIEW_CONFLICT', 409);
          await tx.payment_proofs.update({ where: { id: proof.id }, data: { status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', reviewed_by: actorId, reviewed_at: new Date(), transfer_reference: decision === 'APPROVE' ? reference : null } });
          const status = decision === 'APPROVE' ? 'CONFIRMED' : 'CANCELLED';
          await tx.orders.update({ where: { id: orderId }, data: { status, updated_at: new Date(), ...(decision === 'APPROVE' ? { payment_status: 'PAID', paid_by: actorId, paid_at: new Date(), amount_received_egp: order.total_egp, change_due_egp: 0, payment_provider_reference: `instapay:${reference}` } : {}) } });
          await tx.order_events.create({ data: { order_id: orderId, actor_id: actorId, status, note: decision === 'APPROVE' ? 'Administrator verified InstaPay funds and approved proof.' : 'Administrator rejected the InstaPay proof.' } });
          await tx.admin_audit_events.create({ data: { actor_id: actorId, action: `INSTAPAY_${decision}`, target_id: orderId } });
          if (order.user_id) await tx.notification_outbox.create({ data: { user_id: order.user_id, order_id: orderId, event_type: 'ORDER_STATUS', dedupe_key: `${orderId}:INSTAPAY:${decision}`, payload: { orderId, reference: order.order_number, status } } });
          return { id: order.id, changed: true };
        }, { maxWait: 10000, timeout: 20000 });
        invalidateDatabaseCatalog(); return result;
      } catch (error) { if (error.code === 'P2002') throw new OrderError('PAYMENT_REFERENCE_USED', 409); throw error; }
    },
  };
}
module.exports = { createOrderRepository, orderSelect };
