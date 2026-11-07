require('dotenv').config({ quiet: true });
const fs = require('node:fs/promises');
const path = require('node:path');
const cloudinary = require('cloudinary').v2;
const { readCloudinaryConfig } = require('../src/config/cloudinary');

const source = readCloudinaryConfig({ ...process.env,
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_SOURCE_CLOUD_NAME || process.env.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_SOURCE_API_KEY || process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_SOURCE_API_SECRET || process.env.CLOUDINARY_API_SECRET,
});
const target = {
  cloudName: process.env.CLOUDINARY_TARGET_CLOUD_NAME || '',
  apiKey: process.env.CLOUDINARY_TARGET_API_KEY || '',
  apiSecret: process.env.CLOUDINARY_TARGET_API_SECRET || '',
  rootFolder: process.env.CLOUDINARY_ROOT_FOLDER || 'alreda-store',
};
if (!source.enabled || !target.cloudName || !target.apiKey || !target.apiSecret) throw new Error('CLOUDINARY_SOURCE_OR_TARGET_NOT_CONFIGURED');
if (source.cloudName === target.cloudName) throw new Error('CLOUDINARY_SOURCE_AND_TARGET_MUST_DIFFER');
if (source.rootFolder !== target.rootFolder) throw new Error('CLOUDINARY_ROOT_FOLDER_MISMATCH');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'src/config/cloudinary-media.json');
const statePath = path.join(root, 'data/media/cloudinary-account-copy.json');
const auth = config => ({ cloud_name: config.cloudName, api_key: config.apiKey, api_secret: config.apiSecret, secure: true, timeout: 60000 });
const sourceAuth = auth(source);
const targetAuth = auth(target);
const kinds = ['upload', 'authenticated', 'private'];
const writeJson = async (filename, value) => {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const pending = `${filename}.pending`;
  await fs.writeFile(pending, `${JSON.stringify(value, null, 2)}\n`);
  await fs.copyFile(pending, filename);
  await fs.unlink(pending);
};

async function listAll(config, type) {
  const results = [];
  let cursor;
  do {
    const response = await cloudinary.api.resources({ ...auth(config), resource_type: 'image', type,
      prefix: `${target.rootFolder}/`, max_results: 500, ...(cursor ? { next_cursor: cursor } : {}) });
    results.push(...(response.resources || []).map(resource => ({ ...resource, type })));
    cursor = response.next_cursor;
  } while (cursor);
  return results;
}

async function uploadFromSource(resource) {
  const sourceUrl = resource.type === 'upload' ? resource.secure_url
    : cloudinary.utils.private_download_url(resource.public_id, resource.format, {
      ...sourceAuth, resource_type: 'image', type: resource.type,
      expires_at: Math.floor(Date.now() / 1000) + 300, attachment: false,
    });
  const folder = resource.asset_folder || resource.public_id.split('/').slice(0, -1).join('/');
  const options = { ...targetAuth, resource_type: 'image', type: resource.type, public_id: resource.public_id,
    overwrite: false, unique_filename: false, use_filename: false, tags: resource.tags || [],
    ...(resource.context ? { context: resource.context.custom || resource.context } : {}),
    ...(folder ? { asset_folder: folder, use_asset_folder_as_public_id_prefix: false } : {}) };
  const uploaded = await cloudinary.uploader.upload(sourceUrl, options);
  if (uploaded.public_id !== resource.public_id || uploaded.resource_type !== 'image' || uploaded.type !== resource.type
    || uploaded.width !== resource.width || uploaded.height !== resource.height) throw new Error('CLOUDINARY_COPY_VERIFICATION_FAILED');
  return uploaded;
}

