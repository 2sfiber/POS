'use strict';
/* ============================================================
   إدارة المنيو: الأصناف، الفئات، الصور، التصدير
   ============================================================ */

function renderProductsTable() {
  const tbody = $('productsTbody');
  if (!tbody) return;
  // التنبيه يغطي كل حجم على حدة حين تكون الأحجام مفعّلة
  const lowList = [];
  state.products.forEach((p) => {
    const min = Number(p.minStock) || 5;
    if (p.hasVariants && p.variants.length) {
      p.variants.forEach((v) => {
        if (Number(v.stock) > 0 && Number(v.stock) <= min) lowList.push(`${p.name} — ${v.name} (${v.stock})`);
      });
    } else if (Number(p.stock) > 0 && Number(p.stock) <= min) {
      lowList.push(`${p.name} (${p.stock} / ${min})`);
    }
  });
  $('lowStockAlert').innerHTML = state.settings.lowStockAlerts !== false && lowList.length
    ? `<div class="bg-amber-50 border-2 border-amber-300 text-amber-800 rounded-lg p-3 mb-3 font-bold text-sm">
         ⚠️ مخزون منخفض: ${lowList.map((line) => esc(line)).join(' — ')}
       </div>` : '';

  if (state.products.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="p-6 text-slate-400">لا توجد أصناف. أضف صنفًا جديدًا.</td></tr>';
    return;
  }

  tbody.innerHTML = state.products.map((p) => {
    const minStock = Number(p.minStock) || 5;
    const low = Number(p.stock) <= minStock;
    return `
      <tr class="border-b hover:bg-slate-50 ${low ? 'bg-amber-50' : ''}">
        <td class="p-2 font-bold">
          <div class="flex items-center gap-2 justify-center flex-wrap">
            ${p.image ? `<img src="${esc(p.image)}" class="w-8 h-8 rounded object-cover border" alt="">` : '<span class="text-lg">🍔</span>'}
            <span>${esc(p.name)}</span>
            ${p.hasVariants ? `<span class="text-[9px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-bold">${esc((p.variants || []).length)} أحجام</span>` : ''}
            ${p.hasOptions ? `<span class="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-bold">${esc((p.options || []).length)} نكهات</span>` : ''}
            ${p.hasRecipe ? `<span class="text-[9px] bg-teal-100 text-teal-700 px-1.5 py-0.5 rounded font-bold">${esc((p.recipe || []).length)} خامات</span>` : ''}
          </div>
        </td>
        <td class="p-2 text-slate-500">${esc(p.category || 'عام')}</td>
        <td class="p-2 text-xs text-slate-500 font-mono">${esc(p.barcode || '-')}</td>
        <td class="p-2 font-mono">${money(p.costPrice)}</td>
        <td class="p-2 font-bold text-emerald-700 font-mono">
          ${p.hasVariants ? `<span class="text-[10px] text-slate-400 font-normal">من</span> ` : ''}${money(p.sellingPrice)}</td>
        <td class="p-2 font-mono ${low ? 'text-amber-700 font-extrabold' : ''}">${esc(p.stock)}
          <span class="text-[10px] text-slate-400">(${esc(minStock)})</span>
          ${p.hasVariants && (p.variants || []).length
            ? `<div class="text-[9px] text-slate-400 leading-tight whitespace-normal">${(p.variants || []).map((v) => `${esc(v.name)}: ${esc(v.stock)}`).join(' • ')}</div>` : ''}
        </td>
        <td class="p-2 whitespace-nowrap">
          <button data-edit="${p.id}" class="text-blue-600 hover:text-blue-800 font-bold ml-2">تعديل</button>
          <button data-del="${p.id}" class="text-red-600 hover:text-red-800 font-bold">حذف</button>
        </td>
      </tr>`;
  }).join('');
}

/* ------------------- الأحجام والنكهات (محرر الصنف) ------------------- */
let variantDraft = [];
let optionDraft = [];
let recipeDraft = [];
let editingMaterialId = null;
const blankVariant = () => ({ id: 0, name: '', costPrice: '', sellingPrice: '', stock: '' });
const blankOption = () => ({ id: 0, name: '', price: '' });
const blankRecipe = () => ({ materialId: '', qty: '', unit: 'قطعة' });
const MATERIAL_UNIT_LIST = ['لتر', 'مل', 'كجم', 'جم', 'قطعة'];

