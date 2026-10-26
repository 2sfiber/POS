'use strict';
/* ============================================================
   الطباعة: بناء فاتورة HTML ثم إرسالها للعملية الرئيسية
   (نافذة Chromium مخفية تطبع عبر النظام — لا iframe ولا نافذة متصفح)
   ============================================================ */

const PRINT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

function receiptStyles(widthMm) {
  const mm = Number(widthMm) >= 40 ? Number(widthMm) : 80;
  const narrow = mm <= 62;
  // العرض القابل للطباعة: 58 مم → 48 مم، 76/80 مم → 68/72 مم
  const w = Math.max(24, Math.round((mm <= 60 ? mm - 10 : mm - 8) * 10) / 10);
  const fs = narrow ? 10 : (mm <= 70 ? 11 : 12);
  const big = fs + 4;
  return `
    @page { size: ${mm}mm auto; margin: 0; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { margin: 0; padding: 0; background: #fff; }
    body, .receipt {
      width: ${w}mm; margin: 0 auto; padding: 2mm;
      font-family: 'Cairo', Tahoma, Arial, sans-serif; font-size: ${fs}px; color: #000;
      direction: rtl; text-align: right;
    }
    .center { text-align: center; }
    .bold { font-weight: 700; }
    .big { font-size: ${big}px; }
    .hr { border-top: 1px dashed #000; margin: 4px 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: right; padding: 1px 0; font-size: ${fs}px; vertical-align: top; }
    th { border-bottom: 1px solid #000; font-weight: 700; }
    .mono { font-variant-numeric: tabular-nums; }
    /* أعمدة الفاتورة: عرض ثابت ومحاذاة موحّدة كي تصطف الأرقام تحت عناوينها */
    table.items { table-layout: fixed; }
    table.items th, table.items td { padding: 1px 0; }
    .c-name { width: auto; text-align: right; }
    .c-qty { width: 13%; text-align: center; }
    .c-price { width: 24%; text-align: center; }
    .c-total { width: 27%; text-align: center; }
    table.items td.c-qty, table.items td.c-price, table.items td.c-total,
    table.items th.c-qty, table.items th.c-price, table.items th.c-total {
      font-variant-numeric: tabular-nums; text-align: center;
    }
    .row { display: flex; justify-content: space-between; gap: 6px; }
    /* النكهة/الملاحظة تحت اسم الصنف داخل نفس الخلية، والفاصل المقطع بين الأصناف فقط */
    .item-note { font-size: ${fs - 1}px; font-style: normal; line-height: 1.25; margin-top: 1px; }
    .item-note.note { color: #333; }
    .size-tag { font-weight: 700; }
    table.items tbody tr td { padding-bottom: 2px; }
    table.items tbody tr + tr td { border-top: 1px dashed #000; padding-top: 3px; }
    .kitchen-item { margin: 5px 0; font-size: ${fs + 2}px; }
    .kitchen-note { font-size: ${fs}px; font-weight: 700; border: 1px solid #000; padding: 1px 3px; margin-top: 2px; }
    .logo-container { text-align: center; margin-bottom: 4px; }
    .logo-container img { max-height: 40px; max-width: 80%; object-fit: contain; filter: grayscale(100%); }
    .barcode-container { text-align: center; margin-top: 5px; }
    .barcode-container svg { max-width: 100%; height: auto; max-height: 42px; }
    .cancelled-stamp { color: #b91c1c; font-weight: 800; text-align: center; font-size: 16px; border: 2px solid #b91c1c; padding: 2px; margin: 5px 0; }
    .muted { color: #333; }
  `;
}

function barcodeSvg(value) {
  if (!value || typeof window.JsBarcode !== 'function') return '';
  try {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    window.JsBarcode(svg, String(value), {
      format: 'CODE128', width: 1.2, height: 30, displayValue: true, fontSize: 10, margin: 0
    });
    return svg.outerHTML;
  } catch {
    return '';
  }
}

