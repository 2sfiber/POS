'use strict';
/* ============================================================
   الفواتير: العرض، التفاصيل، الطباعة، الإلغاء الآمن، التصدير
   ============================================================ */

/* ------- التحديد والطباعة والتصدير الجماعي ------- */
function selectedInvoiceIds() {
  return Array.from(state.selectedInvoices || []).map(Number);
}

function updateSelectionUi() {
  const ids = selectedInvoiceIds();
  const count = $('invSelectionCount');
  if (count) count.textContent = `${ids.length} محددة`;
  const all = $('invSelectAll');
  if (all) {
    const rows = $$('#invoicesTbody [data-sel]');
    all.checked = rows.length > 0 && ids.length === rows.length;
    all.indeterminate = ids.length > 0 && ids.length < rows.length;
  }
  $$('#invoicesTbody [data-sel]').forEach((box) => {
    box.checked = (state.selectedInvoices || new Set()).has(Number(box.dataset.sel));
  });
}

function toggleInvoiceSelection(id, checked) {
  state.selectedInvoices = state.selectedInvoices || new Set();
  if (checked) state.selectedInvoices.add(Number(id));
  else state.selectedInvoices.delete(Number(id));
  updateSelectionUi();
}

async function batchPrintInvoices(invoices) {
  if (!invoices.length) return toast('لا توجد فواتير للطباعة', 'warn');
  if (!(await askConfirm('طباعة الفواتير', `سيتم إرسال ${invoices.length} فاتورة للطابعة. متابعة؟`))) return;
  let done = 0;
  for (const inv of invoices) {
    await printInvoice(inv, { quiet: true });
    done++;
    if (done % 5 === 0) toast(`جارٍ الطباعة… ${done}/${invoices.length}`, 'warn');
  }
  toast(`تم إرسال ${done} فاتورة للطباعة`);
}

async function exportInvoicesExcelByIds(ids) {
  try {
    const res = await api('export:excel', { kind: 'invoices', ids });
    if (res && res.ok) toast('تم حفظ ملف Excel');
  } catch (err) { showError(err); }
}

async function exportInvoicesPdfList(invoices) {
  if (!invoices.length) return toast('لا توجد فواتير للتصدير', 'warn');
  const timestamps = invoices.map((i) => i.timestamp);
  const from = new Date(Math.min(...timestamps)).setHours(0, 0, 0, 0);
  const to = new Date(Math.max(...timestamps)).setHours(23, 59, 59, 999);
  try {
    const summary = await api('reports:summary', { from, to });
    await saveInvoicesPdf(invoices, summary, `${fmtDate(from)} — ${fmtDate(to)}`);
  } catch (err) { showError(err); }
}