/* ------------------------- الخامات والوصفات ------------------------- */
function renderRecipeDraft() {
  const box = $('pRecipeList');
  if (!box) return;
  const materials = state.materials || [];
  if (!materials.length) {
    box.innerHTML = '<div class="text-[11px] text-teal-700 bg-white border border-dashed border-teal-300 rounded-lg py-2 text-center">أضف الخامات أولًا من زر «🧪 الخامات» في شاشة المنتجات</div>';
    return;
  }
  box.innerHTML = recipeDraft.map((row, i) => {
    const material = materials.find((m) => m.id === Number(row.materialId));
    const options = materials.map((m) => `<option value="${m.id}"${m.id === Number(row.materialId) ? ' selected' : ''}>${esc(m.name)} (${esc(m.stock)} ${esc(m.unit)})</option>`).join('');
    const unit = row.unit || (material ? material.unit : 'قطعة');
    return `<div class="grid grid-cols-[1fr_64px_64px_22px] gap-1 items-center bg-white border border-teal-200 rounded-lg p-1" data-rrow="${i}">
      <select data-rfield="materialId" class="w-full min-w-0 border border-slate-300 rounded px-1 py-1 text-[11px] bg-white">
        <option value="">— اختر الخامة —</option>${options}
      </select>
      <input data-rfield="qty" type="number" min="0" step="0.001" value="${esc(row.qty)}" placeholder="0"
        class="w-full border border-slate-300 rounded px-1 py-1 text-[11px] font-mono text-center">
      <select data-rfield="unit" class="w-full border border-slate-300 rounded px-1 py-1 text-[11px] bg-white">
        ${MATERIAL_UNIT_LIST.map((u) => `<option value="${u}"${u === unit ? ' selected' : ''}>${u}</option>`).join('')}
      </select>
      <button type="button" data-delrecipe="${i}" class="text-red-500 hover:text-red-700 text-xl leading-none" title="حذف الخامة">&times;</button>
    </div>`;
  }).join('') || '<div class="text-[11px] text-teal-700 bg-white border border-dashed border-teal-300 rounded-lg py-2 text-center">أضف خامة واحدة على الأقل لتفعيل الوصفة</div>';
}

function syncRecipeMode() {
  const on = $('pHasRecipe').checked;
  $('pRecipeSection').classList.toggle('hidden', !on);
}

async function loadMaterials() {
  try {
    state.materials = await api('materials:list');
  } catch (err) {
    state.materials = state.materials || [];
  }
  return state.materials;
}