function receiptHead(width, title) {
  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">
    <title>${esc(title || 'فاتورة')}</title><style>${receiptStyles(width)}</style></head><body>`;
}

function customerBody(inv) {
  const s = state.settings;
  const cur = currency();
  const cancelled = inv.status === 'cancelled';
  const logo = s.showLogoOnInvoice && s.logoData
    ? `<div class="logo-container"><img src="${esc(s.logoData)}" alt=""></div>` : '';

  let head = `<div class="center bold big">${esc(s.storeName || 'المتجر')}</div>`;
  if (s.showAddressOnInvoice && s.storeAddress) head += `<div class="center">${esc(s.storeAddress)}</div>`;
  if (s.showPhoneOnInvoice && s.storePhone) head += `<div class="center">${esc(s.storePhone)}</div>`;
  if (s.taxNumber) head += `<div class="center">الرقم الضريبي: ${esc(s.taxNumber)}</div>`;
  head += `<div class="center bold" style="border-bottom:1px dashed #000;padding-bottom:3px;margin:3px 0 4px">فاتورة العميل</div>`;

  const items = inv.items.map((it) => {
    const size = it.variantName ? ` (${sizeShort(it.variantName)})` : '';
    const flavors = (it.options || []).map((o) => o.name).filter(Boolean).join(' + ');
    return `
    <tr>
      <td class="c-name">${esc(it.name)}${size ? `<span class="size-tag">${esc(size)}</span>` : ''}${flavors ? `<div class="item-note">${esc(flavors)}</div>` : ''}${it.note ? `<div class="item-note note">✎ ${esc(it.note)}</div>` : ''}</td>
      <td class="c-qty mono">${esc(it.qty)}</td>
      <td class="c-price mono">${moneyShort(it.sellingPrice)}</td>
      <td class="c-total mono">${moneyShort(it.sellingPrice * it.qty)}</td>
    </tr>`;
  }).join('');

  // يشمل خصم نقاط الولاء في الفواتير القديمة (يساوي 0 في الفواتير الجديدة)
  const discountTotal = round2((Number(inv.discount) || 0) + (Number(inv.pointsDiscount) || 0));
  const barcode = s.showBarcodeOnInvoice && inv.serial
    ? `<div class="barcode-container">${barcodeSvg(inv.serial)}</div>` : '';

  return `
    ${logo}${head}
    ${cancelled ? `<div class="cancelled-stamp">ملغية — ${esc(inv.cancelReason || '')}</div>` : ''}
    <div class="hr"></div>
    <div class="row"><span>رقم الفاتورة</span><span class="bold">${esc(inv.serial || '#' + inv.id)}</span></div>
    <div class="row"><span>الكاشير</span><span>${esc(inv.cashier || '')}</span></div>
    <div class="row"><span>التاريخ</span><span>${esc(fmtDateTime(inv.timestamp))}</span></div>
    ${inv.customer && inv.customer.name ? `<div class="row"><span>العميل</span><span>${esc(inv.customer.name)}</span></div>` : ''}
    ${inv.customer && inv.customer.phone ? `<div class="row"><span>الهاتف</span><span>${esc(inv.customer.phone)}</span></div>` : ''}
    <div class="hr"></div>
    <table class="items"><thead><tr><th class="c-name">الصنف</th><th class="c-qty">ك</th><th class="c-price">س</th><th class="c-total">إجمالي</th></tr></thead>
    <tbody>${items}</tbody></table>
    <div class="hr"></div>
    <div class="row"><span>المجموع</span><span class="mono">${money(inv.subtotal)} ${esc(cur)}</span></div>
    ${discountTotal > 0 ? `<div class="row"><span>الخصم</span><span class="mono">-${money(discountTotal)} ${esc(cur)}</span></div>` : ''}
    ${Number(inv.tax) > 0 ? `<div class="row"><span>${esc(s.taxName || 'الضريبة')}</span><span class="mono">${money(inv.tax)} ${esc(cur)}</span></div>` : ''}
    <div class="row bold big"><span>الإجمالي</span><span class="mono">${money(inv.total)} ${esc(cur)}</span></div>
    <div class="row"><span>المدفوع</span><span class="mono">${money(inv.amountPaid)} ${esc(cur)}</span></div>
    ${Number(inv.change) > 0 ? `<div class="row"><span>الباقي</span><span class="mono">${money(inv.change)} ${esc(cur)}</span></div>` : ''}
    <div class="row"><span>طريقة الدفع</span><span>${esc(PAY_LABELS[inv.paymentMethod] || inv.paymentMethod)}</span></div>
    ${inv.bankName ? `<div class="row"><span>البنك/الخدمة</span><span>${esc(inv.bankName)}</span></div>` : ''}
    ${inv.transferInfo ? `<div class="row"><span>تفاصيل التحويل</span><span>${esc(inv.transferInfo)}</span></div>` : ''}
    ${inv.comment ? `<div class="hr"></div><div class="center" style="font-style:italic">ملاحظة: ${esc(inv.comment)}</div>` : ''}
    <div class="hr"></div>
    ${barcode}
    <div class="center" style="margin-top:3px">${esc(s.footerText || 'شكراً لزيارتكم')}</div>
  `;
}

function kitchenBody(inv) {
  const s = state.settings;
  const totalQty = inv.items.reduce((sum, i) => sum + Number(i.qty || 0), 0);
  const barcode = s.showBarcodeOnInvoice && inv.serial
    ? `<div class="barcode-container">${barcodeSvg(inv.serial)}</div>` : '';
  return `
    <div class="center bold big">${esc(s.storeName || 'المتجر')}</div>
    <div class="center bold" style="font-size:13px;border-bottom:1px dashed #000;padding-bottom:3px;margin-bottom:4px">فاتورة المحل / المطبخ</div>
    <div class="row"><span>رقم الفاتورة</span><span class="bold">${esc(inv.serial || '#' + inv.id)}</span></div>
    <div class="row"><span>عدد الأصناف</span><span class="bold mono">${esc(totalQty)}</span></div>
    <div class="row"><span>التاريخ</span><span>${esc(fmtDateTime(inv.timestamp))}</span></div>
    <div class="row"><span>الكاشير</span><span>${esc(inv.cashier || '')}</span></div>
    ${inv.customer && inv.customer.name ? `<div class="row"><span>العميل</span><span>${esc(inv.customer.name)}</span></div>` : ''}
    <div class="hr"></div>
    ${inv.items.map((i) => {
      const size = i.variantName ? ` (${sizeShort(i.variantName)})` : '';
      const flavors = (i.options || []).map((o) => o.name).filter(Boolean).join(' + ');
      const detail = [flavors, i.note].filter(Boolean).join(' — ');
      return `<div class="kitchen-item"><div class="bold">${esc(i.qty)}× ${esc(i.name)}${esc(size)}</div>${detail ? `<div class="item-note">↳ ${esc(detail)}</div>` : ''}</div>`;
    }).join('')}
    <div class="hr"></div>
    ${inv.comment ? `<div class="center bold" style="border:1px solid #000;padding:3px;margin-bottom:3px">📝 ${esc(inv.comment)}</div>` : ''}
    ${barcode}
  `;
}

/* أجزاء الفاتورة: تُستخدم مرة لبناء مستند الطباعة ومرة للمعاينة داخل الظل */
function buildReceiptParts(inv, type = 'customer') {
  const width = paperWidthMm();
  return {
    width,
    css: receiptStyles(width),
    body: type === 'kitchen' ? kitchenBody(inv) : customerBody(inv),
    title: type === 'kitchen' ? 'فاتورة المطبخ' : 'فاتورة العميل'
  };
}

function buildReceiptHtml(inv, type = 'customer') {
  const parts = buildReceiptParts(inv, type);
  return `${receiptHead(parts.width, parts.title)}${parts.body}</body></html>`;
}

/* --------------------------- دورة الطباعة --------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* خيارات الطباعة المحفوظة في الإعدادات (تُرسَل للعملية الرئيسية) */
function printOptions(extra) {
  const s = state.settings;
  return Object.assign({
    printerName: s.printerName || '',
    paperWidth: paperWidthMm(),
    mode: s.printMode || 'auto',
    dpi: Number(s.printerDpi) || 203,
    dots: Number(s.printerDots) || 0,
    feedLines: s.feedLines != null ? s.feedLines : 4,
    cutFeedMm: s.cutFeedMm != null ? Number(s.cutFeedMm) : 20,
    cut: s.cutPaper !== false,
    silent: true
  }, extra || {});
}

async function printInvoice(inv, options = {}) {
  if (!inv) return toast('لا توجد فاتورة للطباعة', 'warn');
  if (state.printing) return toast('عملية طباعة جارية...', 'warn');
  const s = state.settings;
  const jobs = [];
  if (s.printCustomer !== false) {
    jobs.push({
      type: 'customer',
      copies: Math.max(1, Number(s.copiesCustomer) || 1),
      printerName: s.printerName || ''
    });
  }
  if (s.printKitchen !== false) {
    jobs.push({
      type: 'kitchen',
      copies: Math.max(1, Number(s.copiesKitchen) || 1),
      // طابعة المطبخ مستقلة إن اختيرت، وإلا نفس طابعة العميل
      printerName: s.kitchenPrinterName || s.printerName || ''
    });
  }
  if (jobs.length === 0) return toast('لا توجد نسخ مفعّلة في الإعدادات', 'warn');

  // الطباعة دائمًا صامتة عبر البرنامج — لا تُفتح نافذة طلب تأكيد من ويندوز
  state.printing = true;
  let failure = null;
  let fallbackNote = null;
  try {
    for (let i = 0; i < jobs.length; i++) {
      if (i > 0 && Number(s.printDelay) > 0) await sleep(Number(s.printDelay) * 1000);
      const html = buildReceiptHtml(inv, jobs[i].type);
      const res = await api('print:receipt', printOptions({
        html,
        copies: jobs[i].copies,
        printerName: jobs[i].printerName,
        paperWidth: paperWidthMm(),
        jobName: `${jobs[i].type === 'kitchen' ? 'مطبخ' : 'عميل'} ${inv.serial || inv.id}`
      }));
      if (!res || !res.ok) { failure = (res && res.error) || 'فشلت الطباعة'; break; }
      // طابعة حرارية تعذّر مسارها المباشر وطُبعت عبر التعريف: نُخبر المستخدم بالسبب
      if (res.mode === 'driver' && res.fallbackError && res.thermal) fallbackNote = res.fallbackError;
    }
  } catch (err) {
    failure = err.message;
  } finally {
    state.printing = false;
  }

  if (failure) {
    toast('تعذّرت الطباعة: ' + failure, 'error');
    previewInvoice(inv);
  } else if (!options.quiet) {
    if (fallbackNote) toast('طُبعت عبر تعريف ويندوز — تعذّر المسار المباشر: ' + fallbackNote, 'warn');
    else toast('تمت إرسال الفاتورة للطابعة');
  }
}

/*
 * المعاينة تُرسم داخل Shadow DOM وليس داخل iframe/srcdoc:
 *   - لا تعتمد على تحميل مستند ولا على CSP الخاص بالنافذة الأب
 *   - تتجنب تنسيقات التطبيق (Tailwind) تمامًا كما تتجنبها الفاتورة المطبوعة
 *   - تعمل بنفس الشكل على كل إصدارات ويندوز بلا شاشة بيضاء أو انتظار تحميل
 */
function previewInvoice(inv) {
  if (!inv) return;
  state.lastInvoice = inv;
  const sheet = $('previewSheet');
  if (!sheet) return printInvoice(inv, { silent: true });
  const parts = buildReceiptParts(inv, 'customer');
  sheet.style.width = `${parts.width}mm`;
  let root = sheet.shadowRoot;
  if (!root) root = sheet.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${parts.css}.receipt{background:#fff;}</style>` +
    `<div class="receipt" dir="rtl">${parts.body}</div>`;
  openModal('printPreviewModal');
  fitPreviewSheet();
  setTimeout(fitPreviewSheet, 120);
}

