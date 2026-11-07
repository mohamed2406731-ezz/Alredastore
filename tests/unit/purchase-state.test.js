const { randomUUID } = require('node:crypto');
const { purchaseState } = require('../../src/utils/purchaseState');
const { productCard } = require('../../src/utils/productPreview');
const ready = () => ({ id: randomUUID(), sourceId: 'test', slug: 'test', name: 'Test item', titleEn: 'Test item', stock_quantity: 5, isAvailable: true, options: [], gallery: [], variants: [{ id: '1', title: 'Default Title', options: ['Default Title'], priceAmount: '100.00', publicAvailable: true }] });
describe('truthful purchase readiness', () => {
  it('allows an active persisted product without tracking stock quantities', () => {
    expect(purchaseState(ready())).toBe('ready');
    const item = ready(); item.stock_quantity = null; expect(purchaseState(item)).toBe('ready');
    item.stock_quantity = 0; expect(purchaseState(item)).toBe('ready');
    item.stock_quantity = 5; item.isAvailable = false; expect(purchaseState(item)).toBe('productNotForSale');
  });
  it('does not treat snapshot IDs or unsupported variants as connected purchases', () => {
    const item = ready(); item.id = '123'; expect(purchaseState(item)).toBe('catalogOnly');
    item.id = randomUUID(); item.variants.push({ ...item.variants[0], id: '2' }); expect(purchaseState(item)).toBe('variantPurchasingPending');
  });
  it('shows availability without stock messaging for a purchasable item', () => {
    const card = productCard(ready(), ''); expect(card.purchaseEligible).toBe(true); expect(card.availability.label).toBe('Available');
  });
  it('uses persistent variant availability independent of inventory quantities', () => {
    const item = ready(); item.stock_quantity = null;
    item.variants[0] = { ...item.variants[0], databaseId: randomUUID(), inventoryQuantity: 3 };
    expect(purchaseState(item)).toBe('ready');
    item.variants[0].inventoryQuantity = 0;
    expect(purchaseState(item)).toBe('ready');
  });
});
