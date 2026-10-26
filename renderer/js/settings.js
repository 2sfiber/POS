'use strict';
/* ============================================================
   الإعدادات: الطباعة، المتجر، الضريبة، الأحجام، النسخ، الصلاحيات
   ============================================================ */

let aboutIconLoaded = false;
/**
 * أيقونة البرنامج في صفحة «عن البرنامج» — أيقونة التطبيق نفسها بدل شعار المتجر.
 * الصورة الساكنة (img/app-icon.png) معروضة دائمًا، وهذا التحديث يجعلها أيقونة
 * النسخة المثبّتة فعلًا عندما تتوفر من العملية الرئيسية.
 */
async function loadAboutIcon() {
  if (aboutIconLoaded) return;
  const img = $('aboutLogo');
  if (!img) return;
  aboutIconLoaded = true;
  try {
    const res = await api('app:icon');
    if (res && res.dataUrl) {
      img.src = res.dataUrl;
      img.className = 'h-32 w-32 md:h-40 md:w-40 flex-shrink-0 object-cover rounded-md';
    }
  } catch (err) { console.error('app icon', err); }
}

function applyLogo() {
  const logo = state.settings.logoData || '';
  // شعار المتجر لشاشة الدخول والترويسة فقط؛ صفحة «عن البرنامج» تعرض أيقونة البرنامج.
  const pairs = [
    ['loginLogo', 'loginIcon'],
    ['headerLogo', 'headerIcon']
  ];
  pairs.forEach(([imgId, iconId]) => {
    const img = $(imgId);
    const icon = $(iconId);
    if (!img) return;
    if (logo) {
      img.src = logo;
      img.classList.remove('hidden');
      if (icon) icon.classList.add('hidden');
    } else {
      img.classList.add('hidden');
      if (icon) icon.classList.remove('hidden');
    }
  });
  const preview = $('setLogoPreview');
  if (preview) {
    if (logo) { preview.src = logo; preview.classList.remove('hidden'); }
    else preview.classList.add('hidden');
  }
}

function toggleTaxInputs() {
  const enabled = $('setTaxEnabled').checked;
  $('setTaxName').disabled = !enabled;
  $('setTaxRate').disabled = !enabled;
}

/* مقاس الورق: قائمة جاهزة أو مقاس مخصص (مم) */
function applyPrinterWidthUi() {
  const sel = $('setPrinterWidth');
  const custom = $('setPrinterWidthCustom');
  if (!sel || !custom) return;
  custom.disabled = sel.value !== 'custom';
}

function selectedPaperWidth() {
  const sel = $('setPrinterWidth');
  if (!sel) return paperWidthMm();
  if (sel.value === 'custom') {
    const v = Number($('setPrinterWidthCustom').value);
    return Number.isFinite(v) && v >= 40 && v <= 112 ? Math.round(v) : 80;
  }
  const chosen = Number(sel.value);
  return Number.isFinite(chosen) && chosen >= 40 ? chosen : 80;
}

/* إظهار نتيجة الطباعة/التشخيص أسفل أزرار الاختبار */
function showPrintDiag(text) {
  const el = $('printDiag');
  if (!el) return;
  el.textContent = String(text || '');
  el.classList.toggle('hidden', !text);
}

