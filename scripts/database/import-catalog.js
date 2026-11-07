require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const { getPrismaClient, disconnectDatabase } = require('../../src/config/prisma');
const { createMediaDelivery } = require('../../src/services/media-delivery.service');

const root = path.resolve(__dirname, '../..');
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'src/config/catalog.json'), 'utf8'));
const sourceRepository = require('../../src/services/catalog.repository');
const source = { ...snapshot,
  products: snapshot.products.map(product => ({ ...product,
    collectionIds: sourceRepository.products.get(product.sourceId)?.collectionIds || product.collectionIds })),
  collections: snapshot.collections.map(category => ({ ...category,
    productIds: sourceRepository.categories.find(item => item.sourceId === category.sourceId)?.productIds || category.productIds })),
};
const cloudinary = JSON.parse(fs.readFileSync(path.join(root, 'src/config/cloudinary-media.json'), 'utf8'));
const homepagePreview = JSON.parse(fs.readFileSync(path.join(root, 'src/config/collection-preview.json'), 'utf8').replace(/^\uFEFF/, ''))
  .filter(category => category.group === 'primary' || category.group === 'secondary');

function buildPlan(catalog, manifest, delivery) {
  const localized = delivery.applyCatalog(catalog);
  const variants = localized.products.flatMap(product => product.variants.map(variant => ({ product, variant })));
  const images = localized.products.flatMap(product => product.gallery.map((image, index) => ({ product, image, index })));
  const unmapped = images.filter(({ image }) => !image.cloudinary || !image.src.startsWith(`https://res.cloudinary.com/${manifest.cloudName}/`));
  const unmappedCategories = localized.collections.filter(category => category.image && !category.image.startsWith(`https://res.cloudinary.com/${manifest.cloudName}/`));
  if (unmapped.length || unmappedCategories.length) throw new Error('CATALOG_HAS_NON_CLOUDINARY_IMAGES');
  if (localized.products.some(product => product.name.length > 120 || product.slug.length > 120)
    || localized.collections.some(category => category.name.length > 80 || category.slug.length > 80)) throw new Error('CATALOG_FIELD_LIMIT_EXCEEDED');
  const catalogBySlug = new Map(localized.collections.map(category => [category.slug, category]));
  const homepageOrder = { primary: 0, secondary: 0 };
  const homepageCollections = homepagePreview.filter(category => catalogBySlug.has(category.slug)).map(category => {
    const sourceCategory = catalogBySlug.get(category.slug);
    return { sourceId: sourceCategory.sourceId, slug: category.slug, sectionSlug: `home-${category.group}`,
      order: homepageOrder[category.group]++ };
  });
  return { catalog: localized, products: localized.products.length, categories: localized.collections.length, variants: variants.length,
    images: images.length, mappedCloudinaryImages: images.length - unmapped.length, homepageCollections };
}

function intPrice(value) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('CATALOG_INVALID_PRICE');
  return amount;
}

