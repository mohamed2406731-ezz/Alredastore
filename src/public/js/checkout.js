(() => {
  const form = document.querySelector('#checkout-form');
  if (!form) return;
  const status = document.querySelector('#checkout-status');
  const result = document.querySelector('#checkout-result');
  const submit = form.querySelector('[type="submit"]');
  const check = document.querySelector('#check-order');
  const startNew = document.querySelector('#new-order');
  const msg = (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), form.dataset[key] || '');
  const locale = form.dataset.locale || 'en';
  const money = amount => new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-EG', { style: 'currency', currency: 'EGP', maximumFractionDigits: 0 }).format(Number(amount));
  const paymentName = value => ({ PAID: msg('paid'), PENDING: msg('pending'), UNPAID: msg('unpaid'), FAILED: msg('unpaid') })[value] || value;
  const storageKey = 'alreda.checkout.request-key';
  let key = form.dataset.requestKey;
  let busy = false;
  let canStartNew = false;
  let deliveryLocation = null;
  let locating = false;
  let paymentProofId = '';
  let uploadingProof = false;
  let uploadRevision = 0;
  const paymentDialog = document.querySelector('[data-instapay-dialog]');
  const paymentMessages = form.querySelector('[data-insta-messages]')?.dataset || {};
  const openPayment = form.querySelector('[data-open-instapay]');
  const paymentMethod = () => form.elements.paymentMethod.value;
  function updatePaymentState() {
    submit.disabled = busy || locating || paymentMethod() === 'INSTAPAY' && (uploadingProof || !paymentProofId);
    if (openPayment) openPayment.hidden = paymentMethod() !== 'INSTAPAY';
  }
  function showPayment() { if (paymentDialog && !paymentDialog.open) paymentDialog.showModal(); }
  form.querySelectorAll('[name="paymentMethod"]').forEach(input => input.addEventListener('change', () => { updatePaymentState(); if (paymentMethod() === 'INSTAPAY') showPayment(); }));
  openPayment?.addEventListener('click', showPayment);
  paymentDialog?.querySelector('[data-close-instapay]')?.addEventListener('click', () => paymentDialog.close());
  paymentDialog?.addEventListener('close', () => { if (paymentMethod() === 'INSTAPAY') openPayment?.focus(); });
  paymentDialog?.querySelector('[data-payment-continue]')?.addEventListener('click', () => { if (paymentProofId && !uploadingProof) { paymentDialog.close(); submit.focus(); } });
  paymentDialog?.querySelector('[data-payment-file]')?.addEventListener('change', async event => {
    const revision = ++uploadRevision, file = event.target.files[0];
    paymentProofId = ''; uploadingProof = false;
    const note = paymentDialog.querySelector('[data-payment-upload-status]'), preview = paymentDialog.querySelector('[data-payment-preview]'), proceed = paymentDialog.querySelector('[data-payment-continue]');
    proceed.disabled = true; preview.hidden = true;
    if (!file || !['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 5242880) { note.textContent = paymentMessages.uploadError; updatePaymentState(); return; }
    uploadingProof = true; updatePaymentState(); note.textContent = paymentMessages.uploading;
    const reader = new FileReader(); reader.addEventListener('load', () => { if (revision === uploadRevision) { preview.src = reader.result; preview.hidden = false; } }); reader.readAsDataURL(file);
    try {
      const body = new FormData(); body.append('proof', file);
      const response = await fetch('/api/payments/instapay/proof', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'alreda-checkout' }, body });
      const data = await response.json();
      if (revision !== uploadRevision) return;
      if (!response.ok || !validKey(data.proofId)) throw new Error('PAYMENT_UPLOAD_FAILED');
      paymentProofId = data.proofId; note.textContent = paymentMessages.uploaded; proceed.disabled = false;
    } catch { if (revision === uploadRevision) note.textContent = paymentMessages.uploadError; }
    finally { if (revision === uploadRevision) { uploadingProof = false; updatePaymentState(); } }
  });
  const locationButton = form.querySelector('[data-pick-location]');
  const locationStatus = form.querySelector('[data-location-status]');
  const locationResult = form.querySelector('[data-location-result]');
  let locationRevision = 0;
  let addressRequest;
  function finishLocation() { locating = false; locationButton.disabled = busy; updatePaymentState(); }
  locationButton?.addEventListener('click', () => {
    if (busy) return;
    if (!window.isSecureContext || !navigator.geolocation) { locationStatus.textContent = msg('locationUnsupported'); return; }
    const revision = ++locationRevision;
    const addressField = form.elements.address;
    const originalAddress = addressField.value;
    locating = true; submit.disabled = true; locationButton.disabled = true; locationStatus.textContent = msg('locationBusy');
    try { navigator.geolocation.getCurrentPosition(async position => {
      if (revision !== locationRevision) return;
      const { latitude, longitude, accuracy } = position.coords;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) { finishLocation(); locationStatus.textContent = msg('locationError'); return; }
      deliveryLocation = { latitude, longitude, ...(Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 1000000 ? { accuracyM: accuracy } : {}) };
      locationResult.hidden = false;
      const controller = new AbortController(); addressRequest = controller;
      const timeout = setTimeout(() => controller.abort(), 9000);
      try {
        const response = await fetch('/api/checkout/location', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'alreda-checkout' }, body: JSON.stringify({ latitude, longitude, locale }) });
        const data = await response.json();
        if (revision !== locationRevision) return;
        if (!response.ok || typeof data.address !== 'string' || data.address.length < 5 || data.address.length > 300) throw new Error('ADDRESS_LOOKUP_UNAVAILABLE');
        if (addressField.value === originalAddress) { addressField.value = data.address; addressField.dispatchEvent(new Event('input', { bubbles: true })); locationStatus.textContent = msg('locationReady'); }
        else locationStatus.textContent = msg('locationKept');
      } catch { if (revision === locationRevision) locationStatus.textContent = msg('locationLookupFailed'); }
      finally { clearTimeout(timeout); if (revision === locationRevision) { addressRequest = null; finishLocation(); } }
    }, error => {
      if (revision !== locationRevision) return;
      finishLocation(); locationStatus.textContent = msg(error.code === 1 ? 'locationDenied' : 'locationError');
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }); }
    catch { if (revision === locationRevision) { finishLocation(); locationStatus.textContent = msg('locationError'); } }
  });
  form.querySelector('[data-remove-location]')?.addEventListener('click', () => {
    locationRevision++; deliveryLocation = null; locationResult.hidden = true; finishLocation();
    addressRequest?.abort(); addressRequest = null; locationStatus.textContent = '';
  });
  const fragmentKey = new URLSearchParams(location.hash.slice(1)).get('request');
  const validKey = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  let savedKey;
  try { savedKey = sessionStorage.getItem(storageKey); } catch { /* URL fragment retains retries when storage is blocked. */ }
  const retained = validKey(fragmentKey) ? fragmentKey : validKey(savedKey) ? savedKey : null;
  const previousRequest = Boolean(retained); key = retained || key;
  try { sessionStorage.setItem(storageKey, key); } catch { /* No customer/order data is stored in browser storage. */ }
  history.replaceState(null, '', `${location.pathname}${location.search}#request=${key}`);
  function rotateRequestKey() {
    key = crypto.randomUUID();
    try { sessionStorage.setItem(storageKey, key); } catch { /* The URL fragment retains retries when storage is blocked. */ }
    history.replaceState(null, '', `${location.pathname}${location.search}#request=${key}`);
  }
  function total() {
    const lines = [...form.querySelectorAll('[data-product-id]')].filter(input => Number(input.value) > 0);
    return lines.reduce((sum, input) => sum + Number(input.value) * Number(input.dataset.price), 0) + Number(form.elements.city.selectedOptions[0]?.dataset.fee || 0);
  }
  function refreshTotal() {
    const shipping = Number(form.elements.city.selectedOptions[0]?.dataset.fee || 0);
    document.querySelector('#checkout-total').textContent = money(total());
    const subtotal = form.querySelector('[data-checkout-subtotal]'), delivery = form.querySelector('[data-checkout-shipping]');
    if (subtotal) subtotal.textContent = money(total() - shipping);
    if (delivery) delivery.textContent = money(shipping);
    const instaAmount = paymentDialog?.querySelector('[data-instapay-amount]'); if (instaAmount) instaAmount.textContent = money(total());
  }
  const inventoryInputs = [...form.querySelectorAll('[data-product-id]')];
  const inventoryRefreshInterval = 5 * 60 * 1000;
  let inventoryRefreshing = false;
  let lastInventoryRefreshAt = Date.now();
  function showStockWarning(input) {
    const warning = input.closest('.checkout-quantity')?.querySelector('[data-checkout-stock-status]');
    if (!warning) return;
    const available = input.dataset.available === 'true';
    warning.textContent = input.dataset.removed === 'true'
      ? msg('itemRemoved')
      : !available ? msg('orderProductUnavailable') : '';
    warning.hidden = !warning.textContent;
  }
  for (const input of inventoryInputs) {
    const row = input.closest('.checkout-product');
    input.dataset.liveState = JSON.stringify([
      Number(input.dataset.price), input.dataset.available,
      row?.querySelector('[data-checkout-product-name]')?.textContent || '',
      row?.querySelector('[data-checkout-product-image]')?.getAttribute('src') || '',
    ]);
    showStockWarning(input);
  }
  async function refreshInventory() {
    if (busy || canStartNew || form.hidden || inventoryRefreshing || document.hidden) return;
    inventoryRefreshing = true;
    try {
      const response = await fetch('/api/cart', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('CART_UNAVAILABLE');
      const cart = await response.json();
      // Ignore work started before submission or confirmation. It must not
      // overwrite the receipt/status or the submitted totals with a late reply.
      if (busy || canStartNew || form.hidden) return;
      const items = new Map((cart.cart_items || []).map(item => [item.variant_id || item.product_id, item]));
      let changed = false;
      for (const input of inventoryInputs) {
        const key = input.dataset.variantId || input.dataset.productId;
        const item = items.get(key);
        if (!item) {
          if (input.dataset.cartManaged === 'true' && input.dataset.removed !== 'true') {
            input.dataset.removed = 'true';
            showStockWarning(input);
            changed = true;
          }
          continue;
        }
        const product = item.products;
        const variant = item.product_variants;
        const available = product.is_available !== false && variant?.is_available !== false;
        const unitPrice = product.sale_price_egp ?? product.price_egp;
        const name = locale === 'ar' ? product.name_ar || product.name : product.name;
        const image = product.image_url || '';
        const signature = JSON.stringify([Number(unitPrice), String(available), name, image]);
        if (input.dataset.liveState === signature && input.dataset.removed !== 'true') continue;
        input.dataset.liveState = signature;
        input.dataset.price = String(unitPrice);
        input.dataset.available = String(available);
        delete input.dataset.removed;
        input.max = '50';
        const row = input.closest('.checkout-product');
        const productName = row?.querySelector('[data-checkout-product-name]');
        if (productName) productName.textContent = name;
        const priceLabel = row?.querySelector('.checkout-product-name small');
        if (priceLabel) priceLabel.textContent = money(unitPrice);
        let imageElement = row?.querySelector('[data-checkout-product-image]');
        if (image) {
          if (!imageElement) {
            imageElement = document.createElement('img');
            imageElement.width = 56; imageElement.height = 64; imageElement.loading = 'lazy'; imageElement.alt = '';
            imageElement.dataset.checkoutProductImage = '';
            row?.querySelector('.checkout-product-name')?.before(imageElement);
          }
          imageElement.src = image;
        } else if (imageElement) imageElement.remove();
        showStockWarning(input);
        changed = true;
      }
      if (changed) {
        refreshTotal();
        status.textContent = msg('itemsUpdated');
      } else if (status.textContent === msg('inventoryRefreshError')) {
        status.textContent = '';
      }
      lastInventoryRefreshAt = Date.now();
    } catch {
      if (!busy && !canStartNew && !form.hidden) status.textContent = msg('inventoryRefreshError');
    } finally { inventoryRefreshing = false; }
  }
  function refreshInventoryIfDue() {
    if (!document.hidden && Date.now() - lastInventoryRefreshAt >= inventoryRefreshInterval) refreshInventory();
  }
  function setBusy(value) { busy = value; updatePaymentState(); check.disabled = value; if (locationButton) locationButton.disabled = value || locating; form.setAttribute('aria-busy', String(value)); }
  function display(data, silent = false) {
    if (data.state === 'cancelled' && data.order?.reference) {
      status.textContent = msg('orderCancelled', { reference: data.order.reference });
      form.hidden = true; result.hidden = true; canStartNew = true; startNew.hidden = false; return;
    }
    if (data.state === 'awaiting_admin_confirmation' && data.recorded === true && data.order?.reference) {
      check.hidden = false;
      status.textContent = paymentMessages.awaiting;
      result.replaceChildren(); const reference = document.createElement('p'); reference.textContent = `${msg('referenceLabel')}: ${data.order.reference}`; result.append(reference);
      form.hidden = true; result.hidden = false; canStartNew = true; startNew.hidden = false;
      document.dispatchEvent(new CustomEvent('cart:refresh')); return;
    }
    if (data.state !== 'confirmed' || data.confirmed !== true || !data.order?.reference) {
      if (!silent) { status.textContent = msg('orderPendingVerification'); check.hidden = false; }
      return;
    }
    const order = data.order;
    status.textContent = order.paymentMethod === 'ONLINE' && order.paymentStatus !== 'PAID' ? msg('orderPendingPayment') : msg('orderConfirmed');
    result.replaceChildren();
    document.querySelector('.checkout-page').classList.add('checkout-complete');
    const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const details = element('dl', 'order-receipt-details');
    for (const [label, value, className] of [[msg('referenceLabel'), order.reference, 'order-receipt-reference'], [msg('paymentLabel'), order.paymentMethod === 'CASH_ON_DELIVERY' && order.paymentStatus !== 'PAID' ? msg('cashLabel') : paymentName(order.paymentStatus), 'order-receipt-payment']]) {
      const row = element('div', className); row.append(element('dt', '', label), element('dd', '', value)); details.append(row);
    }
    result.append(details, element('h2', 'order-receipt-title', msg('itemsLabel')));
    const list = element('ul', 'order-receipt-items');
    for (const item of order.items) {
      const row = element('li', 'order-receipt-item');
      const description = element('div', 'order-receipt-description');
      description.append(element('span', 'order-receipt-name', locale === 'ar' ? item.product_name_ar || item.product_name : item.product_name), element('small', '', `${new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-EG').format(item.quantity)} × ${money(item.unit_price_egp)}`));
      row.append(description, element('strong', 'order-receipt-price', money(item.quantity * item.unit_price_egp))); list.append(row);
    }
    result.append(list);
    const totals = element('dl', 'order-receipt-totals');
    for (const [label, amount, className] of [[msg('subtotalLabel'), order.subtotalEgp, ''], [msg('shippingLabel'), order.shippingEgp, ''], [msg('totalLabel'), order.totalEgp, 'order-receipt-total']]) {
      if (!Number.isFinite(Number(amount))) continue;
      const row = element('div', className); row.append(element('dt', '', label), element('dd', '', money(amount))); totals.append(row);
    }
    result.append(totals);
    form.hidden = true; result.hidden = false; canStartNew = true; startNew.hidden = false;
    check.hidden = true;
    document.dispatchEvent(new CustomEvent('cart:refresh'));
  }
  async function recover(silent = false) {
    if (busy) return;
    setBusy(true);
    try { const response = await fetch(`/api/orders/requests/${encodeURIComponent(key)}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(); display(await response.json(), silent);
    } catch { if (!silent) { status.textContent = msg('statusUnknown'); check.hidden = false; } }
    finally { setBusy(false); }
  }
  const nameField = form.elements.name;
  const phoneField = form.elements.phone;
  function normalizePhone(value) {
    const digits = value.trim().replace(/[\s().-]/g, '')
      .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
      .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
    const local = digits.replace(/^\+?20/, '');
    const national = local.startsWith('0') ? local : `0${local}`;
    return /^01[0125]\d{8}$/.test(national) ? `+20${national.slice(1)}` : '';
  }
  function validateContact() {
    const name = nameField.value.trim();
    nameField.setCustomValidity(name.length >= 2 && name.length <= 160 ? '' : form.dataset.invalidName);
    phoneField.setCustomValidity(normalizePhone(phoneField.value) ? '' : form.dataset.invalidPhone);
  }
  nameField.addEventListener('input', validateContact);
  phoneField.addEventListener('input', validateContact);
  validateContact();
  form.addEventListener('input', event => {
    refreshTotal();
    if (event.target.matches('[data-product-id]')) showStockWarning(event.target);
  });
  form.addEventListener('change', refreshTotal);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || locating || paymentMethod() === 'INSTAPAY' && (!paymentProofId || uploadingProof) || !form.reportValidity()) return;
    const fields = form.elements;
    const items = [...form.querySelectorAll('[data-product-id]')].filter(input => Number(input.value) > 0).map(input => ({ productId: input.dataset.productId, ...(input.dataset.variantId ? { variantId: input.dataset.variantId } : {}), quantity: Number(input.value), unitPriceEgp: Number(input.dataset.price) }));
    if (!items.length) { status.textContent = msg('chooseItem'); return; }
    const shipping = { country: 'EG', city: fields.city.value, address: fields.address.value };
    if (fields.postalCode.value) shipping.postalCode = fields.postalCode.value;
    if (deliveryLocation) shipping.location = deliveryLocation;
    const payload = { customer: { name: fields.name.value.trim(), email: fields.email.value, phone: normalizePhone(fields.phone.value) }, shipping,
      items, expectedTotalEgp: total(), paymentMethod: fields.paymentMethod.value, ...(paymentMethod() === 'INSTAPAY' ? { paymentProofId } : {}), notes: fields.notes.value };
    setBusy(true); status.textContent = '';
    try {
      const response = await fetch('/api/orders', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) {
        const messages = {
          INVALID_ORDER: 'invalidOrderDetails',
          UNSUPPORTED_SHIPPING: 'unsupportedShippingCity',
          PRICE_CHANGED: 'orderPriceChanged',
          PRODUCT_UNAVAILABLE: 'orderProductUnavailable',
          INSUFFICIENT_INVENTORY: 'orderInsufficientStock',
          PRODUCT_OPTIONS_REQUIRED: 'orderOptionsRequired',
          ORDER_SELECTION_UNAVAILABLE: 'orderSelectionUnavailable',
          REQUEST_ORIGIN_REJECTED: 'orderOriginRejected',
          PAYMENT_METHOD_UNAVAILABLE: 'orderPaymentUnavailable',
        };
        const retryable = Object.hasOwn(messages, data.code);
        status.textContent = data.code === 'IDEMPOTENCY_CONFLICT' ? msg('statusConflict')
          : messages[data.code] ? msg(messages[data.code]) : msg('orderNotConfirmed');
        if (retryable) rotateRequestKey();
        check.hidden = retryable;
        return;
      }
      display(data);
    } catch { status.textContent = msg('responseInterrupted'); check.hidden = false; }
    finally { setBusy(false); }
  });
  check.addEventListener('click', () => recover());
  startNew.addEventListener('click', () => {
    if (!canStartNew) return;
    try { sessionStorage.removeItem(storageKey); } catch { /* URL fragment retains the explicit retry key. */ }
    history.replaceState(null, '', `${location.pathname}${location.search}#request=${crypto.randomUUID()}`);
    location.reload();
  });
  refreshTotal();
  window.setInterval(refreshInventoryIfDue, inventoryRefreshInterval);
  document.addEventListener('visibilitychange', refreshInventoryIfDue);
  window.addEventListener('focus', refreshInventoryIfDue);
  window.addEventListener('pageshow', event => { if (event.persisted) refreshInventoryIfDue(); });
  if (previousRequest) recover(true); else setBusy(false);
})();