async function main() {
  const sourceResources = (await Promise.all(kinds.map(async type => (await listAll(source, type)).map(resource => ({ ...resource, type }))))).flat();
  const targetResources = (await Promise.all(kinds.map(type => listAll(target, type)))).flat();
  const targetByKey = new Map(targetResources.map(resource => [`${resource.type}:${resource.public_id}`, resource]));
  const state = { sourceCloudName: source.cloudName, targetCloudName: target.cloudName, rootFolder: target.rootFolder, assets: {}, failures: [] };
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (![source.cloudName, target.cloudName].includes(manifest.cloudName) || manifest.rootFolder !== source.rootFolder) throw new Error('SOURCE_MANIFEST_MISMATCH');
  const previous = await fs.readFile(statePath, 'utf8').then(JSON.parse).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (previous?.sourceCloudName === source.cloudName && previous?.targetCloudName === target.cloudName
    && previous.rootFolder === target.rootFolder) Object.assign(state.assets, previous.assets || {});

  let nextIndex = 0;
  let completed = 0;
  let checkpointQueue = Promise.resolve();
  const checkpoint = () => {
    checkpointQueue = checkpointQueue.then(async () => {
      await writeJson(statePath, state);
      console.info(JSON.stringify({ copied: completed, total: sourceResources.length, failures: state.failures.length }));
    });
    return checkpointQueue;
  };
  const worker = async () => {
    while (nextIndex < sourceResources.length) {
      const index = nextIndex++;
      const resource = sourceResources[index];
      const key = `${resource.type}:${resource.public_id}`;
      try {
        let result = targetByKey.get(key);
        if (!result) result = await uploadFromSource(resource);
        else if (result.width !== resource.width || result.height !== resource.height || result.format !== resource.format) throw new Error('TARGET_ASSET_CONFLICT');
        state.assets[key] = { publicId: result.public_id, type: resource.type, resourceType: 'image', assetId: result.asset_id,
          secureUrl: result.secure_url, version: result.version, width: result.width, height: result.height, format: result.format,
          bytes: result.bytes, assetFolder: result.asset_folder || resource.asset_folder || '' };
      } catch (error) {
        state.failures.push({ type: resource.type, publicId: resource.public_id,
          code: ['TARGET_ASSET_CONFLICT', 'CLOUDINARY_COPY_VERIFICATION_FAILED'].includes(error.message) ? error.message : 'COPY_FAILED' });
      }
      completed += 1;
      if (completed % 25 === 0 || completed === sourceResources.length) await checkpoint();
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, sourceResources.length) }, worker));
  await checkpointQueue;

  const manifestAssets = Object.entries(manifest.assets || {});
  const updatedAssets = {};
  for (const [key, old] of manifestAssets) {
    const copied = state.assets[`upload:${old.publicId}`];
    if (!copied) state.failures.push({ key, code: 'MANIFEST_ASSET_NOT_COPIED' });
    else updatedAssets[key] = { ...old, assetId: copied.assetId, secureUrl: copied.secureUrl, version: copied.version,
      width: copied.width, height: copied.height, format: copied.format, bytes: copied.bytes,
      folder: copied.assetFolder || old.folder };
  }
  await writeJson(statePath, state);
  if (state.failures.length) {
    console.error(JSON.stringify({ complete: false, copied: Object.keys(state.assets).length, total: sourceResources.length,
      manifestAssets: manifestAssets.length, failures: state.failures.length, manifestUpdated: false }));
    process.exitCode = 1;
    return;
  }

  const legacyUrls = Object.fromEntries(sourceResources.map(resource => {
    const copied = state.assets[`${resource.type}:${resource.public_id}`];
    if (!copied || !resource.secure_url) throw new Error('SOURCE_URL_MAPPING_INCOMPLETE');
    return [resource.secure_url, copied.secureUrl];
  }));
  const updatedManifest = { ...manifest, cloudName: target.cloudName, assets: updatedAssets, legacyUrls };
  await writeJson(manifestPath, updatedManifest);
  console.info(JSON.stringify({ complete: true, copied: Object.keys(state.assets).length,
    total: sourceResources.length, manifestAssets: manifestAssets.length, failures: 0, manifestUpdated: true }));
}

main().catch(error => {
  const allowed = ['CLOUDINARY_SOURCE_OR_TARGET_NOT_CONFIGURED', 'CLOUDINARY_SOURCE_AND_TARGET_MUST_DIFFER',
    'CLOUDINARY_ROOT_FOLDER_MISMATCH', 'SOURCE_MANIFEST_MISMATCH', 'SOURCE_URL_MAPPING_INCOMPLETE'];
  console.error(JSON.stringify({ complete: false, code: error.message === 'CLOUDINARY_SOURCE_OR_TARGET_NOT_CONFIGURED'
    || error.message === 'CLOUDINARY_SOURCE_AND_TARGET_MUST_DIFFER' || error.message === 'CLOUDINARY_ROOT_FOLDER_MISMATCH'
    || error.message === 'SOURCE_MANIFEST_MISMATCH' || error.message === 'SOURCE_URL_MAPPING_INCOMPLETE'
    ? error.message : 'CLOUDINARY_MIGRATION_FAILED', errorType: error.name, systemCode: allowed.includes(error.code) ? error.code : null }));
  process.exitCode = 1;
});