/* تصغير الورقة إن كانت أعرض من مساحة المعاينة حتى تُرى كاملة */
function fitPreviewSheet() {
  const sheet = $('previewSheet');
  const scroll = $('previewScroll');
  if (!sheet || !scroll) return;
  sheet.style.zoom = '1';
  const available = Math.max(120, scroll.clientWidth - 24);
  const natural = sheet.getBoundingClientRect().width || available;
  const scale = natural > available ? Math.max(0.45, available / natural) : 1;
  sheet.style.zoom = String(Math.round(scale * 100) / 100);
}

window.addEventListener('resize', () => {
  const modal = $('printPreviewModal');
  if (modal && !modal.classList.contains('hidden')) fitPreviewSheet();
});

async function saveInvoicePdf(inv) {
  if (!inv) return;
  try {
    const res = await api('print:pdf', {
      html: buildReceiptHtml(inv, 'customer'),
      widthMm: paperWidthMm(),
      defaultName: `invoice-${inv.serial || inv.id}`
    });
    if (res && res.ok) toast('تم حفظ PDF');
  } catch (err) { showError(err); }
}

function zReportBody(shift) {
  const s = state.settings;
  const cur = currency();
  return `
    <div class="center bold big">${esc(s.storeName || 'المتجر')}</div>
    <div class="center bold">تقرير إغلاق الوردية (Z-Report)</div>
    <div class="hr"></div>
    <div class="row"><span>الوردية</span><span>#${esc(shift.id)}</span></div>
    <div class="row"><span>الكاشير</span><span>${esc(shift.cashier || '')}</span></div>
    <div class="row"><span>الفتح</span><span>${esc(fmtDateTime(shift.openedAt))}</span></div>
    <div class="row"><span>الإغلاق</span><span>${esc(fmtDateTime(shift.closedAt))}</span></div>
    <div class="hr"></div>
    <div class="row"><span>عهدة افتتاحية</span><span class="mono">${money(shift.openingFloat)}</span></div>
    <div class="row"><span>عدد الفواتير</span><span class="mono">${esc(shift.invoiceCount || 0)}</span></div>
    <div class="row"><span>مبيعات كاش</span><span class="mono">${money(shift.cashSales)}</span></div>
    <div class="row"><span>مبيعات تحويل</span><span class="mono">${money(shift.bankSales)}</span></div>
    <div class="row"><span>مبيعات آجلة</span><span class="mono">${money(shift.creditSales)}</span></div>
    <div class="row bold"><span>إجمالي المبيعات</span><span class="mono">${money(shift.totalSales)} ${esc(cur)}</span></div>
    ${Number(shift.returnsCount) > 0 ? `<div class="row"><span>المرتجعات (${esc(shift.returnsCount)})</span><span class="mono">− ${money(shift.returnsTotal)}</span></div>
    <div class="row"><span>صافي المبيعات</span><span class="mono">${money(shift.netSales)}</span></div>` : ''}
    <div class="row"><span>تكلفة المبيعات</span><span class="mono">${money(shift.totalCost)}</span></div>
    <div class="row"><span>الأرباح</span><span class="mono">${money(shift.totalProfit)}</span></div>
    <div class="hr"></div>
    <div class="row"><span>المصروفات (من الدرج)</span><span class="mono">${money(shift.cashExpenses)}</span></div>
    <div class="row"><span>صافي حركة الخزنة</span><span class="mono">${money(shift.treasuryNet)}</span></div>
    <div class="row"><span>النقدية المتوقعة</span><span class="mono">${money(shift.expectedCash)}</span></div>
    <div class="row bold"><span>النقدية الفعلية</span><span class="mono">${money(shift.closingCash)}</span></div>
    <div class="row bold big"><span>${Number(shift.discrepancy) >= 0 ? 'الزيادة' : 'العجز'}</span>
      <span class="mono">${money(Math.abs(Number(shift.discrepancy) || 0))} ${esc(cur)}</span></div>
    <div class="hr"></div>
    <div class="center">تم إنشاء التقرير: ${esc(fmtDateTime(Date.now()))}</div>
  `;
}