function renderSettings() {
  const s = state.settings;
  const val = (id, v) => { if ($(id)) $(id).value = v == null ? '' : v; };
  const chk = (id, v) => { if ($(id)) $(id).checked = !!v; };

  const storedWidth = Number(s.printerWidth) || 80;
  const isPreset = [58, 76, 80].includes(storedWidth);
  val('setPrinterWidth', isPreset ? String(storedWidth) : 'custom');
  val('setPrinterWidthCustom', storedWidth);
  val('setPrintMode', s.printMode || 'auto');
  val('setPrinterDpi', String(Number(s.printerDpi) || 203));
  val('setPrinterDots', Number(s.printerDots) || 0);
  val('setFeedLines', s.feedLines != null ? s.feedLines : 4);
  val('setCutFeedMm', s.cutFeedMm != null ? s.cutFeedMm : 20);
  chk('setCutPaper', s.cutPaper !== false);
  applyPrinterWidthUi();
  val('setPrintDelay', s.printDelay != null ? s.printDelay : 5);
  val('setCopiesCustomer', s.copiesCustomer != null ? s.copiesCustomer : 1);
  val('setCopiesKitchen', s.copiesKitchen != null ? s.copiesKitchen : 1);
  chk('setPreviewBeforePrint', s.previewBeforePrint !== false);
  chk('setAutoPrint', s.autoPrint);
  chk('setShowBarcodeOnInvoice', s.showBarcodeOnInvoice !== false);
  chk('setPrintCustomer', s.printCustomer !== false);
  chk('setPrintKitchen', s.printKitchen !== false);
  val('setInvoicePrefix', s.invoicePrefix || 'INV-');
  val('setFooterText', s.footerText || '');

  val('setStoreName', s.storeName || '');
  val('setStoreAddress', s.storeAddress || '');
  val('setStorePhone', s.storePhone || '');
  val('setTaxNumber', s.taxNumber || '');
  val('setCurrency', s.currency || 'ر.ي');
  chk('setShowAddressOnInvoice', s.showAddressOnInvoice !== false);
  chk('setShowPhoneOnInvoice', s.showPhoneOnInvoice !== false);
  chk('setShowLogoOnInvoice', s.showLogoOnInvoice !== false);

  chk('setTaxEnabled', s.taxEnabled);
  val('setTaxName', s.taxName || 'الضريبة');
  val('setTaxRate', s.taxRate || 0);
  toggleTaxInputs();

  chk('setLowStockAlerts', s.lowStockAlerts !== false);

  val('setProductCardWidth', s.productCardWidth || 110);
  val('setProductNameFontSize', s.productNameFontSize || 12);
  val('setProductPriceFontSize', s.productPriceFontSize || 12);
  val('setProductImageHeight', s.productImageHeight || 60);    val('setKitchenPrinterName', s.kitchenPrinterName || '');
  val('setReportPrinterName', s.reportPrinterName || '');
  val('setReportA4PrinterName', s.reportA4PrinterName || '');

  chk('setAutoBackupEnabled', s.autoBackupEnabled !== false);
  val('backupIntervalSelect', s.backupInterval || 24);
  val('backupKeepSelect', s.backupKeep || 30);

  $('dbPathLabel').textContent = (state.info.db && state.info.db.path) || '';
  /* بطاقة «عن البرنامج»: اسم البرنامج + رقم الإصدار + التحديث المثبّت فقط */
  const info = state.info || {};
  if ($('aboutVersion')) $('aboutVersion').textContent = info.version || state.appVersion || '—';
  if ($('aboutBuild')) $('aboutBuild').textContent = info.build || '—';

  applyLogo();
  loadAboutIcon();
  loadPrinters(true);
  loadBackupList();
  renderDeliveryList();
  showSettingsTab(activeSettingsTab);
}

function collectSettings() {
  const num = (id, d) => {
    const v = Number($(id).value);
    return Number.isFinite(v) ? v : d;
  };
  const str = (id) => ($(id).value || '').trim();
  return {
    printerWidth: String(selectedPaperWidth()),
    printMode: $('setPrintMode').value || 'auto',
    printerDpi: Number($('setPrinterDpi').value) || 203,
    printerDots: Math.min(1024, Math.max(0, num('setPrinterDots', 0))),
    feedLines: Math.min(12, Math.max(0, num('setFeedLines', 4))),
    cutFeedMm: Math.min(40, Math.max(0, num('setCutFeedMm', 20))),
    cutPaper: $('setCutPaper').checked,
    printerName: $('setPrinterName').value || '',
    kitchenPrinterName: $('setKitchenPrinterName').value || '',
    reportPrinterName: $('setReportPrinterName').value || '',
    reportA4PrinterName: $('setReportA4PrinterName').value || '',
    printDelay: Math.max(0, num('setPrintDelay', 5)),
    copiesCustomer: Math.max(0, num('setCopiesCustomer', 1)),
    copiesKitchen: Math.max(0, num('setCopiesKitchen', 1)),
    previewBeforePrint: $('setPreviewBeforePrint').checked,
    autoPrint: $('setAutoPrint').checked,
    showBarcodeOnInvoice: $('setShowBarcodeOnInvoice').checked,
    printCustomer: $('setPrintCustomer').checked,
    printKitchen: $('setPrintKitchen').checked,
    invoicePrefix: str('setInvoicePrefix') || 'INV-',
    footerText: str('setFooterText'),
    storeName: str('setStoreName'),
    storeAddress: str('setStoreAddress'),
    storePhone: str('setStorePhone'),
    taxNumber: str('setTaxNumber'),
    currency: $('setCurrency').value,
    showAddressOnInvoice: $('setShowAddressOnInvoice').checked,
    showPhoneOnInvoice: $('setShowPhoneOnInvoice').checked,
    showLogoOnInvoice: $('setShowLogoOnInvoice').checked,
    taxEnabled: $('setTaxEnabled').checked,
    taxName: str('setTaxName') || 'الضريبة',
    taxRate: Math.min(100, Math.max(0, num('setTaxRate', 0))),
    lowStockAlerts: $('setLowStockAlerts').checked,
    productCardWidth: Math.min(250, Math.max(80, num('setProductCardWidth', 110))),
    productNameFontSize: Math.min(24, Math.max(9, num('setProductNameFontSize', 12))),
    productPriceFontSize: Math.min(24, Math.max(9, num('setProductPriceFontSize', 12))),
    productImageHeight: Math.min(150, Math.max(40, num('setProductImageHeight', 60))),
    autoBackupEnabled: $('setAutoBackupEnabled').checked,
    backupInterval: num('backupIntervalSelect', 24),
    backupKeep: num('backupKeepSelect', 30),
    logoData: state.settings.logoData || ''
  };
}

