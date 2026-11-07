const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const { readCloudinaryConfig } = require('../config/cloudinary');
const { profiles } = require('./cloudinary.service');
const { assertManagedPublicId } = require('../utils/mediaPath');
const recordSchema = z.object({ publicId: z.string(), assetId: z.string().min(1), secureUrl: z.url(), version: z.number().int().positive(),
  resourceType: z.literal('image'), width: z.number().int().positive(), height: z.number().int().positive() }).passthrough();
const manifestSchema = z.object({ schemaVersion: z.literal(1), cloudName: z.string(), rootFolder: z.string(), assets: z.record(z.string(), recordSchema) });
function createMediaDelivery({ source = process.env, manifest: suppliedManifest } = {}) {
  const config = readCloudinaryConfig(source);
  const publicOnly = !config.enabled && source.MEDIA_PUBLIC_MANIFEST === 'true';
  let deliveryCloud = config.cloudName;
  let assets = {};
  if (config.enabled || publicOnly) {
    let candidate = suppliedManifest;
    if (!candidate) {
      try { candidate = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../config/cloudinary-media.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid Cloudinary media manifest', { cause: error }); }
    }
    if (candidate) {
      const result = manifestSchema.safeParse(candidate);
      if (!result.success || !/^[a-zA-Z0-9_-]{1,100}$/.test(result.data.cloudName) || result.data.rootFolder !== config.rootFolder) throw new Error('Invalid Cloudinary media manifest');
      deliveryCloud = result.data.cloudName;
      assets = result.data.assets;
      for (const record of Object.values(assets)) {
        assertManagedPublicId(record.publicId, config.rootFolder);
        const url = new URL(record.secureUrl);
        if (url.origin !== 'https://res.cloudinary.com' || !url.pathname.startsWith(`/${deliveryCloud}/image/upload/`)) throw new Error('Invalid Cloudinary media manifest');
      }
    }
  }
  const cloudinary = require('cloudinary').v2;
  // Existing public assets can keep using their manifest account while uploads use runtime credentials.
  const deliveryUrl = (asset, profile) => {
    if (!Object.hasOwn(profiles, profile)) throw new Error('Invalid media profile');
    return cloudinary.url(assertManagedPublicId(asset.publicId, config.rootFolder), { cloud_name: deliveryCloud, secure: true, resource_type: 'image', type: 'upload', sign_url: false,
      version: asset.version, width: profiles[profile], crop: 'limit', quality: 'auto', fetch_format: 'auto' });
  };
  const assetUrl = (key, fallback, profile = 'product-card') => assets[key] ? deliveryUrl(assets[key], profile) : fallback;
  function applyCatalog(catalog) {
    return { ...catalog, products: catalog.products.map(product => ({ ...product,
      gallery: product.gallery.map(image => {
        const asset = assets[`product:${product.sourceId}:${image.sourceId}`];
        if (!asset) return image;
        const cardSrc = deliveryUrl(asset, 'product-card');
        const displaySrc = deliveryUrl(asset, 'product-detail');
        return { ...image, cloudinary: asset, src: asset.secureUrl, cardSrc, displaySrc, thumbSrc: deliveryUrl(asset, 'thumbnail'),
          srcSet: asset.width > 640 ? `${cardSrc} 640w, ${displaySrc} ${Math.min(asset.width, 1200)}w` : `${displaySrc} ${asset.width}w` };
      }),
    })), collections: catalog.collections.map(category => ({ ...category,
      image: assetUrl(`collection:${category.sourceId}`, category.image, 'category-card') })) };
  }
  return { assetUrl, applyCatalog, cloudName: config.enabled || publicOnly ? deliveryCloud : null };
}
module.exports = { createMediaDelivery };
