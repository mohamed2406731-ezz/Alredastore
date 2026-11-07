const formatPrice = require('./formatPrice');
const { productName, translate } = require('../config/storefront-i18n');
const { purchaseState } = require('./purchaseState');

function productSlug(record) { return record.slug || decodeURIComponent(new URL(record.sourceUrl).pathname.split('/').pop()); }
function availability(variants, locale = 'en') {
  if (variants.some(variant => variant.inventoryQuantity === 0)) return { label: translate(locale, 'outOfStock') };
  if (variants.some(variant => variant.inventoryQuantity > 0)) return { label: translate(locale, 'stockAvailable') };
  if (variants.some(variant => variant.publicAvailable === true)) return { label: translate(locale, 'available') };
  if (variants.every(variant => variant.publicAvailable === false)) return { label: translate(locale, 'unavailable') };
  return { label: translate(locale, 'unknownAvailability') };
}
function productCard(record, categorySlug, locale = 'en') {
  const variant = record.variants[0];
  const compare = variant.compareAtAmount && BigInt(variant.compareAtAmount.replace('.', '')) > BigInt(variant.priceAmount.replace('.', ''));
  const purchaseStatus = purchaseState(record);
  const simpleProductOutOfStock = record.variants.length === 1 && (record.variants[0].inventoryQuantity === 0 || record.stock_quantity === 0);
  const hasPurchasableInventory = record.variants.some(variant => variant.publicAvailable !== false
    && (variant.inventoryQuantity ?? (record.variants.length === 1 ? record.stock_quantity : null)) > 0);
  const purchaseEligible = purchaseStatus === 'ready' && !simpleProductOutOfStock && hasPurchasableInventory;
  const preview = require('./cardVariants').cardVariants(record, locale);
  return { id: record.id || record.sourceId, variantId: variant.databaseId || '', stock_quantity: variant.databaseId && record.variants.length === 1 ? variant.inventoryQuantity : record.stock_quantity, purchaseEligible, name: productName(record, locale), href: `/products/${encodeURIComponent(record.slug)}${categorySlug ? '?collection=' + encodeURIComponent(categorySlug) : ''}`,
    image: record.gallery[0]?.cardSrc || record.gallery[0]?.src || null, priceAmount: variant.priceAmount,
    price: { currentFormatted: formatPrice(variant.priceAmount, locale), ...(compare ? { compareAtFormatted: formatPrice(variant.compareAtAmount, locale) } : {}) },
    unavailable: purchaseStatus === 'productNotForSale' && !simpleProductOutOfStock,
    outOfStock: simpleProductOutOfStock,
    availability: simpleProductOutOfStock ? { label: translate(locale, 'outOfStock') } : purchaseStatus === 'productNotForSale' ? { label: translate(locale, 'unavailable') } : purchaseEligible ? { label: translate(locale, 'available') } : !hasPurchasableInventory && !record.variants.some(item => item.inventoryQuantity === 0) ? { label: translate(locale, 'inventoryPending') } : availability(record.variants, locale), purchaseStatus: !hasPurchasableInventory && purchaseStatus === 'ready' ? 'inventoryPending' : purchaseStatus, preview };
}
module.exports = { productSlug, productCard, availability };
