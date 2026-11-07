const { effectivePrice } = require('./discount.service');
const sources = new Map(require('../config/catalog.json').products.map(product => [product.sourceId, product]));
const { resolveColorSwatches } = require('../config/catalog-colors');
function variantColor(product, variant) {
  const values = JSON.parse(variant.options || '[]');
  const options = product.catalog_details?.presentation?.variantEditor?.enabled ? product.catalog_details.presentation.variantEditor.options : sources.get(product.source_id)?.options;
  const colorIndex = options?.findIndex(option => /colou?r/i.test(option.name)) ?? -1;
  if (colorIndex >= 0) return values[colorIndex];
  if (options?.length) return undefined;
  return resolveColorSwatches(values[0] || '').length ? values[0] : undefined;
}
function variantPrice(product, variant, rules) {
  const color = variantColor(product, variant);
  const classified = { ...product, catalog_details: { ...product.catalog_details, ...(color ? { color_en: color } : {}) } };
  const colorOffer = product.catalog_details?.presentation?.colorOffers?.[color];
  const variantOffer = product.catalog_details?.presentation?.variantOffers?.[variant.id];
  const offers = [colorOffer,variantOffer,product.sale_price_egp].filter(value=>Number.isSafeInteger(value)&&value>0);
  const sale = offers.length ? Math.min(...offers) : null;
  return effectivePrice(classified, rules, new Date(), Number(variant.price_egp), sale);
}
async function selection(tx, productId, variantId, quantity, rules = []) {
  await tx.$queryRaw`SELECT id FROM public.products WHERE id = ${productId}::uuid FOR UPDATE`;
  const product = await tx.products.findUnique({ where: { id: productId }, include: { catalog_details: true, product_categories: { select: { category_id: true } } } });
  if (!product?.is_available || product.catalog_details?.presentation?.archivedAt) throw new Error('PRODUCT_UNAVAILABLE');
  let variant = null;
  if (variantId) {
    variant = await tx.product_variants.findFirst({ where: { id: variantId, product_id: productId, is_available: true } });
    if (!variant) throw new Error('PRODUCT_UNAVAILABLE');
  } else if (await tx.product_options.count({ where: { product_id: productId } }) || await tx.product_variants.count({ where: { product_id: productId } }) > 0) throw new Error('PRODUCT_OPTIONS_REQUIRED');
  const price = variant ? variantPrice(product, variant, rules) : effectivePrice(product, rules);
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error('PRICE_CHANGED');
  return { product, variant, price };
}
module.exports = { selection, variantPrice, variantColor };
