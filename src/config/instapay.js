const { z } = require('zod');
const schema = z.object({ INSTAPAY_ENABLED: z.enum(['true','false']).default('false'), INSTAPAY_PHONE: z.string().trim().default(''),
  INSTAPAY_URL: z.string().trim().default(''), INSTAPAY_QR_URL: z.string().trim().default('') });
function readInstaPayConfig(source = process.env) {
  const normalized = { ...source, ...(typeof source.INSTAPAY_ENABLED === 'string' ? { INSTAPAY_ENABLED: source.INSTAPAY_ENABLED.trim().toLowerCase() } : {}) };
  const value = schema.parse(normalized);
  const safeLink = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } };
  const qrValid = !value.INSTAPAY_QR_URL || /^\/assets\/[a-zA-Z0-9_./-]+\.(png|jpe?g|webp)$/i.test(value.INSTAPAY_QR_URL) && !value.INSTAPAY_QR_URL.includes('..')
    || safeLink(value.INSTAPAY_QR_URL) && new URL(value.INSTAPAY_QR_URL).hostname === 'res.cloudinary.com';
  const ready = value.INSTAPAY_ENABLED === 'true' && /^\+?[0-9]{8,15}$/.test(value.INSTAPAY_PHONE) && (!value.INSTAPAY_URL || safeLink(value.INSTAPAY_URL)) && qrValid && Boolean(value.INSTAPAY_URL || value.INSTAPAY_QR_URL);
  return { enabled: ready, phone: ready ? value.INSTAPAY_PHONE : '', url: ready ? value.INSTAPAY_URL : '', qrUrl: ready ? value.INSTAPAY_QR_URL : '' };
}
module.exports = { readInstaPayConfig };
