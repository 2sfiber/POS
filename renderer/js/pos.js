'use strict';
/* ============================================================
   شاشة الكاشير: الأصناف المفضلة، الشبكة، السلة، الخصم، الدفع، المعلقة
   ============================================================ */

function applyProductSizes() {
  const s = state.settings;
  const root = document.documentElement;
  root.style.setProperty('--product-card-width', `${Number(s.productCardWidth) || 110}px`);
  root.style.setProperty('--product-name-font-size', `${Number(s.productNameFontSize) || 12}px`);
  root.style.setProperty('--product-price-font-size', `${Number(s.productPriceFontSize) || 12}px`);
  root.style.setProperty('--product-image-height', `${Number(s.productImageHeight) || 60}px`);
}

function renderCategories() {
  const bar = $('categoriesBar');
  if (!bar) return;
  const cats = ['الكل', ...state.categories];
  bar.innerHTML = cats.map((c) => `
    <button data-cat="${esc(c)}" class="px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap transition border
      ${c === state.selectedCategory
        ? 'bg-slate-900 text-white border-slate-900 shadow'
        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'}">
      ${esc(c)}
    </button>`).join('');
}

function filteredProducts() {
  const search = ($('productSearch').value || '').trim().toLowerCase();
  return state.products.filter((p) => {
    if (p.active === false) return false;
    const catOk = state.selectedCategory === 'الكل' || (p.category || 'عام') === state.selectedCategory;
    const searchOk = !search || p.name.toLowerCase().includes(search) ||
      (p.barcode || '').toLowerCase().includes(search);
    return catOk && searchOk;
  });
}

/**
 * حالة المخزون المعروضة على بطاقة الصنف:
 *   out         → لا مخزون
 *   low         → المخزون عند أو تحت الحد الأدنى
 *   materialOut → إحدى خامات الوصفة نفدت تمامًا
 *   material    → إحدى خامات الوصفة اقتربت من النفاد
 *   ok          → طبيعي
 */
function productStockState(p) {
  const minStock = Number(p.minStock) || 5;
  const stock = Number(p.stock) || 0;
  if (p.hasVariants) {
    const total = (p.variants || []).reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
    if (total <= 0) return 'out';
    if (total <= minStock) return 'low';
  } else if (stock <= 0) return 'out';
  else if (stock <= minStock) return 'low';
  // الخامات: تُفحص فقط عند تفعيل تنبيه المخزون وللأصناف التي لها وصفة
  if (state.settings.lowStockAlerts !== false && Array.isArray(p.recipe) && p.recipe.length) {
    for (const r of p.recipe) {
      const mStock = Number(r.stock) || 0;
      const mMin = Number(r.minStock) || 0;
      if (mStock <= 0) return 'materialOut';
      if (mMin > 0 && mStock <= mMin) return 'material';
    }
  }
  return 'ok';
}

/* تلوين خفيف لبطاقة الصنف حسب حالة المخزون — يفصلها بصريًّا عن البطاقات السليمة */
const STOCK_CARD_SKIN = {
  ok: 'bg-white border-slate-100',
  low: 'bg-amber-50 border-amber-300',
  material: 'bg-orange-50 border-orange-300',
  materialOut: 'bg-orange-100 border-orange-400',
  out: 'bg-red-50 border-red-200'
};

function renderProductGrid() {
  const grid = $('productGrid');
  if (!grid) return;
  const list = filteredProducts();
  if (list.length === 0) {
    grid.innerHTML = `<div class="col-span-full text-center text-slate-400 py-10 text-sm">
      <div class="text-4xl mb-2">📭</div>لا توجد أصناف مطابقة</div>`;
    return;
  }
  grid.innerHTML = list.map((p) => {
    const st = productStockState(p);
    const out = st === 'out';
    const low = st === 'low';
    const matWarn = st === 'material' || st === 'materialOut';
    const image = p.image
      ? `<img src="${esc(p.image)}" alt="" loading="lazy">`
      : '<span class="text-3xl opacity-50">🍔</span>';
    return `
      <button data-pid="${esc(p.id)}" ${out ? 'disabled' : ''}
        class="product-card rounded-xl p-2 shadow-sm border-2 text-right transition
          ${STOCK_CARD_SKIN[st] || STOCK_CARD_SKIN.ok}
          ${out ? 'opacity-60 cursor-not-allowed' : 'hover:shadow-md hover:border-emerald-400 active:scale-95'}">
        <div class="product-image bg-white/70 rounded-lg mb-1 overflow-hidden flex items-center justify-center relative">
          ${image}
          ${low ? '<span class="absolute top-1 right-1 bg-amber-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded shadow">منخفض</span>' : ''}
          ${matWarn ? '<span class="absolute top-1 left-1 bg-orange-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded shadow" title="إحدى خامات هذا الصنف على وشك النفاد">🧪 خامة</span>' : ''}
          ${!matWarn && p.hasVariants ? '<span class="absolute top-1 left-1 bg-emerald-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded shadow">أحجام</span>' : ''}
          ${p.hasOptions ? '<span class="absolute bottom-1 left-1 bg-amber-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded shadow">نكهات</span>' : ''}
        </div>
        <div class="product-name font-bold text-slate-800 w-full truncate">${esc(p.name)}</div>
        <div class="flex justify-between items-center mt-1 w-full gap-1">
          <span class="product-price text-emerald-700 font-extrabold truncate">${p.hasVariants ? '<span class="text-[9px] text-slate-400 font-normal">من </span>' : ''}${money(p.sellingPrice)} <span class="text-[9px]">${esc(currency())}</span></span>
          <span class="text-[9px] px-1.5 py-0.5 rounded-md font-bold whitespace-nowrap
            ${out ? 'bg-red-100 text-red-600' : low ? 'bg-amber-100 text-amber-700' : matWarn ? 'bg-orange-100 text-orange-700' : 'bg-slate-100 text-slate-500'}">
            ${out ? 'نفذ' : esc(p.stock)}
          </span>
        </div>
      </button>`;
  }).join('');
}

/* ---------------- الأصناف المفضلة السريعة (الأكثر طلبًا فعليًا) ---------------- */
let favoritesList = [];