async function saveSettings() {
  try {
    const saved = await api('settings:save', collectSettings());
    state.settings = saved;
    applyProductSizes();
    applyLogo();
    applyBrandName();
    renderProductGrid();
    updateTotals();
    toast('تم حفظ الإعدادات');
  } catch (err) { showError(err); }
}

async function loadPrinters(silent) {
  try {
    const printers = await api('print:list');
    state.printers = printers || [];
    const options = (emptyLabel) => `<option value="">${emptyLabel}</option>` +
      state.printers.map((p) => `<option value="${esc(p.name)}">${esc(p.displayName || p.name)}${p.isDefault ? ' (افتراضية)' : ''}</option>`).join('');
    const pick = (id, current, emptyLabel) => {
      const el = $(id);
      if (!el) return;
      el.innerHTML = options(emptyLabel);
      el.value = state.printers.some((p) => p.name === current) ? current : '';
    };
    pick('setPrinterName', state.settings.printerName || '', 'الطابعة الافتراضية للنظام');
    pick('setKitchenPrinterName', state.settings.kitchenPrinterName || '', 'نفس طابعة العميل');
    pick('setReportPrinterName', state.settings.reportPrinterName || '', 'الطابعة الافتراضية للنظام');
    pick('setReportA4PrinterName', state.settings.reportA4PrinterName || '', 'الطابعة الافتراضية للنظام');
    const select = $('setPrinterName');
    $('printersHint').textContent = state.printers.length
      ? `تم العثور على ${state.printers.length} طابعة. ` + describePrinter(state.printers.find((p) => p.name === select.value) || state.printers.find((p) => p.isDefault) || state.printers[0])
      : 'لا توجد طابعات مثبتة على الجهاز. ثبّت الطابعة من إعدادات النظام ثم اضغط تحديث.';
    if (!silent && state.printers.length === 0) toast('لا توجد طابعات مثبتة على الجهاز', 'warn');
  } catch (err) {
    $('printersHint').textContent = 'تعذّر جلب قائمة الطابعات: ' + err.message;
    if (!silent) showError(err);
  }
}

function describePrinter(p) {
  if (!p) return '';
  const bits = [];
  if (p.portName) bits.push(`المنفذ ${p.portName}`);
  if (p.driverName) bits.push(p.driverName);
  if (p.thermal) bits.push('حرارية — طباعة مباشرة');
  return bits.length ? `(${bits.join(' — ')})` : '';
}

function printFormOptions() {
  return {
    printerName: $('setPrinterName').value || '',
    paperWidth: selectedPaperWidth(),
    mode: $('setPrintMode').value || 'auto',
    dpi: Number($('setPrinterDpi').value) || 203,
    dots: Math.max(0, Number($('setPrinterDots').value) || 0),
    feedLines: Math.max(0, Number($('setFeedLines').value) || 0),
    cutFeedMm: Math.min(40, Math.max(0, Number($('setCutFeedMm').value) || 0)),
    cut: $('setCutPaper').checked
  };
}

function printResultText(res) {
  if (!res) return 'لا استجابة من نظام الطباعة';
  const lines = [];
  if (res.ok) {
    lines.push('تمت الطباعة بنجاح ✔');
    lines.push(`المسار: ${res.mode === 'escpos' ? 'ESC/POS مباشر (RAW)' : 'تعريف ويندوز'}`);
    if (res.printer) lines.push(`الطابعة: ${res.printer}`);
    if (res.portName) lines.push(`المنفذ: ${res.portName}`);
    if (res.driverName) lines.push(`التعريف: ${res.driverName}`);
    if (res.dots) lines.push(`عرض الطباعة: ${res.dots} نقطة — ${res.dpi || ''} dpi`);
  } else {
    lines.push('فشلت الطباعة ✖');
    lines.push(`السبب: ${res.error || 'غير معروف'}`);
    if (res.printer) lines.push(`الطابعة: ${res.printer}`);
    if (res.portName) lines.push(`المنفذ: ${res.portName}`);
    if (res.driverName) lines.push(`التعريف: ${res.driverName}`);
    lines.push('جرّب: اختر «ESC/POS مباشر» ثم أعد الاختبار، أو اضغط «تشخيص».');
  }
  return lines.join('\n');
}

