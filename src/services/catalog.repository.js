// Development snapshot fallback; configured runtimes load the catalog from PostgreSQL.
const { createMediaDelivery } = require('./media-delivery.service');
const { getPrismaClient } = require('../config/prisma');
const { readRuntimeDatabaseConfig } = require('../config/database');
const { activeDiscounts, effectivePrice } = require('./discount.service');
const { variantPrice, variantColor } = require('./purchase-selection.service');
const { optimizedImageUrl } = require('../utils/optimizedImage');
const pendingDatabaseReads = new Map();
let pendingHomepageRead;
const HOMEPAGE_CACHE_TTL_MS = 15_000;
let cachedHomepage;
let cachedHomepageUntil = 0;
let homepageCacheRevision = 0;
const catalog = createMediaDelivery().applyCatalog(require('../config/catalog.json'));
const products = new Map(catalog.products.map(product => [product.sourceId, product]));
const bySlug = new Map(catalog.products.map(product => [product.slug, product]));
const previewOrder = require('../config/collection-preview.json').filter(category => category.group !== 'legacy').map(category => category.slug);
const fallbackSections = [
  { id: 'primary', slug: 'primary', title_en: 'Collections', title_ar: 'المجموعات', display_order: 0, is_active: true },
  { id: 'secondary', slug: 'secondary', title_en: 'Collections', title_ar: 'مجموعات أخرى', display_order: 1, is_active: true },
];
const categories = catalog.collections.map(category => ({ ...category, href: `/collections/${encodeURIComponent(category.slug)}`,
  homeSectionId: category.group === 'primary' ? 'primary' : category.group === 'secondary' ? 'secondary' : null,
  homeOrder: previewOrder.indexOf(category.slug) < 0 ? 1000 : previewOrder.indexOf(category.slug) }));