/** تُحدَّث بعد كل عملية بيع لأن الترتيب يعتمد على المبيعات الفعلية. */
async function loadFavorites() {
  try {
    const rows = await api('products:favorites', { limit: 10 });
    favoritesList = Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error('favorites load', err);
    favoritesList = [];
  }
  renderFavorites();
}

function renderFavorites() {
  const bar = $('favoritesBar');
  const grid = $('favoritesGrid');
  if (!bar || !grid) return;
  const list = favoritesList
    .map((f) => state.products.find((p) => p.id === Number(f.id)))
    .filter((p) => p && p.active !== false);
  if (!list.length) {
    bar.classList.add('hidden');
    grid.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  grid.innerHTML = list.map((p) => {
    const out = Number(p.stock) <= 0;
    return `<button data-fav="${esc(p.id)}" ${out ? 'disabled' : ''}
      title="${esc(p.name)} — مبيعات سابقة"
      class="shrink-0 min-w-[84px] max-w-[116px] rounded-lg border-2 border-fuchsia-300 bg-white px-2 py-1.5 text-center transition
        ${out ? 'opacity-40 cursor-not-allowed' : 'hover:border-fuchsia-500 hover:shadow-md active:scale-95'}">
      <div class="text-[11px] font-extrabold text-slate-800 truncate leading-tight">${esc(p.name)}</div>
      <div class="text-[11px] font-mono font-extrabold text-fuchsia-700 mt-0.5">${moneyShort(p.sellingPrice)}</div>
    </button>`;
  }).join('');
}

/* ------------------------------ السلة ------------------------------ */
function cartSubtotal() {
  return round2(state.cart.reduce((sum, item) => sum + item.sellingPrice * item.qty, 0));
}

function totals() {
  const subtotal = cartSubtotal();
  const rawDiscount = Number(state.discountValue) || 0;
  const discount = state.discountType === 'percent'
    ? round2(subtotal * Math.min(Math.max(rawDiscount, 0), 100) / 100)
    : round2(Math.min(Math.max(rawDiscount, 0), subtotal));
  const taxable = round2(Math.max(0, subtotal - discount));
  const taxRate = state.settings.taxEnabled ? Number(state.settings.taxRate) || 0 : 0;
  const tax = round2(taxable * taxRate / 100);
  const total = round2(taxable + tax);
  return { subtotal, discount, pointsDiscount: 0, taxable, tax, total, taxRate };
}

function updateTotals() {
  const t = totals();
  $('cartSubtotal').textContent = money(t.subtotal);
  $('cartTax').textContent = money(t.tax);
  $('cartTaxLabel').textContent = `${state.settings.taxName || 'الضريبة'} (${t.taxRate}%)`;
  $('cartTaxRow').classList.toggle('hidden', !state.settings.taxEnabled);
  $('cartTotal').textContent = `${money(t.total)} ${currency()}`;
}

function renderCart() {
  const el = $('cartItems');
  if (!el) return;
  if (state.cart.length === 0) {
    el.innerHTML = `<div class="text-center text-slate-400 py-10 text-sm"><div class="text-4xl mb-2">🛒</div>السلة فارغة</div>`;
  } else {
    el.innerHTML = state.cart.map((item, index) => {
      const flavors = cartFlavorsText(item);
      return `
      <div class="border-b border-slate-100 py-1.5 px-1 cursor-pointer hover:bg-slate-50" data-row-idx="${index}"
        title="نقرتان لتعديل الحجم أو النكهات">
        <div class="flex justify-between items-start gap-1">
          <div class="font-bold text-xs leading-tight flex-1 text-slate-800">
            ${esc(item.name)}
            ${item.variantName ? `<span class="inline-block text-[10px] font-extrabold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1 mx-0.5 align-middle">${esc(item.variantName)}</span>` : ''}
          </div>
          <button data-action="remove" data-idx="${index}" class="text-red-400 hover:text-red-600 text-base leading-none px-1" title="حذف الصنف من السلة">🗑️</button>
        </div>
        ${flavors ? `<div class="text-[10px] text-amber-700 leading-tight mt-0.5">🍫 ${esc(flavors)}</div>` : ''}
        <div class="flex items-center gap-1 mt-1">
          <button data-action="minus" data-idx="${index}" class="w-6 h-6 bg-slate-200 hover:bg-slate-300 rounded font-bold text-slate-700 text-sm">−</button>
          <span class="w-7 text-center font-extrabold text-xs font-mono">${esc(item.qty)}</span>
          <button data-action="plus" data-idx="${index}" class="w-6 h-6 bg-slate-200 hover:bg-slate-300 rounded font-bold text-slate-700 text-sm">+</button>
          <span class="text-[10px] text-slate-400 font-mono ms-1">× ${moneyShort(item.sellingPrice)}</span>
          <span class="ms-auto font-extrabold text-emerald-600 text-xs font-mono">${moneyShort(item.sellingPrice * item.qty)}</span>
        </div>
        <input data-action="note" data-idx="${index}" value="${esc(item.note || '')}"
          placeholder="ملاحظة إضافية على الصنف..." maxlength="120"
          class="w-full mt-1 text-[10px] border border-slate-200 rounded px-1 py-0.5 bg-slate-50">
      </div>`;
    }).join('');
  }
  $('cartCount').textContent = state.cart.reduce((sum, item) => sum + item.qty, 0);
  updateTotals();
  scheduleCartSave();
}

/* ---------------- حفظ السلة واستعادتها (إغلاق مفاجئ / إعادة تشغيل) ---------------- */
let cartDraftTimer = null;

function cartDraftPayload() {
  return {
    items: state.cart.map((i) => ({
      productId: i.productId,
      variantId: i.variantId || null,
      optionIds: (i.options || []).map((o) => o.id),
      qty: i.qty,
      note: i.note || ''
    })),
    discountType: state.discountType,
    discountValue: state.discountValue,
    paymentMethod: state.paymentMethod,
    customer: {
      name: $('custName') ? $('custName').value.trim() : '',
      phone: $('custPhone') ? $('custPhone').value.trim() : '',
      deliveryId: $('deliveryCompany') ? $('deliveryCompany').value : ''
    }
  };
}

/* حفظ مؤجل: يجمع التعديلات السريعة في طلب واحد */
function scheduleCartSave() {
  if (!state.user) return;
  clearTimeout(cartDraftTimer);
  cartDraftTimer = setTimeout(() => { saveCartDraft(); }, 400);
}

async function saveCartDraft() {
  if (!state.user) return { ok: false };
  clearTimeout(cartDraftTimer);
  try {
    return await api('cart:save', cartDraftPayload());
  } catch (err) {
    console.error('cart draft save', err);
    return { ok: false };
  }
}
// تُستدعى من العملية الرئيسية قبل الإغلاق للتأكد من حفظ أحدث حالة
window.flushCartDraft = saveCartDraft;
// عدد الأصناف الحقيقي في السلة (يقرأه تأكيد الإغلاق بدل الاعتماد على آخر حفظ)
window.getCartCount = () => state.cart.reduce((sum, i) => sum + (Number(i.qty) || 0), 0);

async function clearCartDraft() {
  if (!state.user) return;
  clearTimeout(cartDraftTimer);
  try { await api('cart:clear'); } catch (err) { console.error('cart draft clear', err); }
}

/* استعادة السلة بعد الدخول:
 *  - إغلاق نظيف  → استعادة صامتة (السلوك المعتاد: السلة تبقى كما كانت).
 *  - إغلاق قسري → نافذة تأكيد: «تم العثور على طلب غير مكتمل في السلة، هل تريد استعادته؟».
 * الأسعار تُحدَّث من قاعدة البيانات وتُضبط الكميات على المخزون.
 */
let pendingRecovery = null;

async function restoreCartDraft(opts = {}) {
  if (!state.user) return;
  let draft = null;
  try {
    draft = await api('cart:get');
  } catch (err) {
    return;
  }
  if (!draft || !Array.isArray(draft.items) || draft.items.length === 0) return;
  if (!opts.unclean) return applyCartDraft(draft);
  pendingRecovery = draft;
  // نؤجل النافذة إذا كانت نافذة فتح الوردية مفتوحة حتى لا تتراكب
  if (!$('shiftModal') || $('shiftModal').classList.contains('hidden')) maybePromptRecovery();
}

/** نافذة استعادة الجلسة — تظهر مرة واحدة فقط، وبعد إغلاق أي نافذة إجبارية. */
function maybePromptRecovery() {
  if (!pendingRecovery) return;
  if (!$('customConfirmModal') || !$('customConfirmModal').classList.contains('hidden')) return;
  const draft = pendingRecovery;
  pendingRecovery = null;
  const qty = draft.items.reduce((sum, i) => sum + (Number(i.qty) || 0), 0);
  askConfirm('استعادة الجلسة', [
    `تم العثور على طلب غير مكتمل في السلة (${qty} صنف).`,
    'هل تريد استعادته؟'
  ].join('\n'), 'warn', { ok: 'استعادة', cancel: 'تجاهل' })
    .then((ok) => {
      if (ok) applyCartDraft(draft);
      else clearCartDraft();
    });
}

function applyCartDraft(draft) {
  const skipped = [];
  const items = [];
  draft.items.forEach((it) => {
    const product = state.products.find((p) => p.id === Number(it.productId));
    if (!product) { skipped.push('صنف محذوف'); return; }
    const variant = product.hasVariants
      ? (product.variants || []).find((v) => v.id === Number(it.variantId)) : null;
    if (product.hasVariants && !variant) { skipped.push(`${product.name} (حجم محذوف)`); return; }
    const options = (Array.isArray(it.optionIds) ? it.optionIds : [])
      .map((id) => (product.options || []).find((o) => o.id === Number(id)))
      .filter(Boolean)
      .map((o) => ({ id: o.id, name: o.name, price: Number(o.price) }));
    const available = variant ? Number(variant.stock) : Number(product.stock);
    const used = items
      .filter((x) => x.productId === product.id && Number(x.variantId || 0) === Number(variant ? variant.id : 0))
      .reduce((sum, x) => sum + x.qty, 0);
    const qty = Math.min(Math.max(0, Number(it.qty) || 0), Math.max(0, available - used));
    if (qty <= 0) { skipped.push(product.name + (variant ? ` (${variant.name})` : '')); return; }
    items.push({
      productId: product.id,
      name: product.name,
      sellingPrice: round2((variant ? Number(variant.sellingPrice) : Number(product.sellingPrice))
        + options.reduce((sum, o) => sum + o.price, 0)),
      costPrice: variant ? Number(variant.costPrice) : Number(product.costPrice),
      qty,
      note: String(it.note || ''),
      variantId: variant ? variant.id : null,
      variantName: variant ? variant.name : '',
      options
    });
  });
  if (!items.length) {
    clearCartDraft();
    if (skipped.length) toast('تعذّر استعادة السلة السابقة: تغيّرت الأصناف أو نفد المخزون', 'warn');
    return;
  }
  state.cart = items;
  state.discountType = draft.discountType === 'percent' ? 'percent' : 'fixed';
  state.discountValue = Math.max(0, Number(draft.discountValue) || 0);
  state.paymentMethod = ['cash', 'bank', 'credit'].includes(draft.paymentMethod) ? draft.paymentMethod : 'cash';
  if (draft.customer) {
    if ($('custName')) $('custName').value = draft.customer.name || '';
    if ($('custPhone')) $('custPhone').value = draft.customer.phone || '';
    if ($('deliveryCompany')) $('deliveryCompany').value = draft.customer.deliveryId || '';
  }
  if ($('cartDiscountType')) $('cartDiscountType').value = state.discountType;
  if ($('cartDiscount')) $('cartDiscount').value = state.discountValue;
  renderCart();
  setPaymentMethod(state.paymentMethod);
  const qty = items.reduce((sum, i) => sum + i.qty, 0);
  toast(`تم استعادة ${qty} صنف من السلة السابقة` + (skipped.length ? ` (تعذّر ${skipped.length} صنف)` : ''), 'warn');
}

/* ------------------- اختيار الحجم ثم النكهات ------------------- */
const SIZE_SHORT = {
  'كبير': 'ك', 'كبيرة': 'ك', 'وسط': 'و', 'وسطى': 'و', 'متوسط': 'و', 'متوسطة': 'و',
  'صغير': 'ص', 'صغيرة': 'ص'
};
/** اختصار حجم للطباعة: «كبير» → «ك»، وإلا أول حرف من الاسم. */
function sizeShort(name) {
  const text = String(name || '').trim();
  if (!text) return '';
  if (SIZE_SHORT[text]) return SIZE_SHORT[text];
  for (const key of Object.keys(SIZE_SHORT)) {
    if (text.startsWith(key)) return SIZE_SHORT[key];
  }
  return text.length <= 2 ? text : text[0];
}

function cartFlavorsText(item) {
  return (item.options || []).map((o) => o.name).join(' + ');
}

/** مفتاح التطابق التام: الصنف + الحجم + النكهات + الملاحظة. */
function cartLineKey(item) {
  const ids = (item.options || []).map((o) => Number(o.id)).sort((a, b) => a - b).join(',');
  return `${item.productId}|${item.variantId || 0}|${ids}|${String(item.note || '')}`;
}

/** الكمية المحجوزة في السلة لنفس الصنف/الحجم (مع استثناء سطر عند التعديل). */
function cartQtyFor(productId, variantId, exceptIndex = null) {
  return state.cart.reduce((sum, item, index) => {
    if (exceptIndex != null && index === exceptIndex) return sum;
    if (Number(item.productId) !== Number(productId)) return sum;
    if (Number(item.variantId || 0) !== Number(variantId || 0)) return sum;
    return sum + (Number(item.qty) || 0);
  }, 0);
}

let productFlow = null;

function openProductFlow(productId, opts = {}) {
  const product = state.products.find((p) => p.id === Number(productId));
  if (!product) return;
  if (Number(product.stock) <= 0 && opts.editIndex == null) return toast('هذا الصنف غير متوفر', 'warn');
  productFlow = {
    productId: product.id,
    variantId: opts.variantId != null ? Number(opts.variantId) : null,
    optionIds: Array.isArray(opts.optionIds) ? opts.optionIds.map(Number) : [],
    editIndex: Number.isInteger(opts.editIndex) ? opts.editIndex : null,
    note: String(opts.note || '')
  };
  if (product.hasVariants) return openVariantPick();
  if (product.hasOptions) return openOptionPick();
  commitProductFlow();
}

function openVariantPick() {
  if (!productFlow) return;
  const product = state.products.find((p) => p.id === productFlow.productId);
  if (!product) return cancelProductFlow();
  $('variantPickProduct').textContent = product.name;
  const grid = $('variantPickGrid');
  if (!product.variants || product.variants.length === 0) {
    toast('لا توجد أحجام لهذا الصنف', 'error');
    return cancelProductFlow();
  }
  grid.innerHTML = product.variants.map((v) => {
    const free = Number(v.stock) - cartQtyFor(product.id, v.id, productFlow.editIndex);
    const out = free <= 0;
    return `<button data-variant-id="${v.id}" ${out ? 'disabled' : ''}
      class="rounded-xl border-2 p-3 text-center shadow-sm transition
        ${out ? 'border-slate-200 bg-slate-50 opacity-50 cursor-not-allowed'
          : 'border-slate-200 bg-white hover:border-emerald-400 hover:shadow-md active:scale-95'}">
      <div class="font-extrabold text-sm text-slate-800 leading-tight">${esc(v.name)}</div>
      <div class="text-emerald-700 font-extrabold font-mono text-base mt-1">${moneyShort(v.sellingPrice)}</div>
      <div class="text-[10px] mt-1 font-bold ${out ? 'text-red-500' : 'text-slate-500'}">
        ${out ? 'نفد المخزون' : `متوفر ${esc(free)}`}
      </div>
    </button>`;
  }).join('');
  openModal('variantPickModal');
}

function pickVariant(id) {
  if (!productFlow) return;
  const product = state.products.find((p) => p.id === productFlow.productId);
  if (!product) return cancelProductFlow();
  const variant = (product.variants || []).find((v) => v.id === Number(id));
  if (!variant) return;
  productFlow.variantId = variant.id;
  closeModal('variantPickModal');
  if (product.hasOptions) return openOptionPick();
  commitProductFlow();
}

function openOptionPick() {
  if (!productFlow) return;
  const product = state.products.find((p) => p.id === productFlow.productId);
  if (!product) return cancelProductFlow();
  const variant = (product.variants || []).find((v) => v.id === productFlow.variantId);
  $('optionPickProduct').textContent = product.name + (variant ? ` — ${variant.name}` : '');
  closeModal('variantPickModal');
  renderOptionPick();
  openModal('optionPickModal');
}

function renderOptionPick() {
  const product = state.products.find((p) => p.id === productFlow.productId);
  if (!product) return cancelProductFlow();
  const grid = $('optionPickGrid');
  if (!product.options || product.options.length === 0) {
    grid.innerHTML = '<div class="col-span-full text-center text-slate-400 py-6 text-sm">لا توجد نكهات لهذا الصنف</div>';
  } else {
    grid.innerHTML = product.options.map((o) => {
      const selected = productFlow.optionIds.includes(o.id);
      return `<button data-option-id="${o.id}"
        class="rounded-xl border-2 px-2 py-3 text-center text-sm font-bold transition active:scale-95
          ${selected ? 'border-emerald-500 bg-emerald-50 text-emerald-800 ring-2 ring-emerald-200' : 'border-slate-200 bg-white text-slate-700 hover:border-amber-300'} ">
        <span class="block leading-tight">${selected ? '✓ ' : ''}${esc(o.name)}</span>
        <span class="block text-[10px] font-mono mt-1 ${Number(o.price) > 0 ? 'text-amber-700' : 'text-slate-400'}">
          ${Number(o.price) > 0 ? `+ ${moneyShort(o.price)}` : 'بدون زيادة'}
        </span>
      </button>`;
    }).join('');
  }
  updateOptionSummary();
}

function toggleOption(id) {
  if (!productFlow) return;
  const optionId = Number(id);
  const at = productFlow.optionIds.indexOf(optionId);
  if (at >= 0) productFlow.optionIds.splice(at, 1);
  else productFlow.optionIds.push(optionId);
  renderOptionPick();
}

function updateOptionSummary() {
  if (!productFlow) return;
  const product = state.products.find((p) => p.id === productFlow.productId);
  if (!product) return;
  const variant = (product.variants || []).find((v) => v.id === productFlow.variantId);
  const chosen = productFlow.optionIds
    .map((id) => (product.options || []).find((o) => o.id === id))
    .filter(Boolean);
  const base = variant ? Number(variant.sellingPrice) : Number(product.sellingPrice);
  const total = round2(base + chosen.reduce((sum, o) => sum + Number(o.price), 0));
  $('optionPickSummary').textContent = chosen.length
    ? `${chosen.length} إضافة: ${chosen.map((o) => o.name).join(' + ')}`
    : 'بدون إضافات — يمكنك المتابعة مباشرة';
  $('optionPickPrice').textContent = money(total);
}

function cancelProductFlow() {
  productFlow = null;
  closeModal('variantPickModal');
  closeModal('optionPickModal');
}

function commitProductFlow() {
  if (!productFlow) return;
  const flow = productFlow;
  const product = state.products.find((p) => p.id === flow.productId);
  if (!product) return cancelProductFlow();
  const variant = product.hasVariants
    ? (product.variants || []).find((v) => v.id === flow.variantId) : null;
  if (product.hasVariants && !variant) {
    return toast('اختر الحجم أولاً', 'warn');
  }
  const options = flow.optionIds
    .map((id) => (product.options || []).find((o) => o.id === id))
    .filter(Boolean)
    .map((o) => ({ id: o.id, name: o.name, price: round2(o.price) }));
  const unitPrice = round2((variant ? Number(variant.sellingPrice) : Number(product.sellingPrice))
    + options.reduce((sum, o) => sum + o.price, 0));
  const unitCost = variant ? Number(variant.costPrice) : Number(product.costPrice);
  const available = variant ? Number(variant.stock) : Number(product.stock);
  const used = cartQtyFor(product.id, variant ? variant.id : null, flow.editIndex);
  const qty = flow.editIndex != null
    ? Math.max(1, Number(state.cart[flow.editIndex] && state.cart[flow.editIndex].qty) || 1)
    : 1;
  if (available - used < qty) {
    return toast(`المخزون غير كافٍ — المتاح ${Math.max(0, available - used)}`, 'error');
  }
  const item = {
    productId: product.id, name: product.name, sellingPrice: unitPrice, costPrice: unitCost,
    qty, note: String(flow.note || '').trim(),
    variantId: variant ? variant.id : null,
    variantName: variant ? variant.name : '',
    options
  };
  if (flow.editIndex != null) {
    state.cart[flow.editIndex] = item;
  } else {
    const key = cartLineKey(item);
    const existing = state.cart.find((i) => cartLineKey(i) === key);
    if (existing) {
      if (available - used < 1) return toast('المخزون غير كافٍ', 'error');
      existing.qty += 1;
    } else {
      state.cart.push(item);
    }
  }
  productFlow = null;
  closeModal('variantPickModal');
  closeModal('optionPickModal');
  renderCart();
}

function addToCart(productId) {
  const product = state.products.find((p) => p.id === Number(productId));
  if (!product) return;
  if (Number(product.stock) <= 0) return toast('هذا الصنف غير متوفر', 'warn');
  openProductFlow(product.id);
}

/** نقر مزدوج على سطر السلة: إعادة فتح نوافذ الحجم والنكهات لتعديل الخيارات. */
function editCartItem(index) {
  const item = state.cart[index];
  if (!item) return;
  const product = state.products.find((p) => p.id === item.productId);
  if (!product) return;
  if (!product.hasVariants && !product.hasOptions) {
    return toast('هذا الصنف بلا خيارات لتعديلها', 'warn');
  }
  openProductFlow(product.id, {
    variantId: item.variantId,
    optionIds: (item.options || []).map((o) => o.id),
    editIndex: index,
    note: item.note
  });
}

function cartAction(action, index) {
  const item = state.cart[index];
  if (!item) return;
  if (action === 'plus') {
    const product = state.products.find((p) => p.id === item.productId);
    if (product) {
      const variant = item.variantId
        ? (product.variants || []).find((v) => v.id === item.variantId) : null;
      if (product.hasVariants && !variant) return toast('الحجم لم يعد متوفرًا — أعد اختيار الصنف', 'error');
      const available = variant ? Number(variant.stock) : Number(product.stock);
      const used = cartQtyFor(item.productId, item.variantId, index);
      if (used + item.qty + 1 > available) return toast('المخزون غير كافٍ', 'error');
    }
    item.qty += 1;
  } else if (action === 'minus') {
    item.qty -= 1;
    if (item.qty <= 0) state.cart.splice(index, 1);
  } else if (action === 'remove') {
    state.cart.splice(index, 1);
  }
  renderCart();
}

/** مزامنة أسعار السلة مع قاعدة البيانات قبل الدفع (يمنع اختلاف الإجمالي). */
async function syncCartPrices() {
  if (state.cart.length === 0) return;
  state.products = await api('products:list');
  let changed = false;
  const next = [];
  for (const item of state.cart) {
    const product = state.products.find((p) => p.id === item.productId);
    if (!product) { changed = true; continue; }
    const variant = product.hasVariants
      ? (product.variants || []).find((v) => v.id === item.variantId) : null;
    if (product.hasVariants && !variant) { changed = true; continue; }
    const options = (item.options || [])
      .map((o) => (product.options || []).find((x) => x.id === Number(o.id)))
      .filter(Boolean)
      .map((o) => ({ id: o.id, name: o.name, price: Number(o.price) }));
    if (options.length !== (item.options || []).length) changed = true;
    const price = round2((variant ? Number(variant.sellingPrice) : Number(product.sellingPrice))
      + options.reduce((sum, o) => sum + o.price, 0));
    const available = variant ? Number(variant.stock) : Number(product.stock);
    const qty = Math.min(Number(item.qty) || 0, Math.max(0, available));
    if (qty <= 0) { changed = true; continue; }
    if (qty !== item.qty || price !== Number(item.sellingPrice)) changed = true;
    next.push({
      ...item,
      name: product.name,
      sellingPrice: price,
      costPrice: variant ? Number(variant.costPrice) : Number(product.costPrice),
      qty,
      variantId: variant ? variant.id : null,
      variantName: variant ? variant.name : '',
      options
    });
  }
  state.cart = next;
  if (changed) {
    toast('تم تحديث أسعار/خيارات بعض الأصناف من قاعدة البيانات', 'warn');
    renderCart();
  }
}

function setPaymentMethod(method) {
  state.paymentMethod = method;
  $$('[data-pay]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.pay === method);
  });
  $('cashInputSection').classList.toggle('hidden', method !== 'cash');
  $('bankTransferSection').classList.toggle('hidden', method !== 'bank');
  $('creditSection').classList.toggle('hidden', method !== 'credit');
  if (method === 'credit') {
    const name = ($('custName').value || '').trim();
    const phone = ($('custPhone').value || '').trim();
    $('creditWarning').textContent = name || phone ? '' : '⚠️ أدخل اسم العميل أو هاتفه حتى يسهل تحصيل الذمة لاحقًا.';
  }
}