async function testPrinter() {
  try {
    showPrintDiag('جارٍ إرسال صفحة الاختبار…');
    const res = await api('print:test', printFormOptions());
    showPrintDiag(printResultText(res));
    if (res && res.ok) toast('تمت إرسال صفحة الاختبار للطابعة');
    else toast('فشل الاختبار: ' + ((res && res.error) || ''), 'error');
  } catch (err) {
    showPrintDiag('تعذّر الاختبار: ' + err.message);
    showError(err);
  }
}

/* ---------- طابعة التقارير A4: صفحة اختبار ---------- */
function a4TestPageHtml() {
  const s = state.settings;
  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">
  <style>
    @page { size: A4; margin: 12mm; }
    body { font-family: 'Cairo', Tahoma, sans-serif; direction: rtl; color: #111; font-size: 12px; margin: 0; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .sub { color: #555; margin-bottom: 12px; }
    .box { border: 1px solid #d1d5db; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; margin-top: 6px; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 6px; text-align: right; }
    th { background: #f1f5f9; }
    .foot { margin-top: 14px; color: #666; font-size: 10px; }
  </style></head><body>
    <h1>${esc(s.storeName || 'المتجر')} — صفحة اختبار طابعة التقارير (A4)</h1>
    <div class="sub">تم إنشاء الصفحة: ${esc(fmtDateTime(Date.now()))}</div>
    <div class="box">
      <b>إذا ظهرت هذه الصفحة كاملة على ورقة A4 فالطابعة مهيّأة لطباعة التقارير.</b>
      <div style="margin-top:4px">الحواف الافتراضية ١٢ مم — لا حاجة لتغيير أي إعداد في الطابعة.</div>
    </div>
    <table>
      <thead><tr><th>البند</th><th>القيمة</th></tr></thead>
      <tbody>
        <tr><td>اسم المتجر</td><td>${esc(s.storeName || '—')}</td></tr>
        <tr><td>الفرع / العنوان</td><td>${esc(s.storeAddress || '—')}</td></tr>
        <tr><td>الهاتف</td><td>${esc(s.storePhone || '—')}</td></tr>
        <tr><td>العملة</td><td>${esc(currency())}</td></tr>
        <tr><td>الإصدار</td><td>${esc(appVersionLabel())}</td></tr>
      </tbody>
    </table>
    <div class="foot">‏POS Pro — نظام نقاط البيع الاحترافي</div>
  </body></html>`;
}

async function testA4Printer() {
  showPrintDiag('جارٍ إرسال صفحة اختبار A4…');
  try {
    const res = await api('print:a4', {
      html: a4TestPageHtml(),
      printerName: $('setReportA4PrinterName').value || '',
      jobName: 'اختبار طابعة A4'
    });
    if (res && res.ok) {
      showPrintDiag(`تمت إرسال الصفحة إلى: ${res.printer || 'الطابعة الافتراضية'}\nالورق: A4`);
      toast('تمت إرسال صفحة اختبار A4');
    } else {
      showPrintDiag('فشلت الطباعة ✖\n' + ((res && res.error) || 'سبب غير معروف'));
      toast('فشل اختبار الطباعة A4', 'error');
    }
  } catch (err) {
    showPrintDiag('تعذّر الاختبار: ' + err.message);
    showError(err);
  }
}

/* ---------- روابط التواصل في «عن البرنامج» ---------- */
async function openAboutLink(url) {
  try {
    await api('app:openExternal', { url });
  } catch (err) {
    const hint = $('aboutContactHint');
    if (hint) hint.textContent = 'تعذّر الفتح تلقائيًا — الرقم: 774465817 (واتساب: +967 774 465 817)';
    toast('تعذّر فتح الرابط', 'warn');
  }
}

async function diagnosePrinter() {
  try {
    showPrintDiag('جارٍ التشخيص…');
    const res = await api('print:info', { printerName: $('setPrinterName').value || '' });
    if (!res || !res.ok) return showPrintDiag('تعذّر التشخيص');
    const lines = [`الطابعات المثبتة: ${res.printers.length}`];
    const t = res.target;
    if (t) {
      lines.push(`الطابعة: ${t.name}`);
      lines.push(`التعريف: ${t.driverName || '—'}`);
      lines.push(`المنفذ: ${t.portName || '—'}`);
      lines.push(`النوع: ${res.thermal ? 'حرارية ESC/POS' : 'غير معروفة (تعريف ويندوز)'}`);
      lines.push(`التوصية: ${res.recommendedMode === 'escpos' ? 'الطباعة المباشرة ESC/POS' : 'تعريف ويندوز'}`);
    }
    lines.push(`المقاس الحالي: ${$('setPrinterWidth').value === 'custom' ? $('setPrinterWidthCustom').value : $('setPrinterWidth').value} مم — ${$('setPrinterDpi').value} dpi`);
    showPrintDiag(lines.join('\n'));
  } catch (err) {
    showPrintDiag('تعذّر التشخيص: ' + err.message);
    showError(err);
  }
}

/* ------------------------------ النسخ الاحتياطي ------------------------------ */
async function loadBackupList() {
  try {
    const list = await api('backup:list');
    $('backupStatus').textContent = list.length
      ? `عدد النسخ المحفوظة: ${list.length} — آخر نسخة: ${fmtDateTime(list[0].mtime)}`
      : 'لا توجد نسخ احتياطية بعد';
    $('backupList').innerHTML = list.slice(0, 6).map((b) =>
      `<div class="flex justify-between gap-2"><span class="font-mono truncate">${esc(b.name)}</span>
        <span class="shrink-0">${(b.size / 1024).toFixed(0)} كيلوبايت</span></div>`).join('');
  } catch (err) {
    $('backupStatus').textContent = 'تعذر جلب النسخ: ' + err.message;
  }
}

async function createBackupNow() {
  try {
    const res = await api('backup:create');
    toast('تم إنشاء النسخة الاحتياطية');
    $('backupStatus').textContent = res && res.file ? res.file : '';
    await loadBackupList();
  } catch (err) { showError(err); }
}

async function exportBackupFile() {
  try {
    const res = await api('backup:export');
    if (res && res.ok) toast('تم حفظ النسخة الاحتياطية');
  } catch (err) { showError(err); }
}

async function importLegacyBackup() {
  if (!(await askConfirm('استيراد نسخة المتصفح القديمة',
    'سيتم استبدال بيانات النظام الحالية ببيانات الملف القديم بعد تحويلها. تُؤخذ نسخة أمان تلقائيًا أولًا. متابعة؟'))) return;
  try {
    const res = await api('backup:importLegacy');
    if (res && res.ok) {
      toast(`تم استيراد ${res.invoices} فاتورة و${res.products} صنف`);
      setTimeout(() => location.reload(), 1500);
    }
  } catch (err) { showError(err); }
}

async function importBackupFile() {
  if (!(await askConfirm('استعادة نسخة احتياطية',
    'سيتم استبدال كل البيانات الحالية ببيانات الملف. سيتم أخذ نسخة أمان تلقائيًا قبل الاستبدال. متابعة؟'))) return;
  try {
    const res = await api('backup:import');
    if (res && res.ok) {
      toast('تمت الاستعادة، سيتم إعادة تشغيل الواجهة');
      setTimeout(() => location.reload(), 1200);
    }
  } catch (err) { showError(err); }
}

/* ------------------------------ شركات التوصيل ------------------------------ */
async function renderDeliveryList() {
  try {
    state.delivery = await api('delivery:list');
    const list = $('deliveryList');
    list.innerHTML = state.delivery.length
      ? state.delivery.map((d) => `
        <div class="flex justify-between items-center bg-slate-50 border rounded px-2 py-1 text-xs">
          <span class="font-bold">${esc(d.name)} <span class="text-slate-400 font-normal">(${money(d.commission)}%)</span></span>
          <button data-deldelivery="${d.id}" class="text-red-500 font-bold">حذف</button>
        </div>`).join('')
      : '<div class="text-center text-slate-400 text-xs py-2">لا توجد شركات توصيل</div>';
    const select = $('deliveryCompany');
    if (select) {
      const current = select.value;
      select.innerHTML = '<option value="">بدون توصيل (محلي)</option>' +
        state.delivery.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
      select.value = current;
    }
  } catch (err) { console.error(err); }
}

async function addDeliveryCompany() {
  const name = $('deliveryName').value.trim();
  if (!name) return toast('أدخل اسم الشركة', 'warn');
  try {
    state.delivery = await api('delivery:save', {
      name,
      commission: Number($('deliveryCommission').value) || 0
    });
    $('deliveryName').value = '';
    $('deliveryCommission').value = '';
    await renderDeliveryList();
    toast('تمت إضافة شركة التوصيل');
  } catch (err) { showError(err); }
}

async function deleteDeliveryCompany(id) {
  if (!(await askConfirm('حذف شركة توصيل', 'حذف هذه الشركة؟'))) return;
  try {
    state.delivery = await api('delivery:delete', { id: Number(id) });
    await renderDeliveryList();
    toast('تم الحذف');
  } catch (err) { showError(err); }
}

/* ------------------------------ كلمة المرور ------------------------------ */
async function changeOwnPassword() {
  const oldPassword = $('pwOld').value;
  const newPassword = $('pwNew').value;
  const confirm = $('pwNew2').value;
  if (!oldPassword || !newPassword) return toast('أكمل الحقول', 'warn');
  if (newPassword.length < 6) return toast('كلمة المرور قصيرة (6 أحرف على الأقل)', 'warn');
  if (newPassword !== confirm) return toast('تأكيد كلمة المرور غير مطابق', 'error');
  try {
    const res = await api('auth:changePassword', { oldPassword, newPassword });
    state.user = res.user || state.user;
    $('pwOld').value = '';
    $('pwNew').value = '';
    $('pwNew2').value = '';
    toast('تم تغيير كلمة المرور');
  } catch (err) { showError(err); }
}

/* ------------------------------ التبويبات ------------------------------ */
let activeSettingsTab = 'print';

function showSettingsTab(name) {
  const tab = name || 'print';
  activeSettingsTab = tab;
  document.querySelectorAll('#settingsTabs .settings-tab').forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.className = 'settings-tab px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition ' +
      (active ? 'bg-emerald-600 text-white shadow' : 'bg-slate-50 text-slate-600 hover:bg-slate-200');
  });
  document.querySelectorAll('#view-settings [data-tab]').forEach((panel) => {
    if (panel.classList.contains('settings-tab')) return;
    panel.classList.toggle('hidden', panel.dataset.tab !== tab);
  });
  /* زر «حفظ جميع الإعدادات» لا يظهر في تبويب «عن البرنامج» */
  const saveWrap = $('saveSettingsWrap');
  if (saveWrap) saveWrap.classList.toggle('hidden', tab === 'about');
  if (tab === 'update') loadUpdateInfo();
}

/* ------------------------------ البيانات: تصفير / حذف كامل ------------------------------ */
async function resetSalesData() {
  const done = await askDanger({
    title: '🧹 تصفير بيانات المبيعات',
    lines: [
      '<b>سيُحذف:</b> الفواتير وبنودها، الورديات، المعلّقة، المصروفات، حركات الخزنة ودفتر النقدية، الذمم، وأرقام الفواتير.',
      '<b>سيبقى كما هو:</b> الإعدادات، المستخدمون، الأصناف والتصنيفات، شركات التوصيل، والعملاء.',
      '<b>ويُصفَّر:</b> مخزون كل الأصناف إلى 0.'
    ],
    confirmText: 'تصفير الآن',
    action: ({ password }) => api('data:reset', { password })
  });
  if (!done) return;
  toast('تم تصفير البيانات — الإعدادات محفوظة');
  setTimeout(() => location.reload(), 1000);
}

async function wipeAllData() {
  const done = await askDanger({
    title: '🗑️ حذف كل شيء',
    lines: [
      'ستُحذف قاعدة البيانات كاملة: الإعدادات، المستخدمون، الأصناف، الفواتير، والنسخ الاحتياطية.',
      'ستُنشأ قاعدة جديدة فارغة بحساب البدء admin / admin123 (يُطلب تغييره عند أول دخول).',
      '<b>لا يمكن التراجع.</b>'
    ],
    phrase: 'حذف كامل',
    confirmText: 'حذف نهائي',
    action: ({ password }) => api('data:wipe', { password })
  });
  if (!done) return;
  toast('تم الحذف — سيعاد تشغيل البرنامج');
}

/* ------------------------------ التحديث المحلي ------------------------------ */
function showUpdateStatus(text) {
  const el = $('updateStatus');
  if (!el) return;
  el.textContent = String(text || '');
  el.classList.toggle('hidden', !text);
}

async function loadUpdateInfo() {
  try {
    const info = await api('update:info');
    const label = `${info.version}${info.build ? ' — بناء ' + info.build : ''}${info.packaged ? '' : ' (وضع تطوير)'}`;
    const el = $('updateCurrentVersion');
    if (el) el.textContent = label;
    const pathEl = $('updateExePath');
    if (pathEl && info.exePath) pathEl.textContent = info.exePath;
    const pendingBox = $('updatePendingBox');
    if (pendingBox) pendingBox.classList.toggle('hidden', !info.pending);
  } catch (err) {
    showUpdateStatus('تعذّر قراءة معلومات التحديث: ' + err.message);
  }
}

/* ---------- تشخيص التحديث: المسارات الحقيقية وبصمة الملف العامل ---------- */
let lastUpdateDiagText = '';

async function showUpdateDiagnostics() {
  const out = $('updateDiagOut');
  if (!out) return;
  out.classList.remove('hidden');
  out.textContent = 'جارٍ القراءة…';
  try {
    const d = await api('update:diagnostics');
    const mb = (n) => (Number(n || 0) / 1048576).toFixed(1) + ' MB';
    const last = d.last;
    const lastLine = last
      ? `آخر محاولة: ${last.ok ? (last.verified === false ? 'طُبّقت على نسخة أخرى (لم تتغير النسخة العاملة)' : 'نجحت') : 'فشلت'}` +
        (last.build ? ` — بناء ${last.build}` : '') + (last.at ? ` — ${last.at}` : '') +
        (last.error ? `\nالسبب: ${last.error}` : '')
      : 'آخر محاولة: لا يوجد سجل تحديث بعد';
    lastUpdateDiagText = [
      `النسخة العاملة: ${d.version || '—'}${d.build ? ' — بناء ' + d.build : ' — بلا رقم بناء'}`,
      `البرنامج: ${d.exePath || '—'}`,
      `مجلد الموارد: ${d.resourcesPath || '—'}`,
      `app.asar: ${d.asar && d.asar.exists ? mb(d.asar.bytes) : 'غير موجود'}` +
        (d.asar && d.asar.sha256 ? `\nالبصمة: ${d.asar.sha256.slice(0, 24)}…` : ''),
      `تحديث معلّق: ${d.pending ? 'نعم' : 'لا'} — نسخة أمان: ${d.backup ? 'موجودة' : 'لا'}`,
      lastLine,
      d.log ? `\nآخر سطور سجل التحديث:\n${d.log}` : ''
    ].filter(Boolean).join('\n');
    out.textContent = lastUpdateDiagText;
  } catch (err) {
    lastUpdateDiagText = 'تعذّر التشخيص: ' + err.message;
    out.textContent = lastUpdateDiagText;
  }
}

async function applyPendingUpdate() {
  if (!(await askConfirm('تطبيق التحديث المعلّق',
    'سيُغلق البرنامج الآن، ثم يُطبَّق التحديث المجهّز ويُعاد تشغيله تلقائيًا. متابعة؟'))) return;
  try {
    const res = await api('update:applyPending');
    if (!res || !res.ok) return showUpdateStatus('✖ ' + ((res && res.error) || 'تعذّر التطبيق'));
    showUpdateStatus('جارٍ إغلاق البرنامج لتطبيق التحديث…');
  } catch (err) {
    showUpdateStatus('✖ ' + err.message);
  }
}

async function copyUpdateDiagnostics() {
  if (!lastUpdateDiagText) await showUpdateDiagnostics();
  if (!lastUpdateDiagText) return;
  try {
    await api('app:copyText', { text: lastUpdateDiagText });
    toast('تم نسخ تفاصيل التشخيص');
  } catch (err) { showError(err); }
}

let preparedUpdate = null;

/** المرحلة ١: اختيار الملف، التحقق، ثم عرض سجل التغييرات قبل أي تثبيت. */
async function pickUpdateFile() {
  showUpdateStatus('جارٍ فحص ملف التحديث والتحقق من سلامته…');
  try {
    const res = await api('update:prepare');
    if (res && res.canceled) return showUpdateStatus('تم إلغاء التحديث.');
    if (!res || !res.ok) return showUpdateStatus('✖ ' + ((res && res.error) || 'فشل التحديث'));
    preparedUpdate = res;
    openUpdateChangelog(res);
  } catch (err) {
    showUpdateStatus('✖ ' + err.message);
  }
}

function openUpdateChangelog(res) {
  const m = res.manifest || {};
  const cur = res.current || {};
  $('updateChangelogVersions').textContent =
    `${cur.version || ''}${cur.build ? ' (' + cur.build + ')' : ''}  ←  ${m.version || ''}${m.build ? ' (' + m.build + ')' : ''}`;
  const items = Array.isArray(m.changelog) && m.changelog.length
    ? m.changelog
    : ['تحسينات في الأداء والاستقرار.'];
  $('updateChangelogList').innerHTML = items.map((line) => `<li>${esc(line)}</li>`).join('');
  $('updateChangelogSize').textContent = m.size ? `${(Number(m.size) / 1048576).toFixed(1)} MB` : '—';
  openModal('updateChangelogModal');
}

/** المرحلة ٢: شاشة التقدم ثم تشغيل سكربت التبديل وإعادة التشغيل. */
async function confirmUpdate() {
  if (!preparedUpdate) return;
  closeModal('updateChangelogModal');
  openModal('updateProgressModal');
  const bar = $('updateProgressBar');
  const text = $('updateProgressText');
  const steps = [
    [20, 'جارٍ التحقق من البصمة والملفات…'],
    [45, 'نسخ ملفات التحديث بشكل آمن…'],
    [75, 'تجهيز التبديل بعد إغلاق البرنامج…'],
    [100, 'اكتمل التحضير — سيُعاد تشغيل البرنامج…']
  ];
  for (const [pct, label] of steps) {
    if (bar) bar.style.width = pct + '%';
    if (text) text.textContent = label;
    await new Promise((resolve) => setTimeout(resolve, 550));
  }
  try {
    const res = await api('update:commit');
    if (!res || !res.ok) throw new Error((res && res.error) || 'فشل تثبيت التحديث');
    preparedUpdate = null;
  } catch (err) {
    closeModal('updateProgressModal');
    showUpdateStatus('✖ ' + err.message);
  }
}

async function cancelPreparedUpdate() {
  closeModal('updateChangelogModal');
  preparedUpdate = null;
  try { await api('update:cancel'); } catch { /* ignore */ }
  showUpdateStatus('تم إلغاء التحديث — لم يُطبَّق أي تغيير على البرنامج.');
}

/* ------------------------------ الأحداث ------------------------------ */
function bindSettingsEvents() {
  bind('saveSettingsBtn', 'click', saveSettings);

  const tabs = $('settingsTabs');
  if (tabs) {
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.settings-tab');
      if (btn) showSettingsTab(btn.dataset.tab);
    });
  }
  bind('resetDataBtn', 'click', resetSalesData);
  bind('wipeDataBtn', 'click', wipeAllData);
  bind('pickUpdateBtn', 'click', pickUpdateFile);
  bind('updateDiagBtn', 'click', showUpdateDiagnostics);
  bind('applyPendingUpdateBtn', 'click', applyPendingUpdate);
  bind('updateCopyDiagBtn', 'click', copyUpdateDiagnostics);
  bind('updateConfirmBtn', 'click', confirmUpdate);
  bind('updateCancelBtn', 'click', cancelPreparedUpdate);
  bind('dangerCancel', 'click', () => closeDanger(null));
  bind('dangerConfirm', 'click', submitDanger);
  bind('setTaxEnabled', 'change', toggleTaxInputs);
  bind('refreshPrintersBtn', 'click', () => loadPrinters(false));
  bind('testPrintBtn', 'click', testPrinter);
  bind('testA4PrintBtn', 'click', testA4Printer);
  ['aboutWhatsappBtn', 'aboutCallBtn'].forEach((id) => {
    bind(id, 'click', () => {
      const btn = $(id);
      if (btn && btn.dataset.url) openAboutLink(btn.dataset.url);
    });
  });
  bind('diagnosePrintBtn', 'click', diagnosePrinter);
  bind('setPrinterWidth', 'change', applyPrinterWidthUi);
  bind('setPrinterName', 'change', () => {
    const chosen = state.printers.find((p) => p.name === $('setPrinterName').value);
    $('printersHint').textContent = state.printers.length
      ? `تم العثور على ${state.printers.length} طابعة. ${describePrinter(chosen)}`
      : 'لا توجد طابعات مثبتة على الجهاز.';
  });

  bind('applyProductSizeBtn', 'click', async () => {
    Object.assign(state.settings, {
      productCardWidth: Number($('setProductCardWidth').value) || 110,
      productNameFontSize: Number($('setProductNameFontSize').value) || 12,
      productPriceFontSize: Number($('setProductPriceFontSize').value) || 12,
      productImageHeight: Number($('setProductImageHeight').value) || 60
    });
    applyProductSizes();
    toast('تم تطبيق الحجم (احفظ الإعدادات لتثبيته)');
  });

  bind('setLogoFile', 'change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      state.settings.logoData = await resizeImageFile(file, 400, 0.9);
      applyLogo();
      toast('تم تحديث الشعار — اضغط حفظ الإعدادات');
    } catch (err) { toast(err.message, 'error'); }
  });
  bind('removeLogoBtn', 'click', () => {
    state.settings.logoData = '';
    applyLogo();
    toast('سيُحذف الشعار بعد حفظ الإعدادات', 'warn');
  });

  bind('createBackupBtn', 'click', createBackupNow);
  bind('exportBackupBtn', 'click', exportBackupFile);
  bind('importBackupBtn', 'click', importBackupFile);
  bind('importLegacyBtn', 'click', importLegacyBackup);
  bind('openBackupFolderBtn', 'click', async () => {
    try { await api('backup:openFolder'); } catch (err) { showError(err); }
  });
  bind('openDataFolderBtn', 'click', async () => {
    try { await api('app:openDataFolder'); } catch (err) { showError(err); }
  });

  bind('addDeliveryBtn', 'click', addDeliveryCompany);
  bind('deliveryList', 'click', (e) => {
    const btn = e.target.closest('[data-deldelivery]');
    if (btn) deleteDeliveryCompany(btn.dataset.deldelivery);
  });

  bind('changePasswordBtn', 'click', changeOwnPassword);
}
