const { catalog, products, bySlug, categories, byCategory, getDatabaseCatalog } = require('./catalog.repository');
const formatPrice = require('../utils/formatPrice');
const { productCard } = require('../utils/productPreview');
const { productDescription } = require('../utils/productDescription');
const { purchaseState } = require('../utils/purchaseState');
const { categoryName, productName, valueName, variantName, translate } = require('../config/storefront-i18n');
const colors = { black: 'black', 'أسود': 'black', white: 'white', 'أبيض': 'white', silver: 'silver', 'فضي': 'silver', gold: 'gold', 'ذهبي': 'gold', gray: 'gray', grey: 'gray', 'رمادي': 'gray', 'rose gold': 'rose-gold' };
function getProductFromData(data, slug, { variant, collection, locale = 'en' } = {}) {
  const record = data.bySlug.get(slug);
  if (!record) return null;
  const purchaseStatus = purchaseState(record);
  const selectedCategory = collection ? data.byCategory.get(collection) : data.categories.find(category => record.collectionIds.includes(category.sourceId));
  if (collection && (!selectedCategory || !record.collectionIds.includes(selectedCategory.sourceId))) return { invalidSelection: true };
  const category = selectedCategory ? { ...selectedCategory, name: categoryName(selectedCategory, locale) }
    : { name: translate(locale, 'allProducts'), slug: '', href: '/products' };
  const variants = record.variants.map(item => ({ ...item, title: locale === 'ar' && item.titleAr ? item.titleAr : variantName(item.title, locale), sku: item.sku || '', currentFormatted: formatPrice(item.priceAmount, locale),
    outOfStock: item.publicAvailable === false,
    availabilityLabel: item.publicAvailable === false ? translate(locale, 'unavailable') : translate(locale, 'available'),
    gallerySrc: (record.gallery.find(image => image.sourceId === item.imageId) || record.gallery[0])?.src || null,
    compareAtFormatted: item.compareAtAmount && BigInt(item.compareAtAmount.replace('.', '')) > BigInt(item.priceAmount.replace('.', '')) ? formatPrice(item.compareAtAmount, locale) : '',
  }));
  const selectedVariant = variants.find(item => item.id === variant) || (!variant ? variants[0] : null);
  if (!selectedVariant) return { invalidSelection: true };
  for (const item of variants) item.purchaseEligible = purchaseStatus === 'ready' && (item.databaseId ? item.publicAvailable === true : record.isAvailable !== false);
  const purchaseEligible = selectedVariant.purchaseEligible;
  const optionGroups = record.options.map((option, index) => ({ name: valueName(option.name, locale), index,
    values: option.values.map(value => { const key = value.trim().toLowerCase(); return { value, displayValue: locale === 'ar' ? record.catalogDetails?.presentation?.types?.find(type => type.en === value)?.ar || valueName(value, locale) : valueName(value, locale), color: /color|colour|لون/i.test(option.name) && Object.hasOwn(colors, key) ? colors[key] : '' }; }),
  })).filter(option => !(record.options[option.index].name === 'Title' && option.values.length === 1 && option.values[0].value === 'Default Title'));
  const specifications = [{ label: translate(locale, 'brand'), value: valueName(record.vendor || '', locale) }, { label: translate(locale, 'productType'), value: valueName(record.productType || '', locale) },
    ...(selectedCategory ? [{ label: translate(locale, 'collectionName'), value: category.name }] : [])].filter(item => item.value);
  const related = selectedCategory ? selectedCategory.productIds.map(id => data.products.get(id)).filter(Boolean) : data.catalog.products;
  const details = productDescription(record, locale);
  return { category, categories: data.categories.map(item => ({ ...item, name: categoryName(item, locale) })), product: { ...record, vendor: valueName(record.vendor || '', locale), id: record.id, stock_quantity: record.stock_quantity, purchaseEligible, name: productName(record, locale), href: `/products/${encodeURIComponent(slug)}`,
    purchaseStatus, descriptionHtml: details.html, descriptionLanguage: details.language, originalDescription: details.originalLanguage,
    variants, selectedVariant, optionGroups, specifications, variantsJson: JSON.stringify(variants),
    primaryImage: record.gallery.find(image => image.sourceId === selectedVariant.imageId) || record.gallery[0] || null,
  }, relatedProducts: related.filter(item => item.sourceId !== record.sourceId).slice(0, 4).map(item => productCard(item, category.slug, locale)) };
}
function getProduct(slug, options) { return getProductFromData({ catalog, products, bySlug, categories, byCategory }, slug, options); }
async function getDatabaseProduct(slug, options) {
  let data = await getDatabaseCatalog(null, { productSlug: slug, ...(options?.collection ? { collectionSlug: options.collection } : {}) });
  const record = data.bySlug.get(slug);
  // Uncategorised products retain the existing all-products related selection.
  if (record && !options?.collection && !data.categories.some(category => record.collectionIds.includes(category.sourceId))) data = await getDatabaseCatalog();
  return getProductFromData(data, slug, options);
}
module.exports = { getProduct, getProductFromData, getDatabaseProduct };