/* ------------------------------ الدفع ------------------------------ */
async function openPaymentModal() {
  if (state.cart.length === 0) return toast('السلة فارغة', 'warn');
  if (!state.shift) return toast('يجب فتح وردية أولاً', 'error');
  try {
    await syncCartPrices();
  } catch (err) { return showError(err); }
  if (state.cart.length === 0) return toast('تغيّرت الأصناف ولم يبقَ شيء في السلة', 'warn');
  const t = totals();
  $('modalTotalAmount').textContent = `${money(t.total)} ${currency()}`;
  $('paymentComment').value = '';
  $('paymentError').classList.add('hidden');
  $('amountPaidInput').value = t.total.toFixed(2);
  $('bankNameInput').value = '';
  $('transferInfoInput').value = '';
  setPaymentMethod(state.paymentMethod);
  calculateChange();
  openModal('paymentModal');
  if (state.paymentMethod === 'cash') setTimeout(() => $('amountPaidInput').select(), 50);
}

function calculateChange() {
  const t = totals();
  const paid = Number($('amountPaidInput').value) || 0;
  const change = round2(paid - t.total);
  const el = $('changeAmount');
  el.textContent = money(change);
  el.className = `text-2xl font-extrabold font-mono ${change < 0 ? 'text-red-600' : 'text-emerald-700'}`;
}