function buildZReportHtml(shift) {
  const width = paperWidthMm();
  return `${receiptHead(width, 'Z-Report')}${zReportBody(shift)}</body></html>`;
}

async function printZReport(shift) {
  try {
    const res = await api('print:receipt', printOptions({
      html: buildZReportHtml(shift),
      copies: 1,
      printerName: state.settings.reportPrinterName || state.settings.printerName || '',
      jobName: 'Z-Report'
    }));
    if (res && res.ok) toast('تمت طباعة تقرير الوردية');
    else toast('تم إغلاق الوردية، لكن تعذّرت طباعة Z: ' + ((res && res.error) || ''), 'warn');
  } catch (err) {
    toast('تم إغلاق الوردية، لكن تعذّرت طباعة Z: ' + err.message, 'warn');
  }
}

/* --------------------------- تقرير PDF (A4) --------------------------- */
function buildInvoicesPdfHtml(invoices, summary, range) {
  const s = state.settings;
  const cur = currency();
  const rows = invoices.map((inv) => `
    <tr>
      <td>${esc(inv.serial)}</td>
      <td>${esc(fmtDate(inv.timestamp))} ${esc(fmtTime(inv.timestamp))}</td>
      <td>${esc(inv.cashier || '')}</td>
      <td>${esc(inv.customer && inv.customer.name ? inv.customer.name : '-')}</td>
      <td class="num">${money(inv.total)}</td>
      <td>${esc(PAY_LABELS[inv.paymentMethod] || '')}</td>
      <td>${inv.status === 'cancelled' ? 'ملغية' : 'مكتملة'}</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">
  <style>
    @page { size: A4; margin: 12mm; }
    body { font-family: 'Cairo', Tahoma, sans-serif; direction: rtl; color: #111; font-size: 11px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .sub { color: #555; font-size: 11px; margin-bottom: 10px; }
    .cards { display: flex; gap: 6px; margin-bottom: 10px; }
    .card { border: 1px solid #ddd; border-radius: 6px; padding: 6px 8px; flex: 1; }
    .card b { display: block; font-size: 13px; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #eee; padding: 4px 3px; text-align: right; }
    th { background: #f1f5f9; font-size: 10.5px; }
    .num { font-variant-numeric: tabular-nums; }
    tfoot td { font-weight: 800; border-top: 2px solid #111; }
  </style></head><body>
    <h1>${esc(s.storeName || 'المتجر')} — تقرير الفواتير</h1>
    <div class="sub">${esc(range)} — ${esc(s.storeAddress || '')} ${esc(s.storePhone || '')}</div>
    <div class="cards">
      <div class="card">إجمالي المبيعات<b>${money(summary.sales)} ${esc(cur)}</b></div>
      <div class="card">عدد الفواتير<b>${esc(summary.count)}</b></div>
      <div class="card">مجمل الربح<b>${money(summary.profit)} ${esc(cur)}</b></div>
      <div class="card">المصروفات<b>${money(summary.expenses)} ${esc(cur)}</b></div>
      <div class="card">صافي الربح<b>${money(summary.netProfit)} ${esc(cur)}</b></div>
    </div>
    <table>
      <thead><tr><th>الفاتورة</th><th>التاريخ</th><th>الكاشير</th><th>العميل</th><th>الإجمالي</th><th>الدفع</th><th>الحالة</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7">لا توجد فواتير في هذه الفترة</td></tr>'}</tbody>
    </table>
    <p style="margin-top:10px;color:#666;font-size:9.5px">تم إنشاء التقرير بواسطة POS Pro — ${esc(fmtDateTime(Date.now()))}</p>
  </body></html>`;
}

async function saveInvoicesPdf(invoices, summary, range) {
  try {
    const res = await api('print:pdf', {
      html: buildInvoicesPdfHtml(invoices, summary, range),
      widthMm: 210,
      heightMm: 297,
      marginMm: 10,
      defaultName: 'invoices-report'
    });
    if (res && res.ok) toast('تم حفظ تقرير PDF');
  } catch (err) { showError(err); }
}
