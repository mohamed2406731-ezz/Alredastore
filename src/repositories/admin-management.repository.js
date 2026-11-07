const { randomUUID } = require('node:crypto');
const { getPrismaClient } = require('../config/prisma');
const { invalidateDatabaseCatalog } = require('../services/catalog.repository');
const { adminPermissions } = require('../services/admin-access.service');
const { classification, activeDiscounts, effectivePrice } = require('../services/discount.service');
const { variantPrice, variantColor } = require('../services/purchase-selection.service');
const categorySnapshots = require('../config/catalog.json').collections;
const sourceProducts = new Map(require('../config/catalog.json').products.map(product => [product.sourceId, product]));
function createAdminManagementRepository(provider = getPrismaClient) {
  const audit = (tx, actorId, action, targetId) => tx.admin_audit_events.create({ data: { actor_id: actorId, action, target_id: targetId } });
  async function permit(tx, actorId, permission) {
    const actor = await tx.users.findFirst({ where: { id: actorId, is_active: true }, include: { user_roles: true } });
    if (!actor || !(await adminPermissions(tx, actor)).includes(permission)) throw new Error('ADMIN_REQUIRED');
    return actor;
  }
  return {
    async grants() { return provider().admin_access_grants.findMany({ orderBy: { created_at: 'desc' }, take: 200 }); },
    async grant(actorId, email, role) {
      return provider().$transaction(async tx => {
        const actor = await permit(tx, actorId, 'roles');
        if (actor?.email.toLowerCase() === email) throw new Error('SELF_ACCESS_CHANGE_BLOCKED');
        const row = await tx.admin_access_grants.upsert({ where: { email }, create: { email, role, created_by: actorId }, update: { role, is_active: true, updated_at: new Date() } });
        await audit(tx, actorId, 'ACCESS_GRANTED', row.id); return row;
      });
    },
    async revoke(actorId, id) {
      return provider().$transaction(async tx => {
        const actor = await permit(tx, actorId, 'roles');
        const grant = await tx.admin_access_grants.findUnique({ where: { id } });
        if (!grant || actor?.email.toLowerCase() === grant.email) throw new Error('SELF_ACCESS_CHANGE_BLOCKED');
        await tx.admin_access_grants.update({ where: { id }, data: { is_active: false, updated_at: new Date() } });
        await audit(tx, actorId, 'ACCESS_REVOKED', id);
      });
    },
    async catalog({ includeArchived = false } = {}) {
      const [products, categories, details, sections] = await Promise.all([
        provider().products.findMany({ orderBy: { updated_at: 'desc' }, take: 250, include: { catalog_details: true, product_categories: { select: { category_id: true } }, product_variants: { orderBy: { source_id: 'asc' } }, product_images: { orderBy: { display_order: 'asc' } } } }),
        provider().categories.findMany({ orderBy: { name: 'asc' } }),
        provider().catalog_details.findMany({ distinct: ['color_en', 'type_en'], take: 200 }),
        provider().storefront_sections.findMany({ where: { is_active: true }, orderBy: { display_order: 'asc' } }),
      ]);
      const visibleProducts = products.filter(product => Boolean(product.catalog_details?.presentation?.archivedAt) === includeArchived);
      const hydrated = visibleProducts.map(product => ({ ...product, catalog_details: { color_ar: '', type_ar: '', ...classification(product), ...(product.catalog_details || {}) } }));
      const imageCategories = categories.map(category => ({ ...category, previewImage: categorySnapshots.find(item => item.slug === category.slug)?.image || '' }));
      return { products: hydrated, categories: imageCategories, sections, details: [...details, ...hydrated.map(product => product.catalog_details)] };
    },
    async homepageLayout() {
      const [sections, categories] = await Promise.all([
        provider().storefront_sections.findMany({ where: { is_active: true }, orderBy: { display_order: 'asc' } }),
        provider().categories.findMany({ orderBy: [{ home_section_id: 'asc' }, { homepage_order: 'asc' }, { name: 'asc' }] }),
      ]);
      return { sections, categories: categories.map(category => ({ ...category,
        previewImage: categorySnapshots.find(item => item.slug === category.slug)?.image || '' })) };
    },
    async createHomeSection(actorId, data) {
      const section = await provider().$transaction(async tx => {
        await permit(tx, actorId, 'catalog');
        const order = await tx.storefront_sections.aggregate({ where: { is_active: true }, _max: { display_order: true } });
        const display_order = (order._max.display_order ?? -1) + 1;
        if (display_order >= 30) throw new Error('HOMEPAGE_SECTION_LIMIT');
        const created = await tx.storefront_sections.create({ data: { slug: data.slug, title_en: data.titleEn, title_ar: data.titleAr, display_order } });
        await audit(tx, actorId, 'HOMEPAGE_SECTION_CREATED', created.id);
        return created;
      });
      invalidateDatabaseCatalog();
      return section;
    },
    async deleteHomeSection(actorId, id) {
      await provider().$transaction(async tx => {
        await permit(tx, actorId, 'catalog');
        const section = await tx.storefront_sections.findFirst({ where: { id, is_active: true } });
        const [count, categories] = await Promise.all([
          tx.storefront_sections.count({ where: { is_active: true } }),
          tx.categories.count({ where: { home_section_id: id } }),
        ]);
        if (!section) throw new Error('HOME_SECTION_NOT_FOUND');
        if (categories) throw new Error('HOME_SECTION_NOT_EMPTY');
        if (count <= 1) throw new Error('LAST_HOME_SECTION');
        await tx.storefront_sections.update({ where: { id }, data: { is_active: false, updated_at: new Date() } });
        await tx.$executeRaw`
          WITH ordered AS (
            SELECT id, row_number() OVER (ORDER BY display_order, created_at, id) - 1 AS position
            FROM storefront_sections WHERE is_active = true
          )
          UPDATE storefront_sections AS section
          SET display_order = ordered.position, updated_at = now()
          FROM ordered WHERE section.id = ordered.id
        `;
        await audit(tx, actorId, 'HOMEPAGE_SECTION_DISABLED', id);
      });
      invalidateDatabaseCatalog();
    },
    async saveHomepageLayout(actorId, data) {
      await provider().$transaction(async tx => {
        await permit(tx, actorId, 'catalog');
        const [sections, categories] = await Promise.all([
          tx.storefront_sections.findMany({ where: { is_active: true }, select: { id: true } }),
          tx.categories.findMany({ select: { id: true } }),
        ]);
        const sectionIds = sections.map(item => item.id).sort();
        const submittedSectionIds = data.sections.map(item => item.id).sort();
        const categoryIds = categories.map(item => item.id).sort();
        const submittedCategoryIds = data.categories.map(item => item.id).sort();
        if (new Set(submittedSectionIds).size !== submittedSectionIds.length || sectionIds.join() !== submittedSectionIds.join()
          || new Set(submittedCategoryIds).size !== submittedCategoryIds.length || categoryIds.join() !== submittedCategoryIds.join()) throw new Error('HOMEPAGE_LAYOUT_STALE');
        const orderedSections = data.sections.map((section, display_order) => ({ id: section.id, title_en: section.titleEn, title_ar: section.titleAr, display_order }));
        await tx.$executeRaw`
          UPDATE storefront_sections AS section
          SET title_en = input.title_en, title_ar = input.title_ar, display_order = input.display_order, updated_at = now()
          FROM jsonb_to_recordset(${JSON.stringify(orderedSections)}::jsonb)
            AS input(id uuid, title_en varchar, title_ar varchar, display_order integer)
          WHERE section.id = input.id AND section.is_active = true
        `;
        const validSections = new Set(sectionIds);
        const perSection = new Map();
        const orderedCategories = data.categories.map(category => {
          if (category.sectionId && !validSections.has(category.sectionId)) throw new Error('INVALID_HOME_SECTION');
          const order = category.sectionId ? (perSection.get(category.sectionId) || 0) : 0;
          if (category.sectionId) perSection.set(category.sectionId, order + 1);
          return { id: category.id, section_id: category.sectionId, homepage_order: order, name: category.nameEn, name_ar: category.nameAr };
        });
        await tx.$executeRaw`
          UPDATE categories AS category
          SET home_section_id = input.section_id, homepage_order = input.homepage_order, name = input.name, name_ar = input.name_ar, updated_at = now()
          FROM jsonb_to_recordset(${JSON.stringify(orderedCategories)}::jsonb)
            AS input(id uuid, section_id uuid, homepage_order integer, name varchar, name_ar varchar)
          WHERE category.id = input.id
        `;
        await audit(tx, actorId, 'HOMEPAGE_LAYOUT_UPDATED', 'storefront-sections');
      });
      invalidateDatabaseCatalog();
    },
    async saveProduct(actorId, data) {
      const id = await provider().$transaction(async tx => {
        await permit(tx, actorId, 'catalog');
        if (!await tx.categories.findFirst({ where: { id: data.categoryId, is_active: true }, select: { id: true } })) throw new Error('CATEGORY_NOT_FOUND');
        const id = data.id || randomUUID();
        let sourceColorIndex = -1;
        const selectedColors = data.colorVariants || [];
        const matrix = data.variantEditor?.enabled ? data.variantEditor : null;
        const matrixRows = matrix ? matrix.rows.map(row => ({ ...row, id: row.id || randomUUID() })) : [];
        if (data.id && data.expectedUpdatedAt) await tx.$queryRaw`SELECT id FROM public.products WHERE id = ${id}::uuid FOR UPDATE`;
        const priorDetails = data.id ? await tx.catalog_details.findUnique({ where: { product_id: data.id } }) : null;
        const colorOffers = Object.fromEntries(selectedColors.map(item => [item.color, item.salePriceEgp === undefined ? priorDetails?.presentation?.colorOffers?.[item.color] : item.salePriceEgp]).filter(([,price]) => price != null));
        const presentation = { ...(data.presentation || {}), colorImages: Object.fromEntries(selectedColors.map(item => [item.color, item.imageUrl])), colorPrices: Object.fromEntries(selectedColors.filter(item => item.priceEgp != null).map(item => [item.color, item.priceEgp])), colorOffers };
        if (matrix) {
          presentation.manageTypes = false;
          presentation.variantEditor = { enabled:true, options:matrix.options, ids:matrixRows.map(row=>row.id) };
          presentation.variantOffers = Object.fromEntries(matrixRows.filter(row=>row.salePriceEgp!=null).map(row=>[row.id,row.salePriceEgp]));
          presentation.colorOffers = {};
          presentation.colorImages = {};
          presentation.colorPrices = {};
        }
        const core = { name: data.name, name_ar: data.nameAr, description: data.description, description_ar: data.descriptionAr, price_egp: data.priceEgp, sale_price_egp: matrix ? null : data.salePriceEgp, stock_quantity: data.stock,
          category_id: data.categoryId, image_url: data.imageUrls[0], is_available: data.available, updated_at: new Date() };
        if (data.id) {
          if (matrix && !data.expectedUpdatedAt) throw new Error('PRODUCT_EDIT_STALE');
          const prior = await tx.products.findUnique({ where: { id }, select: { sale_price_egp: true, source_id: true, updated_at: true } });
          if (data.expectedUpdatedAt && (!prior || new Date(prior.updated_at).getTime() !== new Date(data.expectedUpdatedAt).getTime())) throw new Error('PRODUCT_EDIT_STALE');
          sourceColorIndex = (sourceProducts.get(prior?.source_id)?.options || []).findIndex(option => /colou?r/i.test(option.name));
        }
        if (data.id) await tx.products.update({ where: { id }, data: core });
        else await tx.products.create({ data: { ...core, id, source_id: `custom-${id}`, slug: `${data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 65)}-${id.slice(0, 8)}` } });
        const selectedColorLabels = selectedColors.map(item => item.color);
        const colorAr = selectedColors.map(item => require('../config/catalog-colors').colorOptions.find(color => color.en === item.color)?.ar).filter(Boolean).join(', ');
        const storedColor = selectedColorLabels.length ? selectedColorLabels.join(', ') : data.color;
        await tx.catalog_details.upsert({ where: { product_id: id }, create: { product_id: id, color_en: storedColor, color_ar: selectedColorLabels.length ? colorAr : data.colorAr, type_en: data.type, type_ar: data.typeAr, presentation }, update: { color_en: storedColor, color_ar: selectedColorLabels.length ? colorAr : data.colorAr, type_en: data.type, type_ar: data.typeAr, presentation } });
        // Preserve all existing memberships; ensure the selected primary category is linked.
        await tx.product_categories.upsert({ where: { product_id_category_id: { product_id: id, category_id: data.categoryId } }, create: { product_id: id, category_id: data.categoryId }, update: {} });
        const existingVariants = await tx.product_variants.findMany({ where: { product_id: id }, orderBy: { source_id: 'asc' } });
        if (!matrix && !selectedColors.length && !presentation.manageTypes) {
          if (!data.id || existingVariants.length === 0) await tx.product_variants.create({ data: { source_id: `custom-${id}`, product_id: id, title: 'Default Title', title_ar: 'المنتج', price_egp: data.priceEgp, options: '["Default Title"]', is_available: data.available, stock_quantity: data.stock } });
          else if (existingVariants.length === 1) await tx.product_variants.update({ where: { id: existingVariants[0].id }, data: { price_egp: data.priceEgp, stock_quantity: data.stock, is_available: data.available, updated_at: new Date() } });
        }
        // Preserve galleries and variant relationships while setting the selected cover first.
        await tx.product_images.updateMany({ where: { product_id: id }, data: { is_primary: false, display_order: { increment: 1 } } });
        for (let i = 0; i < data.imageUrls.length; i++) {
          const url = data.imageUrls[i];
          const found = await tx.product_images.findFirst({ where: { product_id: id, secure_url: url } });
          if (!found) await tx.product_images.create({ data: { product_id: id, source_id: `custom-${randomUUID()}`, secure_url: url, alt_text: data.name, display_order: i, is_primary: i === 0 } });
          else await tx.product_images.update({ where: { id: found.id }, data: { display_order: i, is_primary: i === 0 } });
        }
        if (!matrix && selectedColors.length && !presentation.manageTypes) {
          const savedImages = await tx.product_images.findMany({ where: { product_id: id, secure_url: { in: data.imageUrls } }, select: { source_id: true, secure_url: true } });
          const imageByUrl = new Map(savedImages.map(image => [image.secure_url, image.source_id]));
          const parsedVariants = existingVariants.map(variant => ({ variant, options: (() => { try { return JSON.parse(variant.options || '[]'); } catch { return []; } })() }));
          const knownColors = new Set(require('../config/catalog-colors').colorOptions.map(option => option.en));
          const storedColorIndex = parsedVariants.find(({ options }) => options.some(value => knownColors.has(value)))?.options.findIndex(value => knownColors.has(value)) ?? -1;
          const hasOnlyDefault = parsedVariants.length > 0 && parsedVariants.every(({ options }) => !options.length || options.every(value => value === 'Default Title'));
          const sourceHasColor = sourceColorIndex >= 0 && parsedVariants.some(({ options }) => knownColors.has(options[sourceColorIndex]));
          const colorIndex = storedColorIndex >= 0 ? storedColorIndex : sourceHasColor ? sourceColorIndex : hasOnlyDefault ? 0 : Math.max(0, ...parsedVariants.map(({ options }) => options.length));
          const existingByColor = new Map();
          for (const item of parsedVariants) if (item.options[colorIndex]) existingByColor.set(item.options[colorIndex], [...(existingByColor.get(item.options[colorIndex]) || []), item]);
          const baseCombinations = [...new Map(parsedVariants.map(item => [JSON.stringify(item.options.filter((_, optionIndex) => optionIndex !== colorIndex)), item])).values()];
          if (!baseCombinations.length) baseCombinations.push({ options: [], variant: null });
          for (const [index, item] of selectedColors.entries()) {
            const sourceImageId = imageByUrl.get(item.imageUrl);
            if (!sourceImageId) throw new Error('COLOR_IMAGE_NOT_FOUND');
            const color = require('../config/catalog-colors').colorOptions.find(option => option.en === item.color);
            const length = Math.max(1, ...parsedVariants.map(({ options }) => options.length));
            const existing = existingByColor.get(item.color) || [];
            const combinations = existing.length ? existing : baseCombinations.map(base => ({ ...base, variant: null }));
            for (const combination of combinations) {
              const options = combination.options.length ? [...combination.options] : Array(length).fill('');
              options[colorIndex] = item.color;
              const variantData = { title: combination.variant?.title || item.color, title_ar: combination.variant?.title_ar || color.ar, price_egp: item.priceEgp ?? data.priceEgp, is_available: data.available, stock_quantity: item.stock ?? data.stock,
                options: JSON.stringify(options), source_image_id: sourceImageId, color_hex: color.hex, updated_at: new Date() };
              if (combination.variant) await tx.product_variants.update({ where: { id: combination.variant.id }, data: variantData });
              else await tx.product_variants.create({ data: { source_id: `admin-color-${id}-${index}-${randomUUID().slice(0, 8)}`, product_id: id, ...variantData } });
            }
          }
        }
        if (!matrix && presentation.manageTypes) {
          const savedImages = await tx.product_images.findMany({ where: { product_id: id, secure_url: { in: data.imageUrls } }, select: { source_id: true, secure_url: true } });
          const imageByUrl = new Map(savedImages.map(image => [image.secure_url, image.source_id]));
          // Retain old rows for order history; explicitly manage the active type matrix.
          await tx.product_variants.updateMany({ where: { product_id: id }, data: { is_available: false, stock_quantity: null } });
          const colors = selectedColors.length ? selectedColors : [null];
          for (const type of presentation.types) {
            for (const [colorIndex, color] of colors.entries()) {
              const options = color ? [color.color, type.en] : [type.en];
              const sourceId = 'admin-type-' + id + '-' + require('node:crypto').createHash('sha256').update(JSON.stringify(options)).digest('hex').slice(0, 20);
              const sourceImageId = imageByUrl.get(type.imageUrl || color?.imageUrl || data.imageUrls[0]);
              if (!sourceImageId) throw new Error('TYPE_IMAGE_NOT_FOUND');
              const variantData = { title: options.join(' / '), title_ar: color ? require('../config/catalog-colors').colorOptions.find(item => item.en === color.color).ar + ' / ' + type.ar : type.ar,
                color_hex: color ? require('../config/catalog-colors').colorOptions.find(item => item.en === color.color).hex : '',
                price_egp: color?.priceEgp ?? type.priceEgp, options: JSON.stringify(options), source_image_id: sourceImageId,
                stock_quantity: selectedColors.length ? Math.floor(type.stock / selectedColors.length) + (colorIndex < type.stock % selectedColors.length ? 1 : 0) : type.stock, is_available: data.available, updated_at: new Date() };
              const existing = existingVariants.find(item => item.source_id === sourceId);
              if (existing) await tx.product_variants.update({ where: { id: existing.id }, data: variantData });
              else await tx.product_variants.create({ data: { ...variantData, source_id: sourceId, product_id: id } });
            }
          }
        }
        if (matrix) {
          for (const row of matrix.rows) if (row.id && !existingVariants.some(variant=>variant.id===row.id)) throw new Error('INVALID_VARIANT_SELECTION');
          const savedImages = await tx.product_images.findMany({ where:{product_id:id,secure_url:{in:data.imageUrls}},select:{source_id:true,secure_url:true} });
          const imageByUrl = new Map(savedImages.map(image=>[image.secure_url,image.source_id]));
          await tx.product_variants.updateMany({where:{product_id:id,id:{notIn:matrixRows.map(row=>row.id)}},data:{is_available:false,stock_quantity:null,updated_at:new Date()}});
          const colorIndex = matrix.options.findIndex(option=>/colou?r/i.test(option.name));
          for (const row of matrixRows) {
            const sourceImageId=imageByUrl.get(row.imageUrl);
            if(!sourceImageId)throw new Error('INVALID_VARIANT_IMAGE');
            const color=colorIndex>=0?require('../config/catalog-colors').resolveColorSwatches(row.values[colorIndex])[0]:null;
            const variantData={title:row.values.join(' / '),title_ar:row.titleAr||row.values.map(value=>require('../config/storefront-i18n').valueName(value,'ar')).join(' / '),options:JSON.stringify(row.values),price_egp:row.priceEgp,compare_at_egp:null,source_image_id:sourceImageId,color_hex:color?.hex||'',stock_quantity:row.stock,is_available:data.available&&row.available,updated_at:new Date()};
            const previous=existingVariants.find(variant=>variant.id===row.id);
            if(previous)await tx.product_variants.update({where:{id:row.id},data:variantData});
            else await tx.product_variants.create({data:{id:row.id,product_id:id,source_id:`admin-matrix-${row.id}`,...variantData}});
          }
        }
        await audit(tx, actorId, data.id ? 'PRODUCT_UPDATED' : 'PRODUCT_CREATED', id); return id;
      }, { maxWait: 5000, timeout: 30000 });
      invalidateDatabaseCatalog(); return id;
    },
    async archiveProduct(actorId, productId) {
      await provider().$transaction(async tx => {
        await permit(tx, actorId, 'catalog');
        const product = await tx.products.findUnique({ where: { id: productId }, include: { catalog_details: true } });
        if (!product) throw new Error('PRODUCT_NOT_FOUND');
        const presentation = { ...(product.catalog_details?.presentation || {}), archivedAt: new Date().toISOString() };
        await tx.catalog_details.upsert({ where: { product_id: productId }, create: { product_id: productId, presentation }, update: { presentation } });
        await audit(tx, actorId, 'PRODUCT_ARCHIVED', productId);
      });
      invalidateDatabaseCatalog();
    },
    async restoreProduct(actorId, productId) {
      await provider().$transaction(async tx => {
        await permit(tx, actorId, 'catalog');
        const product = await tx.products.findUnique({ where: { id: productId }, include: { catalog_details: true } });
        if (!product) throw new Error('PRODUCT_NOT_FOUND');
        if (!product.catalog_details?.presentation?.archivedAt) throw new Error('PRODUCT_NOT_ARCHIVED');
        const presentation = { ...(product.catalog_details.presentation || {}) };
        delete presentation.archivedAt;
        await tx.catalog_details.update({ where: { product_id: productId }, data: { presentation } });
        await audit(tx, actorId, 'PRODUCT_RESTORED', productId);
      });
      invalidateDatabaseCatalog();
    },
    async permanentlyDeleteProduct(actorId, productId) {
      const result = await provider().$transaction(async tx => {
        await permit(tx, actorId, 'catalog');
        const product = await tx.products.findUnique({ where: { id: productId }, include: { product_images: true } });
        if (!product) throw new Error('PRODUCT_NOT_FOUND');
        const rootFolder = require('../config/cloudinary').readCloudinaryConfig().rootFolder;
        const cloudConfig = require('../config/cloudinary').readCloudinaryConfig();
        const publicIdFromUrl = value => {
          try {
            const url = new URL(value);
            if (url.origin !== 'https://res.cloudinary.com' || !url.pathname.startsWith(`/${cloudConfig.cloudName}/image/upload/`)) return '';
            const path = url.pathname.slice(`/${cloudConfig.cloudName}/image/upload/`.length).replace(/^v\d+\//, '');
            return decodeURIComponent(path).replace(/\.[a-zA-Z0-9]{2,5}$/, '');
          } catch { return ''; }
        };
        const images = [...product.product_images, ...(product.image_url ? [{ secure_url: product.image_url, public_id: publicIdFromUrl(product.image_url), asset_id: '' }] : [])]
          .map(image => ({ ...image, public_id: image.public_id || publicIdFromUrl(image.secure_url) }))
          .filter(image => image.public_id && image.public_id.startsWith(`${rootFolder}/`));
        const publicIds = [...new Set(images.map(image => image.public_id))];
        const otherImages = publicIds.length ? await tx.product_images.findMany({ where: { public_id: { in: publicIds }, product_id: { not: productId } }, select: { public_id: true } }) : [];
        const sharedIds = new Set(otherImages.map(image => image.public_id));
        const urls = images.map(image => image.secure_url);
        const [otherProducts, otherGalleryImages] = urls.length ? await Promise.all([
          tx.products.findMany({ where: { id: { not: productId }, image_url: { in: urls } }, select: { image_url: true } }),
          tx.product_images.findMany({ where: { product_id: { not: productId }, secure_url: { in: urls } }, select: { secure_url: true } }),
        ]) : [[], []];
        const categories = urls.length ? await tx.categories.findMany({ where: { image_url: { in: urls } }, select: { image_url: true } }) : [];
        const sharedUrls = new Set([...otherProducts.map(item => item.image_url), ...otherGalleryImages.map(item => item.secure_url), ...categories.map(item => item.image_url)]);
        const assets = [...new Map(images.filter(image => !sharedIds.has(image.public_id) && !sharedUrls.has(image.secure_url))
          .map(image => [image.public_id, { publicId: image.public_id, assetId: image.asset_id || null }])).values()];
        if (assets.length) await tx.cloudinary_cleanup_jobs.createMany({ data: assets.map(asset => ({ public_id: asset.publicId, asset_id: asset.assetId })) , skipDuplicates: true });
        // Keep the immutable order-item snapshot while removing its live product/variant links.
        await tx.order_items.updateMany({ where: { product_id: productId }, data: { product_id: null, variant_id: null } });
        await tx.discount_rules.deleteMany({ where: { scope: 'PRODUCT', target: productId } });
        await tx.product_options.deleteMany({ where: { product_id: productId } });
        await audit(tx, actorId, 'PRODUCT_PERMANENTLY_DELETED', productId);
        await tx.products.delete({ where: { id: productId } });
        return { queuedAssets: assets.length, assetPublicIds: assets.map(asset => asset.publicId), skippedSharedAssets: images.length - assets.length };
      }, { maxWait: 5000, timeout: 30000 });
      invalidateDatabaseCatalog(); return result;
    },
    async pendingCloudinaryCleanupJobs(limit = 20) {
      return provider().cloudinary_cleanup_jobs.findMany({ where: { status: 'PENDING', next_attempt_at: { lte: new Date() } }, orderBy: { created_at: 'asc' }, take: limit });
    },
    async hasPendingCloudinaryCleanup(publicIds) {
      if (!publicIds?.length) return false;
      return Boolean(await provider().cloudinary_cleanup_jobs.findFirst({ where: { status: 'PENDING', public_id: { in: publicIds } }, select: { id: true } }));
    },
    async completeCloudinaryCleanupJob(id) {
      await provider().cloudinary_cleanup_jobs.update({ where: { id }, data: { status: 'COMPLETE', completed_at: new Date(), last_error_code: '' } });
    },
    async retryCloudinaryCleanupJob(id, code = 'CLEANUP_FAILED') {
      const job = await provider().cloudinary_cleanup_jobs.findUnique({ where: { id }, select: { attempts: true } });
      if (!job) return;
      const attempts = job.attempts + 1;
      const delayMinutes = Math.min(1440, 2 ** Math.min(attempts, 10));
      await provider().cloudinary_cleanup_jobs.update({ where: { id }, data: { attempts, last_error_code: /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'CLEANUP_FAILED', next_attempt_at: new Date(Date.now() + delayMinutes * 60000) } });
    },
    async removeProductOffer(actorId, productId) {
      await provider().$transaction(async tx => {
        await permit(tx, actorId, 'catalog');
        const product = await tx.products.findUnique({ where: { id: productId }, select: { id: true, sale_price_egp: true } });
        if (!product) throw new Error('PRODUCT_NOT_FOUND');
        if (product.sale_price_egp == null) return;
        await tx.products.update({ where: { id: productId }, data: { sale_price_egp: null, updated_at: new Date() } });
        await audit(tx, actorId, 'PRODUCT_OFFER_REMOVED', productId);
      });
      invalidateDatabaseCatalog();
    },
    async saveCategory(actorId, data) {
      const row = await provider().$transaction(async tx => {
        await permit(tx, actorId, 'catalog');
        if (data.homeSectionId && !await tx.storefront_sections.findFirst({ where: { id: data.homeSectionId, is_active: true }, select: { id: true } })) throw new Error('INVALID_HOME_SECTION');
        const homepage_order = data.homeSectionId ? await tx.categories.count({ where: { home_section_id: data.homeSectionId } }) : 0;
        const id = randomUUID();
        const row = await tx.categories.create({ data: { id, source_id: `custom-${id}`, name: data.name, name_ar: data.nameAr, slug: data.slug, description: data.description, description_ar: data.descriptionAr, image_url: data.imageUrl, home_section_id: data.homeSectionId, homepage_order } });
        await audit(tx, actorId, 'CATEGORY_CREATED', row.id); return row;
      }); invalidateDatabaseCatalog(); return row;
    },
    async discounts() { return provider().discount_rules.findMany({ orderBy: { created_at: 'desc' }, take: 200 }); },
    async productOffers() {
      const db = provider();
      const [products, rules] = await Promise.all([
        db.products.findMany({ orderBy: { updated_at: 'desc' }, include: { catalog_details: true, product_categories: { select: { category_id: true } }, product_variants: { orderBy: { source_id: 'asc' } }, product_images: { where: { is_primary: true }, take: 1 } } }),
        activeDiscounts(db),
      ]);
      const now = new Date();
      return products.filter(product => !product.catalog_details?.presentation?.archivedAt).map(product => {
        const classified = { ...product, ...classification(product) };
        const directPrice = effectivePrice(classified, rules, now);
        const variantOffers = (product.product_variants || []).flatMap(variant => {
          const regular = Number(variant.price_egp);
          const sale = variantPrice(classified, variant, rules);
          const compare = sale < regular ? Math.max(regular, Number(variant.compare_at_egp || 0)) : Number(variant.compare_at_egp || 0);
          return compare > sale ? [{ title: variant.title, title_ar: variant.title_ar, color: variantColor(product, variant), sale_price_egp: sale, regular_price_egp: compare }] : [];
        });
        const directOffer = product.sale_price_egp != null && Number(product.sale_price_egp) < Number(product.price_egp);
        const offerVariants = variantOffers.length ? variantOffers : [];
        const salePrice = directOffer ? directPrice : offerVariants.length ? Math.min(...offerVariants.map(variant => variant.sale_price_egp)) : directPrice;
        const regularPrice = directOffer ? Number(product.price_egp) : offerVariants.length ? Math.max(...offerVariants.map(variant => variant.regular_price_egp)) : Number(product.price_egp);
        return { ...product, sale_price_egp: salePrice, offer_regular_price_egp: regularPrice, offer_variants: offerVariants,
          offer_source: directOffer ? 'product' : offerVariants.length ? 'variant' : 'campaign' };
      }).filter(product => product.sale_price_egp < product.offer_regular_price_egp);
    },
    async setProductOffer(actorId, productId, salePriceEgp) {
      await provider().$transaction(async tx => {
        await permit(tx, actorId, 'catalog');
        const product = await tx.products.findUnique({ where: { id: productId }, select: { id: true, price_egp: true } });
        if (!product) throw new Error('PRODUCT_NOT_FOUND');
        if (salePriceEgp >= product.price_egp) throw new Error('OFFER_PRICE_MUST_BE_LOWER');
        await tx.products.update({ where: { id: productId }, data: { sale_price_egp: salePriceEgp, updated_at: new Date() } });
        await audit(tx, actorId, 'PRODUCT_OFFER_SET', productId);
      });
      invalidateDatabaseCatalog();
    },
    async setColorOffer(actorId, productId, color, salePriceEgp) {
      await provider().$transaction(async tx => {
        await permit(tx, actorId, 'catalog');
        await tx.$queryRaw`SELECT id FROM public.products WHERE id=${productId}::uuid FOR UPDATE`;
        const product = await tx.products.findUnique({ where: { id: productId }, include: { catalog_details: true, product_variants: true } });
        if (!product) throw new Error('PRODUCT_NOT_FOUND');
        const variants = product.product_variants.filter(variant => variantColor(product, variant) === color);
        if (!variants.length) throw new Error('INVALID_COLOR_VARIANTS');
        if (salePriceEgp != null && salePriceEgp >= Math.min(...variants.map(variant => Number(variant.price_egp)))) throw new Error('OFFER_PRICE_MUST_BE_LOWER');
        const presentation = { ...product.catalog_details?.presentation };
        presentation.colorOffers = { ...presentation.colorOffers };
        if (salePriceEgp == null) delete presentation.colorOffers[color]; else presentation.colorOffers[color] = salePriceEgp;
        await tx.catalog_details.upsert({ where: { product_id: productId }, create: { product_id: productId, presentation }, update: { presentation } });
        await tx.products.update({ where: { id: productId }, data: { updated_at: new Date() } });
        await audit(tx, actorId, salePriceEgp == null ? 'COLOR_OFFER_REMOVED' : 'COLOR_OFFER_SET', productId);
      });
      invalidateDatabaseCatalog();
    },
    async saveDiscount(actorId, data) {
      const row = await provider().$transaction(async tx => {
        await permit(tx, actorId, 'catalog');
        if (data.scope === 'PRODUCT' && !await tx.products.findUnique({ where: { id: data.target }, select: { id: true } })) throw new Error('PRODUCT_NOT_FOUND');
        if (data.scope === 'CATEGORY' && !await tx.categories.findUnique({ where: { id: data.target }, select: { id: true } })) throw new Error('CATEGORY_NOT_FOUND');
        const row = await tx.discount_rules.create({ data: { name: data.name, name_ar: data.nameAr, mode: data.mode, amount: data.amount, scope: data.scope, target: data.target, starts_at: data.startsAt, ends_at: data.endsAt } });
        await audit(tx, actorId, 'DISCOUNT_CREATED', row.id); return row;
      }); invalidateDatabaseCatalog(); return row;
    },
    async disableDiscount(actorId, id) {
      await provider().$transaction(async tx => { await permit(tx, actorId, 'catalog'); await tx.discount_rules.update({ where: { id }, data: { is_active: false } }); await audit(tx, actorId, 'DISCOUNT_DISABLED', id); }); invalidateDatabaseCatalog();
    },
  };
}
module.exports = { createAdminManagementRepository };
