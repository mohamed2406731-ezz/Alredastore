const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function purchaseState(record) {
  if (!uuid.test(record.id || '')) return 'catalogOnly';
  if (record.isAvailable === false) return 'productNotForSale';
  const persisted = (record.variants || []).filter(variant => uuid.test(variant.databaseId || ''));
  if (persisted.length) {
    if (persisted.some(variant => variant.publicAvailable === true)) return 'ready';
    return persisted.every(variant => variant.publicAvailable === false) ? 'productNotForSale' : 'ready';
  }
  const choice = (record.variants?.length || 0) > 1 || (record.options || []).some(option => (option.values || []).some(value => value !== 'Default Title'));
  if (choice) return 'variantPurchasingPending';
  return 'ready';
}
module.exports = { purchaseState };
