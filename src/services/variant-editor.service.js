const sources = new Map(require('../config/catalog.json').products.map(product => [product.sourceId, product]));
const { valueName } = require('../config/storefront-i18n');
const { rehostCloudinaryUrl } = require('../utils/optimizedImage');
function buildVariantEditor(product) {
  const presentation = product?.catalog_details?.presentation || {};
  const all = product?.product_variants || [];
  const saved = presentation.variantEditor;
  let variants = saved?.enabled ? all.filter(row => saved.ids.includes(row.id)) : presentation.manageTypes
    ? all.filter(row => row.source_id?.startsWith(`admin-type-${product.id}-`)) : all;
  if (!variants.length) variants = all;
  const parse = row => { try { return JSON.parse(row.options || '[]'); } catch { return []; } };
  const source = sources.get(product?.source_id);
  const count = Math.max(1, ...variants.map(row => parse(row).length));
  let options = saved?.options || (presentation.manageTypes ? [...(String(product?.catalog_details?.color_en || '').trim() ? [{ name: 'Color', nameAr: 'اللون' }] : []), { name: 'Type', nameAr: 'النوع' }] : source?.options?.map((option,index) => ({ name: /[\u0600-\u06ff]/.test(option.name) ? `Option ${index+1}` : option.name, nameAr: /[\u0600-\u06ff]/.test(option.name) ? option.name : /colou?r/i.test(option.name) ? 'اللون' : /size|diam/i.test(option.name) ? 'المقاس' : 'النوع' })));
  if (!options?.length) options = Array.from({ length: count }, (_, index) => ({ name: index === 0 && variants.some(row => require('../config/catalog-colors').resolveColorSwatches(parse(row)[0]).length) ? 'Color' : index === 0 ? 'Type' : `Option ${index + 1}`, nameAr: index === 0 ? 'النوع' : `اختيار ${index + 1}` }));
  while (options.length < count) options.push({ name: options.length === 1 ? 'Type' : `Option ${options.length + 1}`, nameAr: options.length === 1 ? 'النوع' : `اختيار ${options.length + 1}` });
  const rows = variants.map(row => {
    const parsed = parse(row);
    const sourceVariant = source?.variants?.find(variant => variant.id === row.source_id);
    const sourceValues = sourceVariant?.options || [];
    const values = parsed.length === count && !parsed.every(value => value === 'Default Title') ? parsed : sourceValues.length === count ? sourceValues : parsed;
    const compare = Number(row.compare_at_egp || 0);
    const regular = compare > row.price_egp ? compare : Number(row.price_egp);
    const colorIndex = options.findIndex(option => /colou?r/i.test(option.name));
    const colorOffer = colorIndex >= 0 ? presentation.colorOffers?.[values[colorIndex]] : null;
    const directOffers = [presentation.variantOffers?.[row.id], colorOffer, product.sale_price_egp, compare > row.price_egp ? Number(row.price_egp) : null]
      .filter(price => Number.isSafeInteger(price) && price > 0 && price < regular);
    return { id: row.id, values: options.map((option, index) => String(values[index] || (options.length === 1 ? row.title : '') || '')),
      priceEgp: regular, salePriceEgp: directOffers.length ? Math.min(...directOffers) : null,
      stock: row.stock_quantity ?? 0, available: Boolean(row.is_available),
      imageUrl: rehostCloudinaryUrl(product.product_images?.find(image => image.source_id === row.source_image_id)?.secure_url || product.product_images?.[0]?.secure_url || product.image_url || ''),
      titleAr: row.title_ar || values.map(value => valueName(value, 'ar')).join(' / '),
    };
  });
  // Products with several existing option axes should open directly in the
  // exact-combination editor. This prevents the legacy type editor from
  // redistributing inventory across colors when an admin saves unrelated edits.
  return { enabled: Boolean(rows.length && (saved?.enabled || presentation.manageTypes || options.length > 1)), options, rows };
}
module.exports = { buildVariantEditor };
