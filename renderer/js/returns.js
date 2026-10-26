'use strict';
/* ============================================================
   المرتجعات: بحث بالفاتورة/الباركود، إرجاع جزئي، قيود عكسية، تقارير
   ============================================================ */

const RETURN_REASONS = [
  'تالف / غير صالح',
  'خطأ في الطلب',
  'انتهاء الصلاحية',
  'لم يعجب العميل',
  'اختلاف السعر',
  'أخرى'
];

const RETURN_METHOD_LABELS = {
  cash: 'نقدي من الخزنة',
  credit: 'خصم من الآجل',
  none: 'بدون استرداد'
};

const returnState = { invoice: null, factor: 1 };

function returnsFilters() {
  return dayRange($('returnsDateFrom').value, $('returnsDateTo').value);
}

async function renderReturnsView() {
  const today = todayStr();
  if ($('returnsDateFrom') && !$('returnsDateFrom').value) $('returnsDateFrom').value = today;
  if ($('returnsDateTo') && !$('returnsDateTo').value) $('returnsDateTo').value = today;
  await loadReturnsHistory();
}

async function loadReturnsHistory() {
  const { from, to } = returnsFilters();
  try {
    const [list, summary] = await Promise.all([
      api('returns:list', { from, to, limit: 1000 }),
      api('returns:summary', { from, to })
    ]);
    $('returnsKpis').innerHTML = [
      { label: 'عدد المرتجعات', value: String(summary.count), cls: 'bg-slate-700' },
      { label: 'إجمالي المسترد', value: moneyCur(summary.total), cls: 'bg-red-600' },
      { label: 'تكلفة البضاعة', value: moneyCur(summary.cost), cls: 'bg-amber-600' },
      { label: 'عكس الربح', value: moneyCur(summary.profitReversal), cls: 'bg-indigo-600' }
    ].map((card) => `
      <div class="${card.cls} text-white rounded-xl p-3 shadow">
        <div class="text-[10px] opacity-85">${esc(card.label)}</div>
        <div class="text-sm md:text-base font-extrabold font-mono mt-0.5">${esc(card.value)}</div>
      </div>`).join('');

    $('returnsTbody').innerHTML = list.length
      ? list.map((r) => {
        const items = r.items.map((it) => `${it.name}${it.variantName ? ' (' + it.variantName + ')' : ''} ×${it.qty}`).join(' • ');
        return `<tr class="border-b hover:bg-slate-50">
          <td class="p-1.5 font-mono font-bold">${esc(r.serial)}</td>
          <td class="p-1.5 font-mono text-slate-600">${esc(r.invoiceSerial || '-')}</td>
          <td class="p-1.5 text-[11px] text-slate-500">${esc(fmtDateTime(r.timestamp))}</td>
          <td class="p-1.5">${esc(r.cashier || '-')}</td>
          <td class="p-1.5 text-[11px] text-right whitespace-normal">${esc(items)}</td>
          <td class="p-1.5 font-mono font-bold text-red-600">${money(r.total)}</td>
          <td class="p-1.5 text-[10px]">${esc(RETURN_METHOD_LABELS[r.refundMethod] || r.refundMethod)}</td>
        </tr>`;
      }).join('')
      : '<tr><td colspan="7" class="text-center text-slate-400 py-6">لا توجد مرتجعات في هذه الفترة</td></tr>';
  } catch (err) { showError(err); }
}

function returnReasonOptions(selected) {
  return ['<option value="">— اختر —</option>'].concat(
    RETURN_REASONS.map((reason) => `<option value="${esc(reason)}"${reason === selected ? ' selected' : ''}>${esc(reason)}</option>`)
  ).join('');
}

