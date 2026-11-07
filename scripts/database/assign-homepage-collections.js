require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const { getPrismaClient, disconnectDatabase } = require('../../src/config/prisma');

const root = path.resolve(__dirname, '../..');
const preview = JSON.parse(fs.readFileSync(path.join(root, 'src/config/collection-preview.json'), 'utf8').replace(/^\uFEFF/, ''))
  .filter(category => category.group === 'primary' || category.group === 'secondary');
const slugs = preview.map(category => category.slug);

async function assignHomepageCollections(client = getPrismaClient()) {
  if (new Set(slugs).size !== slugs.length || !slugs.length) throw new Error('INVALID_HOMEPAGE_PREVIEW');
  return client.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('alreda-homepage-collections', 0))::text`;
    const sections = await tx.storefront_sections.findMany({ where: { slug: { in: ['home-primary', 'home-secondary'] }, is_active: true },
      select: { id: true, slug: true } });
    const sectionIds = new Map(sections.map(section => [section.slug, section.id]));
    if (sectionIds.size !== 2) throw new Error('HOMEPAGE_SECTIONS_MISSING');

    const categories = await tx.categories.findMany({ where: { slug: { in: slugs } },
      select: { id: true, slug: true, source_id: true, is_active: true } });
    const categoriesBySlug = new Map(categories.map(category => [category.slug, category]));
    if (categoriesBySlug.size !== slugs.length || categories.some(category => !category.source_id || !category.is_active)) {
      throw new Error('HOMEPAGE_COLLECTIONS_INCOMPLETE');
    }

    const orderByGroup = { primary: 0, secondary: 0 };
    for (const item of preview) {
      const category = categoriesBySlug.get(item.slug);
      await tx.categories.update({ where: { id: category.id }, data: { home_section_id: sectionIds.get(`home-${item.group}`),
        homepage_order: orderByGroup[item.group]++, updated_at: new Date() } });
    }
    return { updatedCollections: preview.length, primary: orderByGroup.primary, secondary: orderByGroup.secondary };
  }, { maxWait: 15000, timeout: 30000, isolationLevel: 'Serializable' });
}

if (require.main === module) {
  const client = getPrismaClient();
  assignHomepageCollections(client).then(result => console.info(JSON.stringify({ success: true, ...result })))
    .catch(error => { console.error(JSON.stringify({ success: false, code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'HOMEPAGE_COLLECTION_UPDATE_FAILED' })); process.exitCode = 1; })
    .finally(() => disconnectDatabase());
}
module.exports = { assignHomepageCollections };