async function synchronize({ client, plan }) {
  const { catalog } = plan;
  const previous = await client.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const categories = await tx.categories.count();
    const products = await tx.products.count();
    const foreignCategories = await tx.categories.count({ where: { source_id: null } });
    const foreignProducts = await tx.products.count({ where: { source_id: null } });
    return { categories, products, foreignCategories, foreignProducts };
  });
  if (previous.foreignCategories || previous.foreignProducts) throw new Error('UNMAPPED_DATABASE_CATALOG_EXISTS');
  return client.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('alreda-catalog-import', 0))::text`;
    await tx.categories.createMany({ data: catalog.collections.map(category => ({ source_id: category.sourceId,
      name: category.titleEn || category.name, name_ar: category.titleAr || category.name, slug: category.slug,
      description: category.descriptionHtml || '', description_ar: category.descriptionArHtml || '', image_url: category.image || '' })), skipDuplicates: true });
    const savedCategories = await tx.categories.findMany({ where: { source_id: { in: catalog.collections.map(item => item.sourceId) } }, select: { id: true, source_id: true } });
    const categoryIds = new Map(savedCategories.map(category => [category.source_id, category.id]));
    if (categoryIds.size !== catalog.collections.length) throw new Error('CATALOG_CATEGORY_IMPORT_INCOMPLETE');
    const sections = await tx.storefront_sections.findMany({ where: { slug: { in: ['home-primary', 'home-secondary'] }, is_active: true },
      select: { id: true, slug: true } });
    const sectionIds = new Map(sections.map(section => [section.slug, section.id]));
    if (sectionIds.size !== 2) throw new Error('CATALOG_HOMEPAGE_SECTION_MISSING');
    for (const assignment of plan.homepageCollections) {
      const categoryId = categoryIds.get(assignment.sourceId);
      const homeSectionId = sectionIds.get(assignment.sectionSlug);
      if (!categoryId || !homeSectionId) throw new Error('CATALOG_HOMEPAGE_COLLECTION_MISSING');
      await tx.categories.update({ where: { id: categoryId }, data: { home_section_id: homeSectionId,
        homepage_order: assignment.order, updated_at: new Date() } });
    }

    await tx.products.createMany({ data: catalog.products.map(product => {
      const primary = product.gallery[0];
      const prices = product.variants.map(variant => intPrice(variant.priceAmount));
      const primaryCategory = product.collectionIds.find(id => categoryIds.has(id));
      return { source_id: product.sourceId, name: product.titleEn || product.name, name_ar: product.titleAr || product.name,
        slug: product.slug, description: product.descriptionHtml || '', description_ar: product.descriptionArHtml || '',
        price_egp: Math.min(...prices), image_url: primary?.src || '', ingredients: JSON.stringify(product.specifications || []),
        is_available: product.variants.some(variant => variant.publicAvailable === true), is_featured: false,
        prep_minutes: 0, category_id: primaryCategory ? categoryIds.get(primaryCategory) : null, stock_quantity: null };
    }), skipDuplicates: true });
    const savedProducts = await tx.products.findMany({ where: { source_id: { in: catalog.products.map(item => item.sourceId) } }, select: { id: true, source_id: true } });
    const productIds = new Map(savedProducts.map(product => [product.source_id, product.id]));
    if (productIds.size !== catalog.products.length) throw new Error('CATALOG_PRODUCT_IMPORT_INCOMPLETE');

    const links = catalog.products.flatMap(product => product.collectionIds.filter(id => categoryIds.has(id))
      .map(categoryId => ({ product_id: productIds.get(product.sourceId), category_id: categoryIds.get(categoryId) })));
    if (links.length) await tx.product_categories.createMany({ data: links, skipDuplicates: true });

    const variantRows = catalog.products.flatMap(product => product.variants.map(variant => ({ source_id: variant.id,
      product_id: productIds.get(product.sourceId), title: variant.title, title_ar: variant.titleAr || '',
      price_egp: variant.priceAmount, compare_at_egp: variant.compareAtAmount, sku: variant.sku || '',
      options: JSON.stringify(variant.options), is_available: variant.publicAvailable === true,
      stock_quantity: null, source_image_id: variant.imageId || null })));
    if (variantRows.length) await tx.product_variants.createMany({ data: variantRows, skipDuplicates: true });
    const savedVariants = await tx.product_variants.findMany({ where: { source_id: { in: variantRows.map(item => item.source_id) } }, select: { id: true, source_id: true } });
    const variantIds = new Map(savedVariants.map(variant => [variant.source_id, variant.id]));
    if (variantIds.size !== variantRows.length) throw new Error('CATALOG_VARIANT_IMPORT_INCOMPLETE');

    const imageRows = catalog.products.flatMap(product => product.gallery.map((image, index) => {
      const asset = image.cloudinary;
      const variant = product.variants.find(item => item.imageId === image.sourceId);
      return { source_id: image.sourceId, product_id: productIds.get(product.sourceId),
        variant_id: variant ? variantIds.get(variant.id) : null, secure_url: asset.secureUrl,
        public_id: asset.publicId, asset_id: asset.assetId, alt_text: image.alt || product.name,
        display_order: image.position || index, is_primary: index === 0 };
    }));
    if (imageRows.length) await tx.product_images.createMany({ data: imageRows, skipDuplicates: true });
    const imageCount = await tx.product_images.count({ where: { product_id: { in: [...productIds.values()] } } });
    return { products: productIds.size, categories: categoryIds.size, variants: variantIds.size, images: imageCount,
      categoryLinks: links.length, homepageCollections: plan.homepageCollections.length };
  }, { maxWait: 15000, timeout: 90000, isolationLevel: 'Serializable' });
}

async function main(args = process.argv.slice(2)) {
  const execute = args.length === 1 && args[0] === '--execute';
  if (args.length && !execute) throw new Error('USE_NO_ARGUMENTS_FOR_PLAN_OR_EXECUTE_FLAG_FOR_DATABASE_WRITE');
  const delivery = createMediaDelivery({ manifest: cloudinary });
  if (!delivery.cloudName) throw new Error('CLOUDINARY_NOT_CONFIGURED');
  const plan = buildPlan(source, cloudinary, delivery);
  if (!execute) { console.info(JSON.stringify({ mode: 'plan', products: plan.products, categories: plan.categories,
    variants: plan.variants, images: plan.images, mappedCloudinaryImages: plan.mappedCloudinaryImages,
    homepageCollections: plan.homepageCollections.length })); return; }
  if (process.env.CONFIRM_CATALOG_IMPORT !== 'true') throw new Error('SET_CONFIRM_CATALOG_IMPORT_TO_TRUE_TO_APPLY');
  const client = getPrismaClient();
  try {
    const result = await synchronize({ client, plan });
    console.info(JSON.stringify({ mode: 'execute', ...result }));
  } finally { await disconnectDatabase(); }
}

if (require.main === module) main().catch(error => { console.error(JSON.stringify({ success: false,
  code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'CATALOG_IMPORT_FAILED' })); process.exitCode = 1; });
module.exports = { buildPlan, synchronize };