const byCategory = new Map(categories.map(category => [category.slug, category]));
// The captured storefront collection snapshot predates these three mirror stands.
// Their source product slugs identify their category, so include them in both indexes.
const verifiedCategoryRepairs = new Map([
  ['delight-mirror-stand-122', 'mirror-stand'],
  ['delight-mirror-stand-858', 'mirror-stand'],
  ['delight-mirror-stand-853', 'mirror-stand'],
]);
for (const product of catalog.products) {
  if (product.collectionIds?.length) continue;
  const category = byCategory.get(verifiedCategoryRepairs.get(product.slug));
  if (!category) continue;
  if (!category.productIds.includes(product.sourceId)) category.productIds.push(product.sourceId);
  product.collectionIds = [...(product.collectionIds || []), category.sourceId];
}
for (const alias of catalog.legacyAliases) {
  const target = byCategory.get(alias.targetSlug);
  if (target) byCategory.set(alias.slug, { ...target, slug: alias.slug, href: `/collections/${alias.slug}`, group: 'legacy' });
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

async function getDatabaseCatalog(productIds = null, scope = {}) {
  if (!readRuntimeDatabaseConfig().enabled) return { catalog, products, bySlug, categories, byCategory, sections: fallbackSections };
  const identifiers = Array.isArray(productIds) ? [...new Set(productIds)].sort() : null;
  const key = JSON.stringify([identifiers, scope]);
  if (pendingDatabaseReads.has(key)) return pendingDatabaseReads.get(key);
  const read = loadDatabaseCatalog(identifiers, scope);
  pendingDatabaseReads.set(key, read);
  try {
    // Inventory, prices and catalog edits must be fresh on the next request,
    // including when another application instance committed the change.
    return await read;
  } finally { if (pendingDatabaseReads.get(key) === read) pendingDatabaseReads.delete(key); }
}

async function getDatabaseHomepage() {
  if (!readRuntimeDatabaseConfig().enabled) return { categories, byCategory, sections: fallbackSections };
  if (cachedHomepage && Date.now() < cachedHomepageUntil) return cachedHomepage;
  if (pendingHomepageRead) return pendingHomepageRead;
  const revision = homepageCacheRevision;
  const read = loadDatabaseHomepage();
  pendingHomepageRead = read;
  try {
    const homepage = await read;
    // An admin write may invalidate this request while the database read is in flight.
    if (revision === homepageCacheRevision) {
      cachedHomepage = homepage;
      cachedHomepageUntil = Date.now() + HOMEPAGE_CACHE_TTL_MS;
    }
    return homepage;
  } finally { if (pendingHomepageRead === read) pendingHomepageRead = null; }
}

async function searchCatalogProducts(query, locale = 'en') {
  const normalized = String(query || '').trim();
  if (normalized.length < 2) return [];
  if (!readRuntimeDatabaseConfig().enabled) {
    const needle = normalized.toLocaleLowerCase(locale === 'ar' ? 'ar' : 'en');
    return catalog.products.filter(product => [product.titleEn, product.titleAr, product.name].filter(Boolean)
      .some(name => name.toLocaleLowerCase(locale === 'ar' ? 'ar' : 'en').includes(needle)))
      .slice(0, 10).map(product => ({ name: locale === 'ar' ? product.titleAr || product.name : product.titleEn || product.name,
        href: `/products/${encodeURIComponent(product.slug)}` }));
  }
  const matches = await getPrismaClient().products.findMany({
    where: { OR: [
      { name: { contains: normalized, mode: 'insensitive' } },
      { name_ar: { contains: normalized, mode: 'insensitive' } },
    ] },
    select: { slug: true, name: true, name_ar: true, catalog_details: { select: { presentation: true } } },
    orderBy: [{ is_available: 'desc' }, { name: 'asc' }],
    take: 40,
  });
  return matches.filter(product => !product.catalog_details?.presentation?.archivedAt).slice(0, 10)
    .map(product => ({ name: locale === 'ar' ? product.name_ar || product.name : product.name, href: `/products/${encodeURIComponent(product.slug)}` }));
}

async function loadDatabaseHomepage() {
  const client = getPrismaClient();
  const [categoryRows, sectionRows] = await Promise.all([
    client.categories.findMany({ where: { is_active: true }, select: {
      id: true, source_id: true, slug: true, name: true, name_ar: true, image_url: true, home_section_id: true, homepage_order: true,
      home_section: { select: { id: true, slug: true } },
    } }),
    client.storefront_sections.findMany({ where: { is_active: true }, select: {
      id: true, slug: true, title_en: true, title_ar: true, display_order: true, is_active: true,
    }, orderBy: { display_order: 'asc' } }),
  ]);
  const savedCategories = categoryRows.map(row => {
    const original = categories.find(value => value.sourceId === row.source_id) || {};
    return { ...original, id: row.id, sourceId: row.source_id || row.id, slug: row.slug, name: row.name,
      titleEn: row.name, titleAr: row.name_ar, group: row.home_section?.slug || null, homeSectionId: row.home_section_id,
      homeOrder: row.homepage_order, image: optimizedImageUrl(row.image_url || original.image, 'category-card') || null,
      productIds: original.productIds || [], href: `/collections/${encodeURIComponent(row.slug)}` };
  });
  const savedCategoriesBySlug = new Map(savedCategories.map(value => [value.slug, value]));
  for (const alias of catalog.legacyAliases) {
    const target = savedCategoriesBySlug.get(alias.targetSlug);
    if (target) savedCategoriesBySlug.set(alias.slug, { ...target, slug: alias.slug, href: `/collections/${alias.slug}`, group: 'legacy' });
  }
  return { categories: savedCategories, byCategory: savedCategoriesBySlug,
    sections: sectionRows.map(row => ({ ...row, titleEn: row.title_en, titleAr: row.title_ar })) };
}

async function loadDatabaseCatalog(productIds = null, scope = {}) {
  const client = getPrismaClient();
  const collectionSlug = catalog.legacyAliases.find(alias => alias.slug === scope.collectionSlug)?.targetSlug || scope.collectionSlug;
  const includeDescriptions = Boolean(scope.productSlug) || !Object.hasOwn(scope, 'collectionSlug');
  // Keep all membership IDs for ordering/navigation, but hydrate only this collection
  // or the requested product and products sharing its active collections.
  const where = productIds ? { OR: [{ id: { in: productIds } }, { source_id: { in: productIds } }] }
    : scope.productSlug ? { OR: [
      { slug: scope.productSlug },
      { product_categories: { some: { categories: { is_active: true,
        ...(collectionSlug ? { slug: collectionSlug } : { product_categories: { some: { products: { slug: scope.productSlug } } } }),
      } } } },
    ] }
    : collectionSlug ? { product_categories: { some: { categories: { is_active: true, slug: collectionSlug } } } } : undefined;
  const [categoryRows, productRows, discountRules, sectionRows] = await Promise.all([
    client.categories.findMany({ where: { is_active: true }, select: {
      id: true, source_id: true, slug: true, name: true, name_ar: true, description: true, description_ar: true,
      image_url: true, home_section_id: true, homepage_order: true,
      home_section: { select: { id: true, slug: true } },
      ...(!productIds ? { product_categories: { select: { products: { select: { id: true, source_id: true } } } } } : {}),
    } }),
    client.products.findMany({ ...(where ? { where } : {}), select: {
      id: true, source_id: true, category_id: true, name: true, name_ar: true, slug: true, description: includeDescriptions,
      description_ar: includeDescriptions, price_egp: true, sale_price_egp: true, image_url: true, is_available: true, stock_quantity: true,
      catalog_details: { select: { presentation: true, color_en: true, type_en: true } },
      product_categories: { select: { category_id: true, categories: { select: { id: true, source_id: true } } } },
      product_variants: { select: {
        id: true, source_id: true, title: true, title_ar: true, price_egp: true, compare_at_egp: true, sku: true,
        options: true, is_available: true, stock_quantity: true, source_image_id: true, color_hex: true,
      }, orderBy: { source_id: 'asc' } },
      product_images: { select: {
        id: true, source_id: true, secure_url: true, public_id: true, asset_id: true, alt_text: true, display_order: true,
      }, orderBy: [{ display_order: 'asc' }, { id: 'asc' }] },
    } }),
    activeDiscounts(client),
    Object.keys(scope).length ? Promise.resolve([]) : client.storefront_sections.findMany({ where: { is_active: true }, select: {
      id: true, slug: true, title_en: true, title_ar: true, display_order: true, is_active: true,
    }, orderBy: { display_order: 'asc' } }),
  ]);
  const savedCategories = categoryRows.map(row => {
    const original = categories.find(value => value.sourceId === row.source_id) || {};
    const productIds = (row.product_categories || []).map(link => link.products.source_id || link.products.id);
    const originalOrder = original.productIds || [];
    productIds.sort((left, right) => {
      const a = originalOrder.indexOf(left); const b = originalOrder.indexOf(right);
      if (a < 0 && b < 0) return left.localeCompare(right);
      return (a < 0 ? Number.MAX_SAFE_INTEGER : a) - (b < 0 ? Number.MAX_SAFE_INTEGER : b);
    });
    return { ...original, group: row.home_section?.slug || null, homeSectionId: row.home_section_id, homeOrder: row.homepage_order, sourceId: row.source_id || row.id, slug: row.slug, name: row.name,
      titleEn: row.name, titleAr: row.name_ar, descriptionHtml: row.description, descriptionArHtml: row.description_ar,
      image: optimizedImageUrl(row.image_url || original.image, 'category-card') || null, productIds,
      href: `/collections/${encodeURIComponent(row.slug)}` };
  });
  const savedProducts = productRows.filter(row => !row.catalog_details?.presentation?.archivedAt).map(row => {
    const original = products.get(row.source_id) || {};
    const presentation = row.catalog_details?.presentation || {};
    const managedColors = String(row.catalog_details?.color_en || '').split(/[,;|/]+/).map(value => value.trim()).filter(Boolean);
    const activeRows = presentation.variantEditor?.enabled ? row.product_variants.filter(item=>presentation.variantEditor.ids.includes(item.id)) : presentation.manageTypes ? row.product_variants.filter(item => {
      const options = parseJson(item.options, []);
      return item.source_id.startsWith('admin-type-' + row.id + '-') && presentation.types.some(type => options.at(-1) === type.en)
        && (managedColors.length ? options.length === 2 && managedColors.includes(options[0]) : options.length === 1);
    }) : row.product_variants;
    const orderedVariants = [...activeRows].sort((a, b) => {
      const sourceVariants = original.variants || [];
      const left = sourceVariants.findIndex(value => value.id === a.source_id);
      const right = sourceVariants.findIndex(value => value.id === b.source_id);
      return (left < 0 ? Number.MAX_SAFE_INTEGER : left) - (right < 0 ? Number.MAX_SAFE_INTEGER : right);
    });
    const variants = orderedVariants.map(variant => {
      const source = (original.variants || []).find(value => value.id === variant.source_id) || {};
      const regular = Number(variant.price_egp);
      const color = variantColor(row, variant);
      const pricedProduct = color ? { ...row, catalog_details: { ...row.catalog_details, color_en: color } } : row;
      const price = variantPrice(pricedProduct, variant, discountRules);
      const compare = price < regular ? Math.max(regular, Number(variant.compare_at_egp || 0)) : variant.compare_at_egp;
      return { ...source, id: variant.source_id, databaseId: variant.id, title: variant.title, titleAr: variant.title_ar,
        priceAmount: price.toFixed(2), compareAtAmount: compare ? Number(compare).toFixed(2) : null,
        sku: variant.sku, options: parseJson(variant.options, []),
        publicAvailable: variant.is_available,
        inventoryQuantity: variant.stock_quantity, imageId: variant.source_image_id };
    });
    if (!variants.length) {
      const price = effectivePrice(row, discountRules);
      variants.push({ id: `base-${row.id}`, title: 'Default Title', titleAr: 'المنتج', priceAmount: price.toFixed(2), compareAtAmount: price < row.price_egp ? row.price_egp.toFixed(2) : null, sku: '', options: ['Default Title'], publicAvailable: row.is_available, inventoryQuantity: row.stock_quantity, imageId: null });
    }
    const gallery = row.product_images.map(image => {
      const source = (original.gallery || []).find(value => value.sourceId === image.source_id) || {};
      const sameAsset = source.src === image.secure_url;
      // Reuse already generated manifest derivatives instead of consuming free-tier
      // transformation quota for equivalent URLs. Replacements use the saved URL.
      const cardSrc = sameAsset && source.cardSrc || optimizedImageUrl(image.secure_url, 'product-card');
      const displaySrc = sameAsset && source.displaySrc || optimizedImageUrl(image.secure_url, 'product-detail');
      // Saved URLs are authoritative, including after replacing an imported image.
      const optimized = cardSrc !== image.secure_url;
      return { ...source, sourceId: image.source_id, src: image.secure_url,
        cardSrc: optimized ? cardSrc : image.secure_url,
        displaySrc: optimized ? displaySrc : image.secure_url,
        thumbSrc: sameAsset && source.thumbSrc || optimizedImageUrl(image.secure_url, 'thumbnail'),
        srcSet: sameAsset && source.srcSet || (optimized && source.width >= 1200 ? `${cardSrc} 640w, ${displaySrc} 1200w` : ''),
        alt: image.alt_text, position: image.display_order,
        cloudinary: { ...(source.cloudinary || {}), secureUrl: image.secure_url, publicId: image.public_id, assetId: image.asset_id } };
    });
    const collectionIds = row.product_categories.map(link => link.categories.source_id || link.categories.id);
    const savedColors = String(row.catalog_details?.color_en || '').split(/[,;|/]+/).map(value => value.trim()).filter(Boolean);
    const shouldFilterSavedColors = savedColors.length > 1 || row.product_variants.some(variant => Boolean(variant.color_hex));
    let sourceOptions = (original.options || []).map(option => /colou?r/i.test(option.name) && shouldFilterSavedColors ? { ...option, values: savedColors } : option);
    if (savedColors.length && !sourceOptions.some(option => /colou?r/i.test(option.name)) && variants.some(variant => savedColors.includes(variant.options?.[sourceOptions.length]))) sourceOptions.push({ name: 'Color', values: savedColors });
    if (presentation.manageTypes) sourceOptions = [...(savedColors.length ? [{ name: 'Color', values: savedColors }] : []), { name: 'Type', values: presentation.types.map(type => type.en) }];
    if (presentation.variantEditor?.enabled) sourceOptions = presentation.variantEditor.options.map((option,index)=>({name:option.name,values:[...new Set(variants.map(variant=>variant.options[index]).filter(Boolean))]}));
    return { ...original, id: row.id, catalogDetails: row.catalog_details, stock_quantity: row.stock_quantity, sourceId: row.source_id || row.id, slug: row.slug, name: row.name, titleEn: row.name, titleAr: row.name_ar,
      descriptionHtml: row.description, descriptionArHtml: row.description_ar, gallery, variants, options: sourceOptions,
      collectionIds, isAvailable: row.is_available, priceEgp: row.price_egp };
  });
  const savedProductsById = new Map(savedProducts.map(value => [value.sourceId, value]));
  const savedProductsBySlug = new Map(savedProducts.map(value => [value.slug, value]));
  for (const category of savedCategories) category.productIds = category.productIds.filter(id => savedProductsById.has(id));
  const savedCategoriesBySlug = new Map(savedCategories.map(value => [value.slug, value]));
  for (const alias of catalog.legacyAliases) {
    const target = savedCategoriesBySlug.get(alias.targetSlug);
    if (target) savedCategoriesBySlug.set(alias.slug, { ...target, slug: alias.slug, href: `/collections/${alias.slug}`, group: 'legacy' });
  }
  const sections = sectionRows.map(row => ({ ...row, titleEn: row.title_en, titleAr: row.title_ar }));
  return { persistent: true, sections, catalog: { ...catalog, products: savedProducts, collections: savedCategories }, products: savedProductsById,
    bySlug: savedProductsBySlug, categories: savedCategories, byCategory: savedCategoriesBySlug };
}

function invalidateDatabaseCatalog() {
  pendingDatabaseReads.clear();
  homepageCacheRevision += 1;
  pendingHomepageRead = null;
  cachedHomepage = null;
  cachedHomepageUntil = 0;
}
module.exports = { catalog, products, bySlug, categories, byCategory, getDatabaseCatalog, getDatabaseHomepage, searchCatalogProducts, invalidateDatabaseCatalog };