async function renderInvoices() {
  const scope = $('invScope') ? $('invScope').value : 'shift';
  const filter = {
    search: ($('invSearch') && $('invSearch').value.trim()) || '',
    paymentMethod: ($('invPayFilter') && $('invPayFilter').value) || '',
    limit: 1000
  };
  if (scope === 'shift') {
    if (!state.shift) {
      $('invoicesTbody').innerHTML = '<tr><td colspan="9" class="text-center text-slate-400 py-6">لا توجد وردية مفتوحة</td></tr>';
      state.invoicesData = [];
      updateSelectionUi();
      return;
    }
    filter.shiftId = state.shift.id;
  }
  try {
    const invoices = await api('invoices:list', filter);
    state.invoicesData = invoices;
    state.selectedInvoices = new Set();
    $('invoicesTbody').innerHTML = invoices.length === 0
      ? '<tr><td colspan="9" class="text-center text-slate-400 py-6">لا توجد فواتير</td></tr>'
      : invoices.map((inv) => {
        const cancelled = inv.status === 'cancelled';
        return `
          <tr class="border-b hover:bg-slate-50 ${cancelled ? 'bg-red-50 opacity-75' : ''}">
            <td class="p-2 text-center"><input type="checkbox" data-sel="${inv.id}" class="w-4 h-4 accent-emerald-600"></td>
            <td class="p-3 font-bold text-xs font-mono ${cancelled ? 'line-through text-red-700' : ''}">${esc(inv.serial)}</td>
            <td class="p-3 text-slate-500 font-mono text-xs">${esc(fmtDate(inv.timestamp))} ${esc(fmtTime(inv.timestamp))}</td>
            <td class="p-3 text-slate-500 text-xs">${esc(inv.cashier || '')}</td>
            <td class="p-3 text-xs">${esc(inv.customer.name || '-')}</td>
            <td class="p-3 font-bold font-mono ${cancelled ? 'line-through text-red-700' : ''}">${money(inv.total)}</td>
            <td class="p-3 text-xs">${esc(PAY_LABELS[inv.paymentMethod] || '')}
              ${inv.bankName ? `<br><span class="text-[10px] text-slate-500 font-bold">${esc(inv.bankName)}</span>` : ''}
              ${inv.transferInfo ? `<br><span class="text-[10px] text-slate-400 font-mono">${esc(inv.transferInfo)}</span>` : ''}
              ${inv.comment ? `<br><span class="text-[10px] text-indigo-500" title="${esc(inv.comment)}">📝 ${esc(String(inv.comment).slice(0, 18))}${String(inv.comment).length > 18 ? '…' : ''}</span>` : ''}</td>
            <td class="p-3 text-xs">${cancelled
              ? `<span class="text-red-600 font-bold bg-red-100 px-2 py-1 rounded">ملغية</span>`
              : '<span class="text-emerald-600 font-bold bg-emerald-100 px-2 py-1 rounded">مكتملة</span>'}</td>
            <td class="p-3">
              <button data-inv="${inv.id}" class="bg-slate-200 hover:bg-slate-300 text-slate-700 px-3 py-1.5 rounded-lg font-bold text-xs">الإجراءات</button>
            </td>
          </tr>`;
      }).join('');
    updateSelectionUi();
  } catch (err) { showError(err); }
}

