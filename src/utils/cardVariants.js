const formatPrice = require('./formatPrice');
const { valueName, variantName } = require('../config/storefront-i18n');
const { resolveColorSwatches } = require('../config/catalog-colors');
const setCollectionIds = new Set(require('../config/catalog.json').collections.filter(collection => /sets?/i.test(collection.slug)).map(collection => collection.sourceId));
function cardVariants(record, locale) {
  const gallery = (record.gallery || []).map(image => ({ id: image.sourceId, src: image.cardSrc || image.src })).filter(image => image.src);
  const variants = (record.variants || []).map(variant => {
    const associated = (record.gallery || []).find(image => image.sourceId === variant.imageId)
      || (record.gallery || []).find(image => image.variantIds?.includes(variant.id));
    const image = gallery.find(image => image.id === associated?.sourceId) || gallery[0];
    const compare = variant.compareAtAmount && Number(variant.compareAtAmount) > Number(variant.priceAmount);
    const outOfStock = variant.inventoryQuantity === 0;
    return { id: variant.id, options: variant.options || [], title: variantName(variant.title, locale), image: image?.src || null, outOfStock,
      price: formatPrice(variant.priceAmount, locale), compare: compare ? formatPrice(variant.compareAtAmount, locale) : '',
      availability: outOfStock ? require('../config/storefront-i18n').translate(locale, 'outOfStock') : variant.inventoryQuantity > 0 ? require('../config/storefront-i18n').translate(locale, 'stockAvailable') : variant.publicAvailable === false ? require('../config/storefront-i18n').translate(locale, 'unavailable') : require('./productPreview').availability([variant], locale).label };
  });
  const groups = (record.options || []).map((option, index) => ({ index, name: valueName(option.name, locale), isColor: /colou?r|لون/i.test(option.name),
    values: (option.values || []).filter(value => value !== 'Default Title' && variants.some(variant => variant.options[index] === value)).map(value => {
      const color = /colou?r|لون/i.test(option.name);
      const variant = variants.find(variant => variant.options[index] === value);
      const resolved = color ? resolveColorSwatches(value)[0] : null;
      const hex = resolved?.hex || '';
      const swatch = resolved ? resolved.en.toLowerCase().replaceAll(' ', '-') : '';
      return { value, label: valueName(value, locale), color: hex, swatch, thumbnail: color && !hex ? variant?.image : null };
    }) })).filter(group => group.values.length);
  const details = record.catalogDetails || record.catalog_details || {};
  const presentation = details.presentation || {};
  const resolveImage = url => gallery.find(image => image.src === url || (record.gallery || []).some(original => original.src === url && original.sourceId === image.id))?.src;
  const isSet = Boolean(presentation.mobileImage) || (record.collectionIds || []).some(id => setCollectionIds.has(id)) || /\bsets?\b|bathroom accessories|طقم|أطقم|إكسسوارات حمام/i.test([record.name, record.titleEn, record.titleAr, record.productType, details.type_en].filter(Boolean).join(' '));
  const fullSet = (record.gallery || []).find(image => /complete set|full set|طقم كامل/i.test(image.alt || ''));
  const mobileImage = resolveImage(presentation.mobileImage) || (isSet ? (fullSet?.cardSrc || fullSet?.src || gallery[0]?.src) : null);
  const colorImages = { ...Object.fromEntries((record.options || []).flatMap((option, index) => /colou?r/i.test(option.name)
    ? option.values.map(value => [value, variants.find(variant => variant.options[index] === value)?.image]) : [])), ...Object.fromEntries(Object.entries(presentation.colorImages || {}).map(([color, url]) => [color, resolveImage(url)])) };
  const storedColor = details.color_en || details.color_ar || '';
  const catalogColors = groups.some(group => group.isColor) ? [] : resolveColorSwatches(storedColor).map(color => ({ label: locale === 'ar' ? color.ar : color.en, hex: color.hex }));
  return { gallery: gallery.map(image => image.src), variants, groups, catalogColors, mobileImage, isSet,
    hoverImage: resolveImage(presentation.hoverImage) || gallery[1]?.src || null, colorImages,
    chooseLabel: locale === 'ar' ? 'اختيار الخيارات' : 'Choose options' };
}
module.exports = { cardVariants };
