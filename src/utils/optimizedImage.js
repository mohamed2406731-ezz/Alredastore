const widths = Object.freeze({ thumbnail: 160, 'product-card': 640, 'product-detail': 1200, 'category-card': 640 });
const legacyUrls = require('../config/cloudinary-media.json').legacyUrls || {};

function rehostCloudinaryUrl(value) {
  return typeof value === 'string' ? legacyUrls[value] || value : value;
}

// Public upload delivery only: never rewrite signed/private assets or remote URLs.
// Preserve the upload version and public ID so replacements invalidate CDN caches.
function optimizedImageUrl(value, profile) {
  value = rehostCloudinaryUrl(value);
  if (!value || !Object.hasOwn(widths, profile)) return value;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://res.cloudinary.com' || url.search || url.hash) return value;
    const match = url.pathname.match(/^(\/[^/]+\/image\/upload\/)(.+)$/);
    if (!match || match[2].startsWith('s--')) return value;
    const transform = `c_limit,w_${widths[profile]}/q_auto/f_auto/`;
    const version = match[2].search(/(?:^|\/)v\d+\//);
    const existing = version > 0 ? match[2].slice(0, version + 1) : '';
    const tokens = new Set(existing.split(/[,/]/));
    if (['c_limit', `w_${widths[profile]}`, 'q_auto', 'f_auto'].every(token => tokens.has(token))) return value;
    if (existing.endsWith(transform) || match[2].startsWith(transform) && version < 0) return value;
    const asset = version > 0 ? match[2].slice(version + 1) : match[2];
    // Keep any deliberate crop/overlay transformations before the final size limit.
    url.pathname = `${match[1]}${existing}${transform}${asset}`;
    return url.href;
  } catch { return value; }
}
module.exports = { optimizedImageUrl, rehostCloudinaryUrl };
