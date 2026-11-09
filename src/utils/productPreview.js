const formatPrice = require('./formatPrice');
const { productName, translate } = require('../config/storefront-i18n');
const { purchaseState } = require('./purchaseState');

function productSlug(record) { return record.slug || decodeURIComponent(new URL(record.sourceUrl).pathname.split('/').pop()); }
function availability(variants, locale = 'en') {
  if (variants.some(variant => variant.publicAvailable === true)) return { label: translate(locale, 'available') };
  if (variants.every(variant => variant.publicAvailable === false)) return { label: translate(locale, 'outOfStock') };
  return { label: translate(locale, 'unknownAvailability') };
}
function productCard(record, categorySlug, locale = 'en') {
  const variant = record.variants[0];
  const compare = variant.compareAtAmount && BigInt(variant.compareAtAmount.replace('.', '')) > BigInt(variant.priceAmount.replace('.', ''));
  const purchaseStatus = purchaseState(record);
  const purchaseEligible = purchaseStatus === 'ready';
  const preview = require('./cardVariants').cardVariants(record, locale);
  return { id: record.id || record.sourceId, variantId: variant.databaseId || '', stock_quantity: variant.databaseId && record.variants.length === 1 ? variant.inventoryQuantity : record.stock_quantity, purchaseEligible, name: productName(record, locale), href: `/products/${encodeURIComponent(record.slug)}${categorySlug ? '?collection=' + encodeURIComponent(categorySlug) : ''}`,
    image: record.gallery[0]?.cardSrc || record.gallery[0]?.src || null, priceAmount: variant.priceAmount,
    price: { currentFormatted: formatPrice(variant.priceAmount, locale), ...(compare ? { compareAtFormatted: formatPrice(variant.compareAtAmount, locale) } : {}) },
    unavailable: purchaseStatus === 'productNotForSale',
    outOfStock: purchaseStatus === 'productNotForSale',
    availability: purchaseStatus === 'productNotForSale' ? { label: translate(locale, 'outOfStock') } : purchaseEligible ? { label: translate(locale, 'available') } : availability(record.variants, locale), purchaseStatus, preview };
}
module.exports = { productSlug, productCard, availability };