async function submitPayment() {
  const btn = $('confirmPaymentBtn');
  if (btn.disabled) return;
  const t = totals();
  const method = state.paymentMethod;
  const paid = method === 'cash' ? Number($('amountPaidInput').value) || 0 : t.total;
  const errorEl = $('paymentError');
  errorEl.classList.add('hidden');

  if (method === 'cash' && paid < t.total) {
    errorEl.textContent = 'المبلغ المدفوع أقل من المطلوب';
    errorEl.classList.remove('hidden');
    return;
  }
  if (method === 'bank' && !$('bankNameInput').value.trim()) {
    errorEl.textContent = 'أدخل اسم البنك أو خدمة التحويل';
    errorEl.classList.remove('hidden');
    return;
  }
  if (method === 'credit' && !$('custName').value.trim() && !$('custPhone').value.trim()) {
    errorEl.textContent = 'البيع الآجل يحتاج اسم العميل أو رقم هاتفه';
    errorEl.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'جاري الحفظ...';
  try {
    const invoice = await api('invoices:create', {
      items: state.cart.map((i) => ({
        productId: i.productId,
        variantId: i.variantId || null,
        optionIds: (i.options || []).map((o) => o.id),
        qty: i.qty,
        note: i.note || ''
      })),
      discountType: state.discountType,
      discountValue: state.discountValue,
      paymentMethod: method,
      amountPaid: paid,
      customer: {
        name: $('custName').value.trim(),
        phone: $('custPhone').value.trim(),
        deliveryId: $('deliveryCompany').value || ''
      },
      comment: $('paymentComment').value.trim(),
      bankName: $('bankNameInput').value.trim(),
      transferInfo: $('transferInfoInput').value.trim()
    });

    state.lastInvoice = invoice;
    state.cart = [];
    state.discountValue = 0;
    state.customer = null;
    $('cartDiscount').value = 0;
    $('custName').value = '';
    $('custPhone').value = '';
    $('deliveryCompany').value = '';
    if ($('customerInfo')) $('customerInfo').textContent = '';
    closeModal('paymentModal');

    await reloadProducts();
    renderCart();
    await clearCartDraft();
    updateHoldsCount();

    if (state.settings.previewBeforePrint) {
      previewInvoice(invoice);
      toast('تم حفظ الفاتورة ' + invoice.serial);
    } else if (state.settings.autoPrint) {
      await printInvoice(invoice, { silent: true, quiet: true });
      toast(`تم الدفع ${invoice.serial} — الباقي ${money(invoice.change)} ${currency()}`);
    } else {
      toast(`تم الدفع ${invoice.serial} — الباقي ${money(invoice.change)} ${currency()}`);
    }
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'تأكيد الدفع';
  }
}

async function reloadProducts() {
  try {
    state.products = await api('products:list');
    renderProductGrid();
    await loadFavorites();
  } catch (err) { console.error(err); }
}

/* ------------------------------ المعلّقة ------------------------------ */
async function updateHoldsCount() {
  try {
    state.holds = await api('holds:list');
    $('holdsCount').textContent = state.holds.length;
    if (state.holds.length > 0) $('holdsCount').parentElement.classList.add('ring-2', 'ring-amber-300');
  } catch (err) { console.error(err); }
}

function openHoldModal() {
  if (state.cart.length === 0) return toast('السلة فارغة', 'warn');
  $('holdNoteInput').value = '';
  openModal('holdOrderModal');
  setTimeout(() => $('holdNoteInput').focus(), 50);
}

async function confirmHoldOrder() {
  try {
    await api('holds:add', {
      items: state.cart,
      discount: state.discountValue,
      discountType: state.discountType,
      paymentMethod: state.paymentMethod,
      note: $('holdNoteInput').value.trim(),
      customer: {
        name: $('custName').value.trim(),
        phone: $('custPhone').value.trim(),
        deliveryId: $('deliveryCompany').value || ''
      }
    });
    state.cart = [];
    state.discountValue = 0;
    $('cartDiscount').value = 0;
    $('custName').value = '';
    $('custPhone').value = '';
    closeModal('holdOrderModal');
    renderCart();
    await clearCartDraft();
    await updateHoldsCount();
    toast('تم تعليق الطلب');
  } catch (err) { showError(err); }
}

async function showHolds() {
  try {
    state.holds = await api('holds:list');
  } catch (err) { return showError(err); }
  const list = $('holdsList');
  if (state.holds.length === 0) {
    list.innerHTML = '<div class="text-center text-slate-400 py-10">لا توجد طلبات معلقة</div>';
  } else {
    list.innerHTML = state.holds.map((h) => {
      const total = round2(h.items.reduce((sum, i) => sum + i.sellingPrice * i.qty, 0) - (h.discount || 0));
      return `
        <div class="border rounded-lg p-2 flex justify-between items-center gap-2 bg-slate-50 hover:bg-slate-100">
          <button class="flex-1 min-w-0 text-right" data-viewhold="${h.id}">
            <div class="font-bold text-xs">${h.items.length} صنف — ${money(total)} ${currency()}</div>
            <div class="text-[10px] text-slate-500 truncate">${h.items.map((i) => `${i.qty}× ${esc(i.name)}${i.variantName ? ` (${esc(i.variantName)})` : ''}`).join(' • ')}</div>
            <div class="text-[9px] text-indigo-600 mt-1 font-bold">${esc(h.cashier)} | ${fmtTime(h.timestamp)} ${h.note ? `| ${esc(h.note)}` : ''}</div>
          </button>
          <div class="flex flex-col gap-1">
            <button data-resume="${h.id}" class="bg-emerald-600 hover:bg-emerald-700 text-white px-2 py-1 rounded text-[10px] font-bold">استرجاع</button>
            <button data-delhold="${h.id}" class="bg-red-100 text-red-700 hover:bg-red-200 px-2 py-1 rounded text-[10px] font-bold">حذف</button>
          </div>
        </div>`;
    }).join('');
  }
  openModal('holdsModal');
}

async function viewHoldDetails(id) {
  const hold = state.holds.find((h) => h.id === Number(id));
  if (!hold) return;
  state.selectedHoldId = hold.id;
  const total = round2(hold.items.reduce((sum, i) => sum + i.sellingPrice * i.qty, 0));
  $('holdDetailsContent').innerHTML = `
    <div class="bg-slate-50 p-2 rounded border text-xs mb-2 space-y-1">
      <div class="flex justify-between"><span>الكاشير:</span><b>${esc(hold.cashier)}</b></div>
      <div class="flex justify-between"><span>التاريخ:</span><b>${fmtDateTime(hold.timestamp)}</b></div>
      ${hold.customer.name ? `<div class="flex justify-between"><span>العميل:</span><b>${esc(hold.customer.name)}</b></div>` : ''}
      ${hold.note ? `<div class="text-amber-700 bg-amber-50 p-1 rounded"><b>ملاحظة:</b> ${esc(hold.note)}</div>` : ''}
    </div>
    <table class="w-full text-xs text-right">
      <thead><tr class="border-b"><th class="pb-1">الصنف</th><th class="pb-1">الكمية</th><th class="pb-1">السعر</th><th class="pb-1">الإجمالي</th></tr></thead>
      <tbody>${hold.items.map((i) => {
        const flavors = (i.options || []).map((o) => o.name).join(' + ');
        return `<tr class="border-b border-slate-100"><td class="py-1">${esc(i.name)}${i.variantName ? ` (${esc(i.variantName)})` : ''}${flavors ? `<div class="text-[10px] text-amber-700">${esc(flavors)}</div>` : ''}</td>
        <td>${esc(i.qty)}</td><td>${money(i.sellingPrice)}</td><td>${money(i.sellingPrice * i.qty)}</td></tr>`;
      }).join('')}</tbody>
    </table>
    <div class="text-left font-bold mt-2">الإجمالي: ${money(total)} ${currency()}</div>`;
  closeModal('holdsModal');
  openModal('holdDetailsModal');
}

async function resumeHold(id) {
  const hold = state.holds.find((h) => h.id === Number(id));
  if (!hold) return;
  if (state.cart.length > 0 && !(await askConfirm('استبدال السلة', 'سيتم استبدال السلة الحالية. متابعة؟', 'warn'))) return;
  state.cart = hold.items.map((i) => ({ ...i }));
  state.discountType = hold.discountType === 'percent' ? 'percent' : 'fixed';
  state.discountValue = Number(hold.discount) || 0;
  $('cartDiscountType').value = state.discountType;
  $('cartDiscount').value = state.discountValue;
  setPaymentMethod(hold.paymentMethod || 'cash');
  $('custName').value = hold.customer.name || '';
  $('custPhone').value = hold.customer.phone || '';
  $('deliveryCompany').value = hold.customer.deliveryId || '';
  try {
    await api('holds:delete', { id: hold.id });
  } catch (err) { showError(err); }
  closeModal('holdsModal');
  closeModal('holdDetailsModal');
  renderCart();
  await updateHoldsCount();
  toast('تم استرجاع الطلب');
}

async function deleteHold(id) {
  if (!(await askConfirm('حذف طلب معلق', 'هل تريد حذف هذا الطلب المعلق نهائيًا؟'))) return;
  try {
    await api('holds:delete', { id });
    closeModal('holdsModal');
    await updateHoldsCount();
    await showHolds();
    toast('تم الحذف');
  } catch (err) { showError(err); }
}

/* ------------------------------ العميل ------------------------------ */
async function lookupCustomer() {
  const phone = $('custPhone').value.trim();
  if (!phone) return toast('أدخل رقم الهاتف', 'warn');
  const info = $('customerInfo');
  try {
    const customer = await api('customers:get', { phone });
    if (customer) {
      state.customer = customer;
      $('custName').value = customer.name || $('custName').value;
      if (info) info.textContent = 'تم العثور على العميل';
      toast('تم العثور على العميل');
    } else {
      state.customer = null;
      if (info) info.textContent = 'عميل جديد — سيتم إنشاؤه عند إتمام البيع';
      toast('عميل جديد', 'warn');
    }
  } catch (err) { showError(err); }
}

/* ------------------------------ ربط الأحداث ------------------------------ */
function bindPosEvents() {
  bind('productSearch', 'input', debounce(renderProductGrid, 120));
  bind('barcodeInput', 'keydown', (e) => {
    if (e.key !== 'Enter') return;
    const code = e.target.value.trim();
    if (!code) return;
    const product = state.products.find((p) => (p.barcode || '') === code);
    if (product) { addToCart(product.id); e.target.value = ''; }
    else toast('الباركود غير موجود', 'error');
  });

  bind('categoriesBar', 'click', (e) => {
    const btn = e.target.closest('[data-cat]');
    if (!btn) return;
    state.selectedCategory = btn.dataset.cat;
    renderCategories();
    renderProductGrid();
  });
  bind('productGrid', 'click', (e) => {
    const btn = e.target.closest('[data-pid]');
    if (btn && !btn.disabled) addToCart(Number(btn.dataset.pid));
  });
  bind('favoritesGrid', 'click', (e) => {
    const btn = e.target.closest('[data-fav]');
    if (btn && !btn.disabled) addToCart(Number(btn.dataset.fav));
  });

  bind('cartItems', 'click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.dataset.action === 'note') return;
    cartAction(btn.dataset.action, Number(btn.dataset.idx));
  });
  bind('cartItems', 'input', (e) => {
    if (e.target.dataset.action !== 'note') return;
    const index = Number(e.target.dataset.idx);
    if (state.cart[index]) state.cart[index].note = e.target.value;
    scheduleCartSave();
  });
  // نقر مزدوج على السطر (خارج الأزرار والحقول) يفتح نافذتي الحجم/النكهات للتعديل
  bind('cartItems', 'dblclick', (e) => {
    if (e.target.closest('[data-action]')) return;
    const row = e.target.closest('[data-row-idx]');
    if (row) editCartItem(Number(row.dataset.rowIdx));
  });

  bind('closeVariantPick', 'click', cancelProductFlow);
  bind('variantPickGrid', 'click', (e) => {
    const btn = e.target.closest('[data-variant-id]');
    if (btn && !btn.disabled) pickVariant(btn.dataset.variantId);
  });
  bind('closeOptionPick', 'click', cancelProductFlow);
  bind('optionPickGrid', 'click', (e) => {
    const btn = e.target.closest('[data-option-id]');
    if (btn) toggleOption(btn.dataset.optionId);
  });
  bind('skipOptionsBtn', 'click', () => {
    if (!productFlow) return;
    productFlow.optionIds = [];
    commitProductFlow();
  });
  bind('confirmOptionsBtn', 'click', commitProductFlow);

  bind('cartDiscountType', 'change', (e) => {
    state.discountType = e.target.value === 'percent' ? 'percent' : 'fixed';
    updateTotals();
    scheduleCartSave();
  });
  bind('cartDiscount', 'input', (e) => {
    state.discountValue = Math.max(0, Number(e.target.value) || 0);
    updateTotals();
    scheduleCartSave();
  });

  bind('clearCartBtn', 'click', async () => {
    if (state.cart.length === 0) return;
    if (await askConfirm('إلغاء السلة', 'هل تريد إلغاء جميع الأصناف في السلة؟')) {
      state.cart = [];
      state.discountValue = 0;
      $('cartDiscount').value = 0;
      if ($('customerInfo')) $('customerInfo').textContent = '';
      renderCart();
    }
  });

  bind('zoomInBtn', 'click', () => {
    state.settings.productCardWidth = Math.min((Number(state.settings.productCardWidth) || 110) + 10, 250);
    state.settings.productNameFontSize = Math.min((Number(state.settings.productNameFontSize) || 12) + 1, 24);
    state.settings.productPriceFontSize = Math.min((Number(state.settings.productPriceFontSize) || 12) + 1, 24);
    state.settings.productImageHeight = Math.min((Number(state.settings.productImageHeight) || 60) + 10, 150);
    applyProductSizes();
  });
  bind('zoomOutBtn', 'click', () => {
    state.settings.productCardWidth = Math.max((Number(state.settings.productCardWidth) || 110) - 10, 80);
    state.settings.productNameFontSize = Math.max((Number(state.settings.productNameFontSize) || 12) - 1, 9);
    state.settings.productPriceFontSize = Math.max((Number(state.settings.productPriceFontSize) || 12) - 1, 9);
    state.settings.productImageHeight = Math.max((Number(state.settings.productImageHeight) || 60) - 10, 40);
    applyProductSizes();
  });

  $$('[data-pay]').forEach((btn) => btn.addEventListener('click', () => setPaymentMethod(btn.dataset.pay)));
  bind('payBtn', 'click', openPaymentModal);
  bind('closePaymentModal', 'click', () => closeModal('paymentModal'));
  bind('amountPaidInput', 'input', calculateChange);
  bind('confirmPaymentBtn', 'click', submitPayment);

  bind('holdOrderBtn', 'click', openHoldModal);
  bind('cancelHoldBtn', 'click', () => closeModal('holdOrderModal'));
  bind('confirmHoldBtn', 'click', confirmHoldOrder);
  bind('holdsBtn', 'click', showHolds);
  bind('closeHolds', 'click', () => closeModal('holdsModal'));
  bind('holdsList', 'click', (e) => {
    const view = e.target.closest('[data-viewhold]');
    if (view) return viewHoldDetails(Number(view.dataset.viewhold));
    const resume = e.target.closest('[data-resume]');
    if (resume) return resumeHold(Number(resume.dataset.resume));
    const del = e.target.closest('[data-delhold]');
    if (del) return deleteHold(Number(del.dataset.delhold));
  });
  bind('closeHoldDetailsBtn', 'click', () => closeModal('holdDetailsModal'));
  bind('resumeHoldBtn', 'click', () => { if (state.selectedHoldId) resumeHold(state.selectedHoldId); });

  bind('lookupCustomerBtn', 'click', lookupCustomer);

  bind('printLastBtn', 'click', async () => {
    try {
      const inv = await api('invoices:last');
      if (!inv) return toast('لا توجد فواتير في هذه الوردية', 'warn');
      if (state.settings.previewBeforePrint) previewInvoice(inv);
      else printInvoice(inv);
    } catch (err) { showError(err); }
  });

  bind('closePreviewBtn', 'click', () => closeModal('printPreviewModal'));
  bind('confirmPrintBtn', 'click', () => {
    closeModal('printPreviewModal');
    if (state.lastInvoice) printInvoice(state.lastInvoice, { silent: true });
  });
  bind('previewPdfBtn', 'click', () => {
    if (state.lastInvoice) saveInvoicePdf(state.lastInvoice);
  });
}