async function openInvoiceAction(id) {
  try {
    const inv = await api('invoices:get', { id: Number(id) });
    if (!inv) return toast('الفاتورة غير موجودة', 'error');
    state.selectedInvoice = inv;
    state.selectedInvoiceId = inv.id;
    // يشمل خصم نقاط الولاء في الفواتير القديمة (يساوي 0 في الفواتير الجديدة)
    const discountTotal = round2((Number(inv.discount) || 0) + (Number(inv.pointsDiscount) || 0));

    $('invoiceActionDetails').innerHTML = `
      <div class="bg-white border rounded p-2 mb-2 text-xs space-y-1">
        <div class="flex justify-between font-bold text-slate-800"><span>فاتورة: ${esc(inv.serial)}</span><span>${esc(fmtDateTime(inv.timestamp))}</span></div>
        <div class="text-slate-500">العميل: ${esc(inv.customer.name || 'غير محدد')} | الكاشير: ${esc(inv.cashier || '')}</div>
        ${inv.customer.phone ? `<div class="text-slate-500">الهاتف: ${esc(inv.customer.phone)}</div>` : ''}
        ${inv.comment ? `<div class="text-indigo-600 bg-indigo-50 p-1 rounded">ملاحظة: ${esc(inv.comment)}</div>` : ''}
        ${inv.status === 'cancelled' ? `<div class="text-red-700 bg-red-50 p-1 rounded font-bold">ملغية: ${esc(inv.cancelReason)} — بواسطة ${esc(inv.cancelledBy)}</div>` : ''}
      </div>
      <table class="w-full text-xs text-right mb-2 table-fixed">
        <thead><tr class="border-b border-slate-300"><th class="pb-1">الصنف</th><th class="pb-1 w-12 text-center">ك</th><th class="pb-1 w-20 text-center">س</th><th class="pb-1 w-20 text-center">إجمالي</th></tr></thead>
        <tbody>${inv.items.map((i) => {
          const flavors = (i.options || []).map((o) => o.name).join(' + ');
          const detail = [flavors, i.note].filter(Boolean).join(' — ');
          return `<tr class="border-b border-slate-100"><td class="py-1">${esc(i.name)}${i.variantName ? `<span class="text-[10px] font-bold text-emerald-700"> (${esc(i.variantName)})</span>` : ''}${detail ? `<div class="text-[10px] text-slate-400">${esc(detail)}</div>` : ''}</td>
          <td class="font-mono text-center">${esc(i.qty)}</td><td class="font-mono text-center">${money(i.sellingPrice)}</td><td class="font-mono text-center">${money(i.sellingPrice * i.qty)}</td></tr>`;
        }).join('')}</tbody>
      </table>
      <div class="bg-slate-100 p-2 rounded text-xs space-y-1 font-bold">
        <div class="flex justify-between"><span>المجموع:</span><span class="font-mono">${money(inv.subtotal)}</span></div>
        ${discountTotal > 0 ? `<div class="flex justify-between text-red-600"><span>الخصم:</span><span class="font-mono">-${money(discountTotal)}</span></div>` : ''}
        ${inv.tax > 0 ? `<div class="flex justify-between"><span>${esc(state.settings.taxName || 'الضريبة')}:</span><span class="font-mono">${money(inv.tax)}</span></div>` : ''}
        <div class="flex justify-between text-emerald-700 text-sm border-t border-slate-300 pt-1"><span>الإجمالي:</span><span class="font-mono">${moneyCur(inv.total)}</span></div>
        <div class="flex justify-between text-[11px] text-slate-500"><span>الدفع:</span><span>${esc(PAY_LABELS[inv.paymentMethod] || '')}</span></div>
        ${inv.bankName ? `<div class="flex justify-between text-[11px] text-blue-700"><span>البنك / الخدمة:</span><span class="font-bold">${esc(inv.bankName)}</span></div>` : ''}
        ${inv.transferInfo ? `<div class="flex justify-between text-[11px] text-blue-700"><span>رقم العملية:</span><span class="font-mono font-bold">${esc(inv.transferInfo)}</span></div>` : ''}
        ${inv.comment ? `<div class="bg-indigo-50 border border-indigo-200 rounded p-1.5 text-[11px] text-indigo-700"><b>ملاحظة الفاتورة:</b> ${esc(inv.comment)}</div>` : ''}
        ${Number(inv.pointsEarned) > 0 ? `<div class="flex justify-between text-[11px] text-slate-400"><span>نقاط ولاء (نظام مُلغي)</span><span>${esc(inv.pointsEarned)}</span></div>` : ''}
      </div>`;

    $('actionCancelBtn').classList.toggle('hidden', !hasPerm('cancel_invoice') || inv.status === 'cancelled');
    openModal('invoiceActionModal');
  } catch (err) { showError(err); }
}

function openCancelInvoiceModal() {
  if (!hasPerm('cancel_invoice')) return toast('لا تملك صلاحية إلغاء الفواتير', 'error');
  closeModal('invoiceActionModal');
  $('cancelPassword').value = '';
  $('cancelReasonSelect').value = 'خطأ في الطباعة';
  openModal('cancelInvoiceModal');
}

async function confirmCancelInvoice() {
  const id = state.selectedInvoiceId;
  if (!id) return;
  const reason = $('cancelReasonSelect').value;
  const password = $('cancelPassword').value;
  if (!password) return toast('أدخل كلمة المرور للتأكيد', 'warn');
  if (!(await askConfirm('تأكيد الإلغاء', 'سيتم إلغاء الفاتورة وإرجاع المخزون وعكس النقد. هذا الإجراء نهائي.', 'danger'))) return;
  try {
    await api('invoices:cancel', { id, reason, adminPassword: password });
    closeModal('cancelInvoiceModal');
    await reloadProducts();
    renderCart();
    await renderInvoices();
    toast('تم إلغاء الفاتورة');
  } catch (err) { showError(err); }
}