function renderReturnInvoice(data) {
  const invoice = data.invoice;
  returnState.invoice = invoice;
  returnState.factor = invoice.subtotal > 0 ? invoice.total / invoice.subtotal : 1;
  const panel = $('returnInvoicePanel');
  if (!invoice) {
    panel.classList.add('hidden');
    return;
  }
  $('returnInvoiceHead').innerHTML = `
    <div><b>فاتورة:</b> <span class="font-mono">${esc(invoice.serial)}</span> — ${esc(fmtDateTime(invoice.timestamp))}</div>
    <div><b>الكاشير:</b> ${esc(invoice.cashier || '-')} — <b>العميل:</b> ${esc(invoice.customer.name || 'عميل نقدي')}
      ${invoice.customer.phone ? `— <span class="font-mono">${esc(invoice.customer.phone)}</span>` : ''}</div>
    <div><b>الدفع:</b> ${esc(PAY_LABELS[invoice.paymentMethod] || invoice.paymentMethod)}${invoice.status === 'cancelled' ? ' — <b class="text-red-600">ملغاة</b>' : ''}</div>`;
  $('returnInvoiceTotals').innerHTML = `
    <div>إجمالي الفاتورة: <b>${money(invoice.total)} ${esc(currency())}</b></div>
    <div>${data.previous.length ? `مرتجعات سابقة: <b>${data.previous.length}</b>` : 'لا توجد مرتجعات سابقة'}</div>`;

  $('returnItemsTbody').innerHTML = invoice.items.map((it) => {
    const available = Number(it.returnableQty) || 0;
    const flavors = (it.options || []).map((o) => o.name).filter(Boolean).join(' + ');
    const label = `${esc(it.name)}${it.variantName ? ` <span class="text-[10px] bg-slate-100 px-1 rounded">${esc(it.variantName)}</span>` : ''}${flavors ? `<div class="text-[10px] text-amber-700 font-normal">${esc(flavors)}</div>` : ''}`;
    return `<tr class="border-b ${available <= 0 ? 'opacity-50' : ''}" data-rrow="${it.id}">
      <td class="p-1.5"><input type="checkbox" data-ritem="${it.id}" ${available > 0 ? '' : 'disabled'} class="w-4 h-4 accent-emerald-600"></td>
      <td class="p-1.5 text-right font-bold">${label}</td>
      <td class="p-1.5 font-mono">${esc(it.qty)}</td>
      <td class="p-1.5 font-mono text-slate-500">${esc(it.returnedQty || 0)}</td>
      <td class="p-1.5 font-mono font-bold text-emerald-700">${esc(available)}</td>
      <td class="p-1.5"><input type="number" data-rqty="${it.id}" min="0" max="${available}" step="0.001" value="0"
        ${available > 0 ? '' : 'disabled'} class="w-20 border-2 border-slate-200 rounded px-1 py-0.5 text-center font-mono text-xs"></td>
      <td class="p-1.5 font-mono">${moneyShort(it.sellingPrice)}</td>
      <td class="p-1.5"><select data-rreason="${it.id}" ${available > 0 ? '' : 'disabled'}
        class="w-36 border border-slate-300 rounded px-1 py-0.5 text-[11px] bg-white">${returnReasonOptions('')}</select></td>
    </tr>`;
  }).join('');

  $('returnRefundMethod').value = invoice.paymentMethod === 'credit' ? 'credit' : 'cash';
  $('returnReason').value = '';
  $('returnNote').value = '';
  updateReturnTotal();
  panel.classList.remove('hidden');
  if (typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updateReturnTotal() {
  const invoice = returnState.invoice;
  if (!invoice) return;
  let total = 0;
  invoice.items.forEach((it) => {
    const row = document.querySelector(`[data-rrow="${it.id}"]`);
    if (!row) return;
    const check = row.querySelector(`[data-ritem="${it.id}"]`);
    const qty = Number(row.querySelector(`[data-rqty="${it.id}"]`).value) || 0;
    if (!check || !check.checked || qty <= 0) return;
    total += qty * Number(it.sellingPrice) * returnState.factor;
  });
  $('returnRefundTotal').textContent = money(total);
}

async function searchReturnInvoice() {
  const term = $('returnsSearchInput').value.trim();
  const hint = $('returnsSearchHint');
  if (!term) return toast('أدخل رقم الفاتورة أو الباركود', 'warn');
  try {
    const data = await api('returns:find', { term });
    if (!data || !data.invoice) {
      returnState.invoice = null;
      $('returnInvoicePanel').classList.add('hidden');
      hint.textContent = 'لا توجد فاتورة مكتملة مطابقة لهذا الرقم أو الباركود.';
      hint.classList.remove('hidden');
      return;
    }
    hint.classList.add('hidden');
    renderReturnInvoice(data);
    const open = data.invoice.items.filter((it) => it.returnableQty > 0).length;
    toast(open ? `الفاتورة ${data.invoice.serial} — ${open} صنف قابل للإرجاع` : 'كل أصناف هذه الفاتورة مرتجعة مسبقًا', open ? 'success' : 'warn');
  } catch (err) { showError(err); }
}

function clearReturnPanel() {
  returnState.invoice = null;
  returnState.factor = 1;
  $('returnInvoicePanel').classList.add('hidden');
  $('returnItemsTbody').innerHTML = '';
  $('returnsSearchHint').classList.add('hidden');
}

async function submitReturn() {
  const invoice = returnState.invoice;
  if (!invoice) return toast('ابحث عن فاتورة أولًا', 'warn');
  const items = [];
  invoice.items.forEach((it) => {
    const row = document.querySelector(`[data-rrow="${it.id}"]`);
    if (!row) return;
    const check = row.querySelector(`[data-ritem="${it.id}"]`);
    const qty = Number(row.querySelector(`[data-rqty="${it.id}"]`).value) || 0;
    if (!check || !check.checked || qty <= 0) return;
    if (qty > Number(it.returnableQty) + 1e-6) {
      throw new Error(`الكمية المرتجعة أكبر من المتاح للصنف «${it.name}»`);
    }
    items.push({
      invoiceItemId: it.id,
      qty,
      reason: row.querySelector(`[data-rreason="${it.id}"]`).value || $('returnReason').value.trim()
    });
  });
  if (!items.length) return toast('حدّد صنفًا واحدًا على الأقل وأدخل الكمية', 'warn');
  const method = $('returnRefundMethod').value;
  const total = $('returnRefundTotal').textContent;
  const ok = await askConfirm('تأكيد الإرجاع',
    `سيُسجَّل مرتجع بمبلغ ${total} ${currency()} على الفاتورة ${invoice.serial}،\n` +
    `الطريقة: ${RETURN_METHOD_LABELS[method] || method}.\n` +
    'سيُعاد المخزون (الأصناف والخامات) ويُسجَّل القيد العكسي تلقائيًا.', 'warn',
    { ok: 'تأكيد الإرجاع', cancel: 'تراجع' });
  if (!ok) return;
  try {
    const res = await api('returns:create', {
      invoiceId: invoice.id,
      items,
      refundMethod: method,
      reason: $('returnReason').value.trim(),
      note: $('returnNote').value.trim()
    });
    toast(`تم تسجيل المرتجع ${res.serial}`);
    clearReturnPanel();
    $('returnsSearchInput').value = '';
    await loadReturnsHistory();
  } catch (err) { showError(err); }
}

/* ------------------------------ التصدير ------------------------------ */
function buildReturnsPdfHtml(list, summary, filters) {
  const s = state.settings;
  const cur = currency();
  const rows = list.map((r) => `<tr>
      <td>${esc(r.serial)}</td><td>${esc(r.invoiceSerial || '-')}</td>
      <td>${esc(fmtDateTime(r.timestamp))}</td><td>${esc(r.cashier || '')}</td>
      <td>${esc(r.items.map((it) => `${it.name}×${it.qty}`).join(' • '))}</td>
      <td class="num">${money(r.total)}</td>
      <td>${esc(RETURN_METHOD_LABELS[r.refundMethod] || r.refundMethod)}</td>
    </tr>`).join('');
  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">
  <style>
    @page { size: A4; margin: 12mm; }
    body { font-family: 'Cairo', Tahoma, sans-serif; direction: rtl; color: #111; font-size: 10.5px; margin: 0; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    h2 { font-size: 12px; margin: 12px 0 4px; color: #065f46; border-bottom: 2px solid #d1fae5; padding-bottom: 2px; }
    .sub { color: #555; margin-bottom: 8px; }
    .cards { display: flex; gap: 6px; margin-bottom: 8px; }
    .card { border: 1px solid #ddd; border-radius: 6px; padding: 6px 8px; flex: 1; }
    .card b { display: block; font-size: 12px; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #eee; padding: 3px; text-align: right; }
    th { background: #f1f5f9; font-size: 9.5px; }
    .num { font-variant-numeric: tabular-nums; }
  </style></head><body>
    <h1>${esc(s.storeName || 'المتجر')} — تقرير المرتجعات</h1>
    <div class="sub">${esc(filters.fromStr)} ← ${esc(filters.toStr)} — ${esc(fmtDateTime(Date.now()))}</div>
    <div class="cards">
      <div class="card">عدد المرتجعات<b>${esc(summary.count)}</b></div>
      <div class="card">إجمالي المسترد<b>${money(summary.total)} ${esc(cur)}</b></div>
      <div class="card">تكلفة البضاعة<b>${money(summary.cost)} ${esc(cur)}</b></div>
      <div class="card">عكس الربح<b>${money(summary.profitReversal)} ${esc(cur)}</b></div>
    </div>
    <h2>المرتجعات</h2>
    <table><thead><tr><th>المرتجع</th><th>الفاتورة</th><th>التاريخ</th><th>الكاشير</th>
      <th>الأصناف</th><th>الصافي (${esc(cur)})</th><th>الاسترداد</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7">لا توجد مرتجعات</td></tr>'}</tbody></table>
    <p style="margin-top:10px;color:#666;font-size:9px">POS Pro — تقرير آلي</p>
  </body></html>`;
}

async function exportReturnsCsv() {
  try {
    const { from, to } = returnsFilters();
    const res = await api('export:csv', { kind: 'returns', from, to });
    if (res && res.ok) toast('تم حفظ ملف CSV');
  } catch (err) { showError(err); }
}

async function exportReturnsExcel() {
  try {
    const { from, to } = returnsFilters();
    const res = await api('export:excel', { kind: 'returns', from, to });
    if (res && res.ok) toast('تم حفظ ملف Excel');
  } catch (err) { showError(err); }
}

async function exportReturnsPdf() {
  try {
    const { from, to } = returnsFilters();
    const [list, summary] = await Promise.all([
      api('returns:list', { from, to, limit: 3000 }),
      api('returns:summary', { from, to })
    ]);
    const res = await api('print:pdf', {
      html: buildReturnsPdfHtml(list, summary, {
        fromStr: $('returnsDateFrom').value, toStr: $('returnsDateTo').value
      }),
      widthMm: 210, heightMm: 297, marginMm: 10,
      defaultName: 'returns-report'
    });
    if (res && res.ok) toast('تم حفظ تقرير المرتجعات PDF');
  } catch (err) { showError(err); }
}

function bindReturnEvents() {
  bind('returnsSearchBtn', 'click', searchReturnInvoice);
  bind('returnsSearchInput', 'keydown', (e) => { if (e.key === 'Enter') searchReturnInvoice(); });
  bind('returnsClearBtn', 'click', clearReturnPanel);
  bind('returnCancelBtn', 'click', clearReturnPanel);
  bind('returnsSubmitBtn', 'click', () => { submitReturn().catch(showError); });
  bind('returnsRefreshBtn', 'click', loadReturnsHistory);
  bind('returnsCsvBtn', 'click', exportReturnsCsv);
  bind('returnsExcelBtn', 'click', exportReturnsExcel);
  bind('returnsPdfBtn', 'click', exportReturnsPdf);

  bind('returnItemsTbody', 'change', (e) => {
    const checkId = e.target.dataset.ritem;
    if (checkId) {
      const row = e.target.closest('[data-rrow]');
      const qtyInput = row && row.querySelector(`[data-rqty="${checkId}"]`);
      if (e.target.checked && qtyInput && !(Number(qtyInput.value) > 0)) {
        qtyInput.value = qtyInput.max || '0';
      }
      updateReturnTotal();
      return;
    }
    if (e.target.dataset.rqty) {
      const row = e.target.closest('[data-rrow]');
      const check = row && row.querySelector(`[data-ritem="${e.target.dataset.rqty}"]`);
      if (check) check.checked = Number(e.target.value) > 0;
      updateReturnTotal();
    }
  });
  bind('returnItemsTbody', 'input', (e) => {
    if (e.target.dataset.rqty) updateReturnTotal();
  });
  bind('returnRefundMethod', 'change', updateReturnTotal);
}
