'use strict';
(() => {
  const root = document.querySelector('[data-product-details]');
  if (!root) return;
  const mainPhoto = root.querySelector('#product-main-photo');
  const thumbnails = [...root.querySelectorAll('[data-gallery-src]')];
  function selectPhoto(button, reveal = false) {
    if (!button || !mainPhoto) return;
    if (mainPhoto.dataset.originalSrc !== button.dataset.gallerySrc) {
      mainPhoto.srcset = button.dataset.gallerySrcset;
      mainPhoto.src = button.dataset.galleryDisplay;
      mainPhoto.dataset.originalSrc = button.dataset.gallerySrc;
      mainPhoto.alt = button.dataset.galleryAlt;
    }
    thumbnails.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    if (reveal) {
      const strip = button.parentElement;
      const bounds = strip.getBoundingClientRect();
      const photo = button.getBoundingClientRect();
      if (photo.left < bounds.left || photo.right > bounds.right) {
        strip.scrollLeft += photo.left - bounds.left - (strip.clientWidth - photo.width) / 2;
      }
    }
  }
  thumbnails.forEach(button => button.addEventListener('click', () => {
    let colorImages = {}; try { colorImages = JSON.parse(root.dataset.colorImages || '{}'); } catch { /* Use variant image mappings. */ }
    const colors = Object.keys(colorImages).filter(color => colorImages[color] === button.dataset.gallerySrc);
    const candidates = (variants || []).filter(variant => colors.length === 1 ? variant.options.includes(colors[0]) : variant.gallerySrc === button.dataset.gallerySrc);
    // Preserve the closest type/size selection when a color has multiple variants.
    const score = variant => variant.options.reduce((sum, value, index) => sum + (value === current?.options[index] ? 1 : 0), 0);
    const candidate = candidates.sort((a, b) => score(b) - score(a))[0];
    if (candidate) renderVariant(candidate, true);
    selectPhoto(button);
  }));
  const swipeSurface = root.querySelector('[data-gallery-open]');
  if (swipeSurface && thumbnails.length > 1) {
    let touchStart = null;
    let suppressClick = false;
    swipeSurface.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'touch' || !event.isPrimary) return;
      touchStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
      suppressClick = false;
    });
    swipeSurface.addEventListener('pointerup', event => {
      if (!touchStart || event.pointerId !== touchStart.id) return;
      const horizontal = event.clientX - touchStart.x;
      const vertical = event.clientY - touchStart.y;
      touchStart = null;
      if (Math.abs(horizontal) < 45 || Math.abs(horizontal) < Math.abs(vertical) * 1.2) return;
      suppressClick = true;
      window.setTimeout(() => { suppressClick = false; }, 0);
      const selectedIndex = thumbnails.findIndex(button => button.getAttribute('aria-pressed') === 'true');
      const next = thumbnails[selectedIndex + (horizontal < 0 ? 1 : -1)];
      next?.click();
    });
    swipeSurface.addEventListener('pointercancel', () => { touchStart = null; });
    swipeSurface.addEventListener('click', event => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }
  const lightbox = root.querySelector('.product-lightbox');
  const opener = root.querySelector('[data-gallery-open]');
  opener?.addEventListener('click', () => {
    lightbox.querySelector('img').src = mainPhoto.dataset.originalSrc;
    lightbox.querySelector('img').alt = mainPhoto.alt;
    lightbox.showModal();
  });
  lightbox?.addEventListener('close', () => opener.focus());

  const quantity = root.querySelector('#product-quantity');
  let maxQuantity = Math.min(99, Number(quantity.max) || 99);
  function normalizedQuantity() {
    const value = Number(quantity.value);
    return Number.isInteger(value) ? Math.min(maxQuantity, Math.max(1, value)) : 1;
  }
  root.querySelectorAll('[data-quantity-change]').forEach(button => button.addEventListener('click', () => {
    quantity.value = String(Math.min(maxQuantity, Math.max(1, normalizedQuantity() + Number(button.dataset.quantityChange))));
  }));
  quantity.addEventListener('change', () => { quantity.value = String(normalizedQuantity()); });

  let variants;
  try { variants = JSON.parse(root.dataset.variants); } catch { return; }
  let current = variants.find(variant => variant.id === root.dataset.selectedVariant);
  if (!current) return;
  const groups = [...root.querySelectorAll('[data-option-index]')];
  function renderVariant(variant, updateUrl) {
    current = variant;
    root.dataset.purchaseVariant = variant.databaseId || '';
    maxQuantity = Math.min(99, Number(quantity.max) || 99);
    quantity.max = String(maxQuantity);
    quantity.value = String(normalizedQuantity());
    root.querySelectorAll('.add-to-cart').forEach(button => {
      button.dataset.productId = root.dataset.purchaseProduct || '';
      button.disabled = !variant.purchaseEligible || button.hasAttribute('data-buy-now') && root.dataset.checkoutEnabled !== 'true';
    });
    root.querySelector('[data-variant-price]').textContent = variant.currentFormatted;
    root.querySelector('[data-variant-availability]').textContent = variant.availabilityLabel;
    if (variant.gallerySrc) {
      const thumbnail = thumbnails.find(button => button.dataset.gallerySrc === variant.gallerySrc);
      selectPhoto(thumbnail, updateUrl);
    }
    const compare = root.querySelector('[data-variant-compare]');
    compare.textContent = variant.compareAtFormatted;
    compare.hidden = !variant.compareAtFormatted;
    root.querySelector('[data-variant-sale]').hidden = !variant.compareAtFormatted;
    root.querySelector('[data-variant-sku]').textContent = variant.sku;
    root.querySelector('[data-variant-sku-row]').hidden = !variant.sku;
    root.querySelector('[data-variant-status]').textContent = `${root.dataset.selectedLabel}: ${variant.title}`;
    root.querySelector('#variant-fallback').value = variant.id;
    for (const group of groups) {
      const index = Number(group.dataset.optionIndex);
      group.querySelectorAll('input').forEach(input => {
        input.checked = input.value === variant.options[index];
        input.disabled = !variants.some(candidate => candidate.options[index] === input.value
          && candidate.options.slice(0, index).every((value, position) => value === variant.options[position]));
      });
    }
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set('variant', variant.id);
      window.history.replaceState(null, '', url);
    }
  }
  groups.forEach(group => group.addEventListener('change', event => {
    if (!event.target.matches('input[type="radio"]')) return;
    const index = Number(group.dataset.optionIndex);
    const chosen = [...current.options];
    chosen[index] = event.target.value;
    const candidate = variants.find(variant => variant.options.every((value, position) => value === chosen[position]))
      || variants.find(variant => variant.options.slice(0, index + 1).every((value, position) => value === chosen[position]));
    if (candidate) {
      renderVariant(candidate, true);
      // A color choice shows its assigned color photo; type choices show the type photo.
      if (/color|colour|\u0627\u0644\u0644\u0648\u0646/i.test(group.querySelector('legend')?.textContent || '')) {
        let images = {}; try { images = JSON.parse(root.dataset.colorImages || '{}'); } catch { /* keep the variant photo */ }
        const photo = images[event.target.value];
        if (photo) selectPhoto(thumbnails.find(button => button.dataset.gallerySrc === photo), true);
      }
    }
  }));
  renderVariant(current, false);
  root.querySelector('.variant-fallback').hidden = true;
  root.querySelector('[data-product-options]').hidden = false;
})();
