'use strict';

(() => {
  const dialog = document.querySelector('[data-cart-dialog]');
  if (!dialog) return;
  const list = dialog.querySelector('[data-cart-items]');
  const status = dialog.querySelector('[data-cart-status]');
  const total = dialog.querySelector('[data-cart-total]');
  const bagButtons = [...document.querySelectorAll('[data-dialog="bag-dialog"]')];
  const badges = [...document.querySelectorAll('[data-cart-count]')];
  const feedback = document.querySelector('[data-cart-feedback]');
  let feedbackTimer;
  let revision = 0;
  const locale = document.documentElement.lang || 'en';
  const priceFormatter = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-EG', { style: 'currency', currency: 'EGP' });
  const price = value => priceFormatter.format(value);
  const refreshInterval = 5 * 60 * 1000;
  let cartSignature = '';
  let cartLoaded = false;
  let lastRefreshAt = 0;
  let refreshing = false;
  let mutationQueue = Promise.resolve();

  function mutate(input, method = 'POST') {
    // Queue writes across product cards and favorites. A late response must never
    // replace a newer bag snapshot, and one failed action must not block the next.
    revision++;
    const pending = mutationQueue.then(async () => {
      const cart = await request('/api/cart/items', { method, body: JSON.stringify(input) });
      render(cart); lastRefreshAt = Date.now();
      return cart;
    });
    mutationQueue = pending.catch(() => {});
    return pending;
  }
  window.AlredaCart = Object.freeze({ add: input => mutate(input) });

  function snapshot(cart) {
    return JSON.stringify((cart.cart_items || []).map(item => {
      const product = item.products;
      const variant = item.product_variants;
      return [item.product_id, item.variant_id, item.quantity, product.name, product.name_ar, product.image_url,
        product.price_egp, product.sale_price_egp, product.is_available,
        variant?.price_egp, variant?.is_available];
    }));
  }

  function added(holder) {
    if (!feedback) return;
    clearTimeout(feedbackTimer);
    const note = holder?.querySelector('[data-cart-status]');
    if (note) note.insertAdjacentElement('afterend', feedback);
    else if (holder) holder.append(feedback);
    feedback.querySelector('[data-cart-feedback-text]').textContent = dialog.dataset.addedText;
    feedback.hidden = false;
    feedbackTimer = setTimeout(() => { feedback.hidden = true; }, 3500);
  }

  async function request(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'CART_UNAVAILABLE');
    return data;
  }

  function render(cart) {
    const nextSignature = snapshot(cart);
    if (cartLoaded && nextSignature === cartSignature) return false;
    revision++;
    cartSignature = nextSignature;
    cartLoaded = true;
    list.replaceChildren();
    let subtotal = 0;
    let count = 0;
    for (const item of cart.cart_items || []) {
      const product = item.products;
      const itemPrice = product.sale_price_egp ?? product.price_egp;
      const variant = item.product_variants;
      const itemAvailable = product.is_available !== false && variant?.is_available !== false;
      subtotal += itemPrice * item.quantity;
      count += item.quantity;
      const row = document.createElement('li');
      row.className = 'bag-item';
      const photo = document.createElement('div'); photo.className = 'bag-item-photo'; photo.setAttribute('aria-hidden', 'true');
      if (product.image_url) {
        try {
          const url = new URL(product.image_url, window.location.origin);
          if (['https:', 'http:'].includes(url.protocol)) {
            const image = document.createElement('img'); image.className = 'bag-item-photo'; image.src = url.href; image.alt = ''; image.loading = 'lazy';
            image.addEventListener('error', () => image.remove(), { once: true }); photo.append(image);
          }
        } catch { /* Keep the neutral image frame when an image URL is invalid. */ }
      }
      const details = document.createElement('div'); details.className = 'bag-item-details';
      const name = document.createElement('span');
      name.className = 'bag-item-name';
      name.textContent = locale === 'ar' ? product.name_ar || product.name : product.name;
      const quantity = document.createElement('span'); quantity.className = 'bag-item-quantity';
      quantity.textContent = `${item.quantity} × ${price(itemPrice)}`;
      if (!itemAvailable) {
        const warning = document.createElement('small');
        warning.className = 'bag-stock-warning';
        warning.textContent = dialog.dataset.unavailableText;
        details.append(name, quantity, warning);
      } else {
        details.append(name, quantity);
      }
      const lineTotal = document.createElement('span'); lineTotal.className = 'bag-item-price'; lineTotal.textContent = price(itemPrice * item.quantity);
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'bag-remove'; remove.textContent = dialog.dataset.removeText;
      remove.setAttribute('aria-label', `${dialog.dataset.removeText}: ${name.textContent}`);
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try { await mutate({ productId: product.id, ...(item.variant_id ? { variantId: item.variant_id } : {}) }, 'DELETE'); }
        catch { status.textContent = dialog.dataset.errorText; }
        finally { remove.disabled = false; }
      });
      details.append(remove); row.append(photo, details, lineTotal); list.append(row);
    }
    badges.forEach(badge => { badge.textContent = count > 99 ? '99+' : String(count); badge.hidden = count === 0; });
    bagButtons.forEach(bagButton => bagButton.setAttribute('aria-label', count ? `${bagButton.dataset.bagLabel}: ${new Intl.NumberFormat(locale).format(count)}` : bagButton.dataset.bagLabel));
    status.textContent = cart.cart_items?.length ? '' : dialog.dataset.emptyText;
    total.replaceChildren();
    if (count) { const label = document.createElement('span'); label.textContent = dialog.dataset.totalText; const amount = document.createElement('strong'); amount.textContent = price(subtotal); total.append(label, amount); }
    const checkout = dialog.querySelector('[data-cart-checkout]');
    if (checkout) checkout.hidden = count === 0;
    lastRefreshAt = Date.now();
    return true;
  }

  async function refresh(quiet = false) {
    if (refreshing) return;
    const started = revision;
    refreshing = true;
    try {
      const cart = await request('/api/cart');
      if (started === revision) { render(cart); lastRefreshAt = Date.now(); }
    } catch { if (started === revision && (!quiet || dialog.open)) status.textContent = dialog.dataset.errorText; }
    finally { refreshing = false; }
  }

  function refreshIfDue() {
    if (!document.hidden && Date.now() - lastRefreshAt >= refreshInterval) refresh(true);
  }

  document.querySelectorAll('.add-to-cart[data-product-id]').forEach(button => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      if (feedback) feedback.hidden = true;
      const holder = button.closest('.product-card, [data-product-details]');
      const note = holder?.querySelector('[data-cart-status]');
      try {
        const quantity = Number(holder?.querySelector('#product-quantity')?.value || 1);
        const variantId = holder?.dataset.purchaseVariant || button.dataset.variantId;
        await mutate({ productId: button.dataset.productId, quantity, ...(variantId ? { variantId } : {}) });
        if (note) note.textContent = feedback ? '' : dialog.dataset.addedText;
        added(holder);
        if (button.hasAttribute('data-buy-now')) window.location.assign(dialog.querySelector('[data-cart-checkout]').getAttribute('href'));
      } catch (error) {
        if (note) note.textContent = ['PRODUCT_UNAVAILABLE', 'INSUFFICIENT_INVENTORY', 'PRODUCT_OPTIONS_NOT_SUPPORTED'].includes(error.message) ? dialog.dataset.unavailableText : dialog.dataset.errorText;
      } finally { button.disabled = false; }
    });
  });

  bagButtons.forEach(bagButton => bagButton.addEventListener('click', refresh));
  document.addEventListener('cart:refresh', event => {
    if (Array.isArray(event.detail?.cart_items)) {
      revision++; render(event.detail); lastRefreshAt = Date.now();
    } else refresh();
  });
  if (badges.length) refresh();
  window.addEventListener('pageshow', event => { if (event.persisted && badges.length) refresh(); });
  window.setInterval(refreshIfDue, refreshInterval);
  document.addEventListener('visibilitychange', refreshIfDue);
  window.addEventListener('focus', refreshIfDue);
})();