async function renderMaterialsModal() {
  await loadMaterials();
  const list = state.materials || [];
  $('materialsTbody').innerHTML = list.length
    ? list.map((m) => `<tr class="border-b hover:bg-slate-50">
        <td class="p-1.5 font-bold text-right">${esc(m.name)}</td>
        <td class="p-1.5">${esc(m.unit)}</td>
        <td class="p-1.5 font-mono ${Number(m.stock) <= Number(m.minStock) ? 'text-amber-700 font-bold' : ''}">${esc(m.stock)}</td>
        <td class="p-1.5 font-mono">${money(m.costPrice)}</td>
        <td class="p-1.5 font-mono text-slate-500">${esc(m.minStock)}</td>
        <td class="p-1.5 whitespace-nowrap">
          <button data-editmat="${m.id}" class="text-blue-600 hover:text-blue-800 font-bold ml-2">تعديل</button>
          <button data-delmat="${m.id}" class="text-red-600 hover:text-red-800 font-bold">حذف</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="text-center text-slate-400 py-5">لا توجد خامات — أضف أول خامة من الأعلى</td></tr>';
  if ($('productModal') && !$('productModal').classList.contains('hidden')) renderRecipeDraft();
}

function resetMaterialForm() {
  editingMaterialId = null;
  ['mName', 'mCost', 'mStock', 'mMinStock'].forEach((id) => { if ($(id)) $(id).value = ''; });
  if ($('mUnit')) $('mUnit').value = 'قطعة';
  $('saveMaterialBtn').textContent = 'حفظ الخامة';
  $('cancelMaterialEditBtn').classList.add('hidden');
}

function editMaterial(id) {
  const material = (state.materials || []).find((m) => m.id === Number(id));
  if (!material) return;
  editingMaterialId = material.id;
  $('mName').value = material.name;
  $('mUnit').value = material.unit;
  $('mCost').value = material.costPrice;
  $('mStock').value = material.stock;
  $('mMinStock').value = material.minStock;
  $('saveMaterialBtn').textContent = 'تحديث الخامة';
  $('cancelMaterialEditBtn').classList.remove('hidden');
  $('mName').focus();
}

async function saveMaterial() {
  const name = $('mName').value.trim();
  if (!name) return toast('اسم الخامة مطلوب', 'error');
  const payload = {
    id: editingMaterialId || undefined,
    name,
    unit: $('mUnit').value,
    costPrice: Number($('mCost').value) || 0,
    stock: Number($('mStock').value) || 0,
    minStock: Number($('mMinStock').value) || 0
  };
  const wasEditing = !!editingMaterialId;
  try {
    state.materials = await api('materials:save', payload);
    resetMaterialForm();
    await renderMaterialsModal();
    toast(wasEditing ? 'تم تحديث الخامة' : 'تمت إضافة الخامة');
  } catch (err) { showError(err); }
}

async function deleteMaterial(id) {
  if (!(await askConfirm('حذف خامة', 'حذف هذه الخامة نهائيًا؟ لا يمكن حذف خامة مرتبطة بوصفة صنف.'))) return;
  try {
    state.materials = await api('materials:delete', { id: Number(id) });
    await renderMaterialsModal();
    toast('تم حذف الخامة');
  } catch (err) { showError(err); }
}

function renderVariantDraft() {
  const box = $('pVariantsList');
  if (!box) return;
  box.innerHTML = variantDraft.length ? variantDraft.map((v, i) => `
    <div class="grid grid-cols-[1fr_58px_58px_52px_22px] gap-1 items-center bg-white border border-emerald-200 rounded-lg p-1" data-vrow="${i}">
      <input data-vfield="name" value="${esc(v.name)}" placeholder="كبير / وسط / صغير" maxlength="60"
        class="w-full min-w-0 border border-slate-300 rounded px-1.5 py-1 text-xs font-bold">
      <input data-vfield="costPrice" type="number" min="0" step="0.01" value="${esc(v.costPrice)}" placeholder="0"
        class="w-full border border-slate-300 rounded px-1 py-1 text-[11px] font-mono text-center">
      <input data-vfield="sellingPrice" type="number" min="0" step="0.01" value="${esc(v.sellingPrice)}" placeholder="0"
        class="w-full border border-slate-300 rounded px-1 py-1 text-[11px] font-mono text-center">
      <input data-vfield="stock" type="number" min="0" step="0.01" value="${esc(v.stock)}" placeholder="0"
        class="w-full border border-slate-300 rounded px-1 py-1 text-[11px] font-mono text-center">
      <button type="button" data-delvariant="${i}" class="text-red-500 hover:text-red-700 text-xl leading-none" title="حذف الحجم">&times;</button>
    </div>`).join('')
    : '<div class="text-[11px] text-emerald-700 bg-white border border-dashed border-emerald-300 rounded-lg py-2 text-center">أضف حجمًا واحدًا على الأقل بزر «+ حجم»</div>';
}

function renderOptionDraft() {
  const box = $('pOptionsList');
  if (!box) return;
  box.innerHTML = optionDraft.length ? optionDraft.map((o, i) => `
    <div class="grid grid-cols-[1fr_70px_22px] gap-1 items-center bg-white border border-amber-200 rounded-lg p-1" data-orow="${i}">
      <input data-ofield="name" value="${esc(o.name)}" placeholder="شوكولاتة / جبنة إضافية" maxlength="60"
        class="w-full min-w-0 border border-slate-300 rounded px-1.5 py-1 text-xs font-bold">
      <input data-ofield="price" type="number" min="0" step="0.01" value="${esc(o.price)}" placeholder="0"
        class="w-full border border-slate-300 rounded px-1 py-1 text-[11px] font-mono text-center">
      <button type="button" data-deloption="${i}" class="text-red-500 hover:text-red-700 text-xl leading-none" title="حذف النكهة">&times;</button>
    </div>`).join('')
    : '<div class="text-[11px] text-amber-700 bg-white border border-dashed border-amber-300 rounded-lg py-2 text-center">أضف نكهة واحدة على الأقل بزر «+ نكهة»</div>';
}

function syncProductMode() {
  const hasVariants = $('pHasVariants').checked;
  const hasOptions = $('pHasOptions').checked;
  $('pGeneralPrices').classList.toggle('hidden', hasVariants);
  $('pVariantsSection').classList.toggle('hidden', !hasVariants);
  $('pOptionsSection').classList.toggle('hidden', !hasOptions);
  syncRecipeMode();
}

async function openProductModal(id) {
  state.editingProductId = id ? Number(id) : null;
  state.editingProductImage = '';
  $('pImagePreview').innerHTML = '';
  $('removeProductImageBtn').classList.add('hidden');
  $('pImageFile').value = '';
  try {
    state.categories = await api('categories:list');
  } catch (err) { /* ignore */ }
  await loadMaterials();
  $('pCategory').innerHTML = '<option value="">اختر الفئة...</option>' +
    state.categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

  if (id) {
    const product = state.products.find((p) => p.id === Number(id));
    if (!product) return toast('الصنف غير موجود', 'error');
    $('productModalTitle').textContent = 'تعديل صنف';
    $('pName').value = product.name;
    $('pCategory').value = product.category || '';
    $('pBarcode').value = product.barcode || '';
    $('pCost').value = product.costPrice;
    $('pPrice').value = product.sellingPrice;
    $('pStock').value = product.stock;
    $('pMinStock').value = product.minStock;
    $('pHasVariants').checked = !!product.hasVariants;
    $('pHasOptions').checked = !!product.hasOptions;
    $('pHasRecipe').checked = !!product.hasRecipe;
    recipeDraft = (product.recipe || []).map((r) => ({
      materialId: r.materialId, qty: r.qty, unit: r.unit
    }));
    variantDraft = (product.variants || []).map((v) => ({
      id: v.id, name: v.name, costPrice: v.costPrice, sellingPrice: v.sellingPrice, stock: v.stock
    }));
    optionDraft = (product.options || []).map((o) => ({ id: o.id, name: o.name, price: o.price }));
    state.editingProductImage = product.image || '';
    if (product.image) {
      $('pImagePreview').innerHTML = `<img src="${esc(product.image)}" class="h-16 rounded border" alt="">`;
      $('removeProductImageBtn').classList.remove('hidden');
    }
  } else {
    $('productModalTitle').textContent = 'صنف جديد';
    ['pName', 'pBarcode', 'pCost', 'pPrice'].forEach((field) => { $(field).value = ''; });
    $('pStock').value = '0';
    $('pCategory').value = '';
    $('pMinStock').value = '5';
    $('pHasVariants').checked = false;
    $('pHasOptions').checked = false;
    $('pHasRecipe').checked = false;
    variantDraft = [blankVariant()];
    optionDraft = [];
    recipeDraft = [];
  }
  renderVariantDraft();
  renderOptionDraft();
  renderRecipeDraft();
  syncProductMode();
  openModal('productModal');
}

async function saveProduct() {
  const name = $('pName').value.trim();
  const category = $('pCategory').value;
  if (!name) return toast('اسم الصنف مطلوب', 'error');
  if (!category) return toast('اختر الفئة', 'error');
  const hasVariants = $('pHasVariants').checked;
  const hasOptions = $('pHasOptions').checked;
  const hasRecipe = $('pHasRecipe').checked;
  if (hasVariants && variantDraft.length === 0) return toast('أضف حجمًا واحدًا على الأقل', 'error');
  if (hasOptions && optionDraft.length === 0) return toast('أضف نكهة واحدة على الأقل', 'error');
  if (hasRecipe && recipeDraft.length === 0) return toast('أضف خامة واحدة على الأقل أو أوقف الوصفة', 'error');
  if (hasRecipe && recipeDraft.some((r) => !r.materialId || !(Number(r.qty) > 0))) {
    return toast('أكمل اختيار الخامة والكمية في كل أسطر الوصفة', 'error');
  }
  const payload = {
    id: state.editingProductId || undefined,
    name,
    category,
    barcode: $('pBarcode').value.trim(),
    costPrice: Number($('pCost').value) || 0,
    sellingPrice: Number($('pPrice').value) || 0,
    stock: Number($('pStock').value) || 0,
    minStock: Number($('pMinStock').value) || 5,
    image: state.editingProductImage || '',
    hasVariants,
    hasOptions,
    hasRecipe,
    recipe: hasRecipe ? recipeDraft.map((r) => ({
      materialId: Number(r.materialId), qty: Number(r.qty) || 0, unit: r.unit
    })) : [],
    variants: hasVariants ? variantDraft.map((v) => ({
      id: v.id || undefined,
      name: String(v.name || '').trim(),
      costPrice: Number(v.costPrice) || 0,
      sellingPrice: Number(v.sellingPrice) || 0,
      stock: Number(v.stock) || 0
    })) : [],
    options: hasOptions ? optionDraft.map((o) => ({
      id: o.id || undefined,
      name: String(o.name || '').trim(),
      price: Number(o.price) || 0
    })) : []
  };
  if (!hasVariants && payload.sellingPrice <= 0) return toast('سعر البيع مطلوب', 'error');
  try {
    await api('products:save', payload);
    closeModal('productModal');
    state.products = await api('products:list');
    state.categories = await api('categories:list');
    renderProductsTable();
    renderCategories();
    renderProductGrid();
    toast('تم حفظ الصنف');
  } catch (err) { showError(err); }
}

async function deleteProduct(id) {
  if (!(await askConfirm('حذف صنف', 'هل تريد حذف هذا الصنف؟ الأصناف التي لها مبيعات سابقة ستُخفى فقط حفاظًا على التقارير.'))) return;
  try {
    const res = await api('products:delete', { id });
    state.products = await api('products:list');
    renderProductsTable();
    renderProductGrid();
    toast(res.hidden ? 'تم إخفاء الصنف (له مبيعات سابقة)' : 'تم حذف الصنف');
  } catch (err) { showError(err); }
}

/* ------------------------------ الفئات ------------------------------ */
async function renderCategoriesModal() {
  try {
    state.categories = await api('categories:list');
  } catch (err) { return showError(err); }
  $('categoriesList').innerHTML = state.categories.length
    ? state.categories.map((c) => `
      <div class="flex justify-between items-center bg-slate-50 p-2 rounded border">
        <span class="font-bold text-sm">${esc(c)}</span>
        <button data-delcat="${esc(c)}" class="text-red-500 hover:text-red-700 text-xs font-bold">حذف</button>
      </div>`).join('')
    : '<div class="text-center text-slate-400 py-4 text-sm">لا توجد فئات</div>';
}

async function addCategory() {
  const name = $('newCategoryName').value.trim();
  if (!name) return toast('أدخل اسم الفئة', 'warn');
  try {
    state.categories = await api('categories:add', { name });
    $('newCategoryName').value = '';
    renderCategoriesModal();
    renderCategories();
    $('pCategory').innerHTML = '<option value="">اختر الفئة...</option>' +
      state.categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    toast('تمت إضافة الفئة');
  } catch (err) { showError(err); }
}

async function deleteCategory(name) {
  if (!(await askConfirm('حذف فئة', `حذف الفئة "${name}"؟`))) return;
  try {
    state.categories = await api('categories:delete', { name });
    renderCategoriesModal();
    renderCategories();
    toast('تم حذف الفئة');
  } catch (err) { showError(err); }
}

async function exportProductsExcel() {
  try {
    const res = await api('export:excel', { kind: 'products' });
    if (res && res.ok) toast('تم حفظ ملف Excel');
  } catch (err) { showError(err); }
}

/* تصدير قائمة الأصناف PDF (A4) — يرسمها Chromium بخط Cairo المضمّن */
function buildProductsPdfHtml(products) {
  const s = state.settings;
  const cur = currency();
  const rows = products.map((p) => `
    <tr>
      <td>${esc(p.name)}</td>
      <td>${esc(p.category || '-')}</td>
      <td class="num">${money(p.sellingPrice)}</td>
      <td class="num">${money(p.costPrice)}</td>
      <td class="num">${esc(p.stock)}</td>
      <td class="num">${money((Number(p.sellingPrice) || 0) * (Number(p.stock) || 0))}</td>
    </tr>`).join('');
  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
  <style>
    @page { size: A4; margin: 12mm; }
    body { font-family: 'Cairo', Tahoma, sans-serif; direction: rtl; color: #111; font-size: 11px; margin: 0; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .sub { color: #555; font-size: 11px; margin-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 5px 4px; text-align: right; }
    th { background: #f1f5f9; font-size: 10.5px; }
    tfoot td { font-weight: 800; border-top: 2px solid #111; }
    .num { font-variant-numeric: tabular-nums; }
  </style></head><body>
    <h1>${esc(s.storeName || 'المتجر')} — قائمة الأصناف</h1>
    <div class="sub">عدد الأصناف: ${esc(products.length)} — ${esc(fmtDateTime(Date.now()))}</div>
    <table>
      <thead><tr><th>الصنف</th><th>الفئة</th><th>سعر البيع (${esc(cur)})</th><th>التكلفة (${esc(cur)})</th><th>المخزون</th><th>قيمة المخزون (${esc(cur)})</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6">لا توجد أصناف</td></tr>'}</tbody>
    </table>
  </body></html>`;
}

async function exportProductsPdf() {
  const products = state.products || [];
  if (!products.length) return toast('لا توجد أصناف للتصدير', 'warn');
  try {
    const res = await api('print:pdf', {
      html: buildProductsPdfHtml(products),
      widthMm: 210,
      heightMm: 297,
      marginMm: 10,
      defaultName: 'products-list'
    });
    if (res && res.ok) toast('تم حفظ قائمة الأصناف PDF');
  } catch (err) { showError(err); }
}

function bindProductEvents() {
  bind('addProductBtn', 'click', () => openProductModal(null));

  /* ---- محرر الأحجام والنكهات ---- */
  bind('pHasVariants', 'change', async (e) => {
    if (!e.target.checked && variantDraft.some((v) => String(v.name || '').trim())) {
      const ok = await askConfirm('إيقاف الأحجام',
        'سيتم حذف الأحجام ومخزونها ويعود الصنف إلى الحقول العامة. متابعة؟', 'danger');
      if (!ok) { e.target.checked = true; return; }
    }
    if (e.target.checked && variantDraft.length === 0) variantDraft.push(blankVariant());
    renderVariantDraft();
    syncProductMode();
  });
  bind('pHasOptions', 'change', async (e) => {
    if (!e.target.checked && optionDraft.some((o) => String(o.name || '').trim())) {
      const ok = await askConfirm('إيقاف النكهات',
        'سيتم حذف نكهات هذا الصنف نهائيًا. متابعة؟', 'danger');
      if (!ok) { e.target.checked = true; return; }
    }
    if (e.target.checked && optionDraft.length === 0) optionDraft.push(blankOption());
    renderOptionDraft();
    syncProductMode();
  });
  bind('addVariantBtn', 'click', () => {
    variantDraft.push(blankVariant());
    renderVariantDraft();
  });
  bind('addOptionBtn', 'click', () => {
    optionDraft.push(blankOption());
    renderOptionDraft();
  });

  /* ---- الخامات والوصفات ---- */
  bind('pHasRecipe', 'change', async (e) => {
    if (!e.target.checked && recipeDraft.some((r) => r.materialId)) {
      const ok = await askConfirm('إيقاف الوصفة',
        'سيُلغى ربط الخامات بهذا الصنف ولا يُخصم مخزون الخامات عند بيعه. متابعة؟', 'danger');
      if (!ok) { e.target.checked = true; return; }
    }
    if (e.target.checked && recipeDraft.length === 0) recipeDraft.push(blankRecipe());
    renderRecipeDraft();
    syncRecipeMode();
  });
  bind('addRecipeBtn', 'click', () => {
    if (!(state.materials || []).length) return toast('أضف الخامات أولًا من زر «الخامات»', 'warn');
    recipeDraft.push(blankRecipe());
    renderRecipeDraft();
  });
  bind('pRecipeList', 'input', (e) => {
    const field = e.target.dataset.rfield;
    const row = e.target.closest('[data-rrow]');
    if (!field || !row) return;
    const index = Number(row.dataset.rrow);
    if (recipeDraft[index]) recipeDraft[index][field] = e.target.value;
  });
  bind('pRecipeList', 'change', (e) => {
    const field = e.target.dataset.rfield;
    const row = e.target.closest('[data-rrow]');
    if (!field || !row) return;
    const index = Number(row.dataset.rrow);
    if (!recipeDraft[index]) return;
    recipeDraft[index][field] = e.target.value;
    if (field === 'materialId') {
      const material = (state.materials || []).find((m) => m.id === Number(e.target.value));
      if (material) recipeDraft[index].unit = material.unit;
      renderRecipeDraft();
    }
  });
  bind('pRecipeList', 'click', (e) => {
    const btn = e.target.closest('[data-delrecipe]');
    if (!btn) return;
    recipeDraft.splice(Number(btn.dataset.delrecipe), 1);
    renderRecipeDraft();
  });

  bind('manageMaterialsBtn', 'click', async () => {
    resetMaterialForm();
    await renderMaterialsModal();
    openModal('materialsModal');
  });
  bind('closeMaterialsModal', 'click', () => closeModal('materialsModal'));
  bind('saveMaterialBtn', 'click', saveMaterial);
  bind('cancelMaterialEditBtn', 'click', resetMaterialForm);
  bind('materialsTbody', 'click', (e) => {
    const edit = e.target.closest('[data-editmat]');
    if (edit) return editMaterial(Number(edit.dataset.editmat));
    const del = e.target.closest('[data-delmat]');
    if (del) return deleteMaterial(Number(del.dataset.delmat));
  });
  bind('mName', 'keydown', (e) => { if (e.key === 'Enter') saveMaterial(); });
  bind('pVariantsList', 'input', (e) => {
    const field = e.target.dataset.vfield;
    const row = e.target.closest('[data-vrow]');
    if (!field || !row) return;
    const index = Number(row.dataset.vrow);
    if (variantDraft[index]) variantDraft[index][field] = e.target.value;
  });
  bind('pVariantsList', 'click', (e) => {
    const btn = e.target.closest('[data-delvariant]');
    if (!btn) return;
    variantDraft.splice(Number(btn.dataset.delvariant), 1);
    renderVariantDraft();
  });
  bind('pOptionsList', 'input', (e) => {
    const field = e.target.dataset.ofield;
    const row = e.target.closest('[data-orow]');
    if (!field || !row) return;
    const index = Number(row.dataset.orow);
    if (optionDraft[index]) optionDraft[index][field] = e.target.value;
  });
  bind('pOptionsList', 'click', (e) => {
    const btn = e.target.closest('[data-deloption]');
    if (!btn) return;
    optionDraft.splice(Number(btn.dataset.deloption), 1);
    renderOptionDraft();
  });
  bind('cancelProduct', 'click', () => closeModal('productModal'));
  bind('saveProduct', 'click', saveProduct);
  bind('productsTbody', 'click', (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) return openProductModal(Number(edit.dataset.edit));
    const del = e.target.closest('[data-del]');
    if (del) return deleteProduct(Number(del.dataset.del));
  });
  bind('pImageFile', 'change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      // قصّ مربّع موحّد: كل صور الأصناف بنفس الأبعاد عند عرضها في الكاشير
      state.editingProductImage = await resizeImageFile(file, 480, 0.82, true);
      $('pImagePreview').innerHTML = `<img src="${esc(state.editingProductImage)}" class="h-16 rounded border" alt="">`;
      $('removeProductImageBtn').classList.remove('hidden');
    } catch (err) { toast(err.message, 'error'); }
  });
  bind('removeProductImageBtn', 'click', () => {
    state.editingProductImage = '';
    $('pImagePreview').innerHTML = '';
    $('pImageFile').value = '';
    $('removeProductImageBtn').classList.add('hidden');
  });

  bind('manageCategoriesBtn', 'click', async () => {
    await renderCategoriesModal();
    openModal('categoriesModal');
  });
  bind('closeCategories', 'click', () => closeModal('categoriesModal'));
  bind('addCategoryBtn', 'click', addCategory);
  bind('categoriesList', 'click', (e) => {
    const btn = e.target.closest('[data-delcat]');
    if (btn) deleteCategory(btn.dataset.delcat);
  });
  bind('exportProductsExcelBtn', 'click', exportProductsExcel);
  bind('exportProductsPdfBtn', 'click', exportProductsPdf);
  bind('newCategoryName', 'keydown', (e) => { if (e.key === 'Enter') addCategory(); });
}
