const { Router } = require('express');
const { z } = require('zod');
const { createCartRepository } = require('../repositories/cart.repository');
const { readCookie } = require('../middleware/customer-session.middleware');
const { sameOrigin } = require('./auth.routes');

const addSchema = z.object({ productId: z.uuid(), variantId: z.uuid().optional(), quantity: z.number().int().min(1).max(99) }).strict();
const removeSchema = z.object({ productId: z.uuid(), variantId: z.uuid().optional() }).strict();
function createCartRoutes({ repository = createCartRepository(), secure = process.env.NODE_ENV === 'production' } = {}) {
  const router = Router();
  const cookieName = 'alreda_guest_cart';
  const options = `Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  function context(req, res) {
    let token = readCookie(req.get('cookie'), cookieName);
    if (!req.customer && !/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
      token = repository.newGuestToken();
      res.append('Set-Cookie', `${cookieName}=${token}; ${options}`);
    }
    return { userId: req.customer?.id || null, guestToken: req.customer ? null : token };
  }
  function sendError(error, res) {
    const status = ['PRODUCT_UNAVAILABLE', 'CART_QUANTITY_LIMIT', 'PRODUCT_OPTIONS_REQUIRED', 'PRICE_CHANGED'].includes(error.message) ? 409 : 503;
    return res.status(status).json({ error: status === 409 ? error.message : 'CART_UNAVAILABLE' });
  }
  router.use('/api/cart', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/api/cart', async (req, res) => {
    const token = readCookie(req.get('cookie'), cookieName);
    if (!req.customer && !/^[A-Za-z0-9_-]{40,64}$/.test(token)) return res.json({ cart_items: [] });
    try { return res.json(await repository.get(context(req, res))); } catch (error) { return sendError(error, res); }
  });
  router.post('/api/cart/items', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'REQUEST_ORIGIN_REJECTED' });
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'INVALID_CART_ITEM' });
    try { return res.status(200).json(await repository.add({ ...context(req, res), ...parsed.data })); } catch (error) { return sendError(error, res); }
  });
  router.delete('/api/cart/items', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'REQUEST_ORIGIN_REJECTED' });
    const parsed = removeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'INVALID_CART_ITEM' });
    try { return res.json(await repository.remove({ ...context(req, res), ...parsed.data })); } catch (error) { return sendError(error, res); }
  });
  return router;
}
module.exports = { createCartRoutes };