async function exportInvoicesExcel() {
  try {
    const res = await api('export:excel', { kind: 'invoices', from: 0, to: Date.now() });
    if (res && res.ok) toast('تم حفظ ملف Excel');
  } catch (err) { showError(err); }
}

async function exportInvoicesPdf() {
  const invoices = state.invoicesData || [];
  if (!invoices.length) return toast('لا توجد فواتير للتصدير', 'warn');
  const timestamps = invoices.map((i) => i.timestamp);
  const from = new Date(Math.min(...timestamps)).setHours(0, 0, 0, 0);
  const to = new Date(Math.max(...timestamps)).setHours(23, 59, 59, 999);
  try {
    const summary = await api('reports:summary', { from, to });
    await saveInvoicesPdf(invoices, summary, `${fmtDate(from)} — ${fmtDate(to)}`);
  } catch (err) { showError(err); }
}

function bindInvoiceEvents() {
  bind('invoicesTbody', 'click', (e) => {
    const box = e.target.closest('[data-sel]');
    if (box) return toggleInvoiceSelection(box.dataset.sel, box.checked);
    const btn = e.target.closest('[data-inv]');
    if (btn) openInvoiceAction(btn.dataset.inv);
  });
  bind('invoicesTbody', 'change', (e) => {
    const box = e.target.closest('[data-sel]');
    if (box) toggleInvoiceSelection(box.dataset.sel, box.checked);
  });
  bind('invSelectAll', 'change', () => {
    const all = $('invSelectAll').checked;
    state.selectedInvoices = new Set();
    if (all) (state.invoicesData || []).forEach((inv) => state.selectedInvoices.add(Number(inv.id)));
    updateSelectionUi();
  });
  bind('invPrintSelectedBtn', 'click', () => {
    const ids = selectedInvoiceIds();
    const list = (state.invoicesData || []).filter((inv) => ids.includes(Number(inv.id)));
    if (!list.length) return toast('حدّد فواتير أولًا (أو اضغط تحديد الكل)', 'warn');
    batchPrintInvoices(list);
  });
  bind('invPrintAllBtn', 'click', () => batchPrintInvoices(state.invoicesData || []));
  bind('invPdfSelectedBtn', 'click', () => {
    const ids = selectedInvoiceIds();
    const list = ids.length
      ? (state.invoicesData || []).filter((inv) => ids.includes(Number(inv.id)))
      : (state.invoicesData || []);
    if (!list.length) return toast('لا توجد فواتير للتصدير', 'warn');
    exportInvoicesPdfList(list);
  });
  bind('invExcelSelectedBtn', 'click', () => {
    const ids = selectedInvoiceIds();
    exportInvoicesExcelByIds(ids.length ? ids : null);
  });
  bind('invRefreshBtn', 'click', renderInvoices);
  bind('invSearch', 'keydown', (e) => { if (e.key === 'Enter') renderInvoices(); });
  bind('invScope', 'change', renderInvoices);
  bind('invPayFilter', 'change', renderInvoices);
  bind('invoicesExcelBtn', 'click', exportInvoicesExcel);
  bind('invoicesPdfBtn', 'click', exportInvoicesPdf);

  bind('closeInvoiceActionBtn', 'click', () => closeModal('invoiceActionModal'));
  bind('actionCloseModalBtn', 'click', () => closeModal('invoiceActionModal'));
  bind('actionPrintBtn', 'click', () => {
    closeModal('invoiceActionModal');
    if (state.selectedInvoice) {
      if (state.settings.previewBeforePrint) previewInvoice(state.selectedInvoice);
      else printInvoice(state.selectedInvoice, { silent: true });
    }
  });
  bind('actionPdfBtn', 'click', () => {
    if (state.selectedInvoice) saveInvoicePdf(state.selectedInvoice);
  });
  bind('actionCancelBtn', 'click', openCancelInvoiceModal);
  bind('closeCancelInvoiceModal', 'click', () => closeModal('cancelInvoiceModal'));
  bind('confirmCancelInvoiceBtn', 'click', confirmCancelInvoice);
}
