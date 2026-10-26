'use strict';
/* ============================================================
   الخزنة: المصروفات، حركة النقد، دفتر النقدية، الذمم الآجلة
   ============================================================ */

const LEDGER_LABELS = {
  opening: 'عهدة افتتاحية',
  sale_cash: 'بيع نقدي',
  refund_cash: 'مرتجع نقدي',
  expense: 'مصروف',
  expense_reversal: 'إلغاء مصروف',
  treasury_in: 'إيداع',
  treasury_out: 'سحب',
  receivable_payment: 'تحصيل آجل'
};

async function renderTreasury() {
  try {
    const [summary, expenses, movements, receivables] = await Promise.all([
      api('treasury:summary', {}),
      api('expenses:list', {}),
      api('treasury:list', {}),
      api('receivables:list', {})
    ]);

    $('treasuryBalanceVal').textContent = moneyCur(summary.balance);
    $('totalExpensesVal').textContent = moneyCur(summary.expenses);
    $('receivablesVal').textContent = moneyCur(summary.receivablesOpen);
    $('treasuryNetVal').textContent = moneyCur(summary.treasuryNet);

    $('expensesTbody').innerHTML = expenses.length
      ? expenses.map((e) => `
        <tr class="border-b hover:bg-slate-50">
          <td class="p-1.5 text-[11px] text-slate-500">${esc(fmtDate(e.timestamp))}</td>
          <td class="p-1.5 font-bold">${esc(e.description)}</td>
          <td class="p-1.5 font-mono text-red-600 font-bold">${money(e.amount)}</td>
          <td class="p-1.5 text-[11px] text-slate-500">${esc(e.cashier || '')}</td>
          <td class="p-1.5"><button data-delexp="${e.id}" class="text-red-500 hover:text-red-700 font-bold" data-perm="treasury">حذف</button></td>
        </tr>`).join('')
      : '<tr><td colspan="5" class="text-center text-slate-400 py-6">لا توجد مصروفات</td></tr>';

    $('treasuryLogTbody').innerHTML = movements.length
      ? movements.map((t) => `
        <tr class="border-b hover:bg-slate-50">
          <td class="p-1.5 text-[11px] text-slate-500">${esc(fmtDate(t.timestamp))}</td>
          <td class="p-1.5 font-bold ${t.type === 'in' ? 'text-emerald-600' : 'text-amber-600'}">${t.type === 'in' ? 'إيداع' : 'سحب'}</td>
          <td class="p-1.5 font-mono font-bold">${money(t.amount)}</td>
          <td class="p-1.5 text-[11px]">${esc(t.reason)}</td>
          <td class="p-1.5 text-[11px] text-slate-500">${esc(t.cashier || '')}</td>
        </tr>`).join('')
      : '<tr><td colspan="5" class="text-center text-slate-400 py-6">لا توجد حركات</td></tr>';

    $('receivablesTbody').innerHTML = receivables.length
      ? receivables.map((r) => `
        <tr class="border-b hover:bg-slate-50 ${r.status !== 'open' ? 'opacity-60' : ''}">
          <td class="p-1.5 font-mono font-bold">${esc(r.serial)}</td>
          <td class="p-1.5">${esc(r.customerName || '-')}</td>
          <td class="p-1.5 font-mono text-[11px]">${esc(r.customerPhone || '-')}</td>
          <td class="p-1.5 font-mono">${money(r.amount)}</td>
          <td class="p-1.5 font-mono text-emerald-700">${money(r.paid)}</td>
          <td class="p-1.5 font-mono font-bold ${r.status === 'open' ? 'text-red-600' : 'text-slate-400'}">${money(r.remaining)}</td>
          <td class="p-1.5">${r.status === 'open'
            ? `<button data-settle="${r.id}" data-remaining="${r.remaining}" class="bg-emerald-600 text-white px-2 py-1 rounded text-[10px] font-bold">تحصيل</button>`
            : `<span class="text-[10px] font-bold text-slate-500">${r.status === 'paid' ? 'محصّلة' : 'ملغاة'}</span>`}</td>
        </tr>`).join('')
      : '<tr><td colspan="7" class="text-center text-slate-400 py-6">لا توجد ذمم آجلة</td></tr>';

    $('ledgerTbody').innerHTML = summary.ledger.length
      ? summary.ledger.map((l) => `
        <tr class="border-b">
          <td class="p-1.5 text-[11px] text-slate-500">${esc(fmtDateTime(l.timestamp))}</td>
          <td class="p-1.5 text-[11px]">${esc(LEDGER_LABELS[l.type] || l.type)}</td>
          <td class="p-1.5 font-mono font-bold ${l.amount < 0 ? 'text-red-600' : 'text-emerald-700'}">${money(l.amount)}</td>
          <td class="p-1.5 text-[11px] text-slate-500">${esc(l.note || '')}</td>
        </tr>`).join('')
      : '<tr><td colspan="4" class="text-center text-slate-400 py-4">لا توجد حركات نقدية</td></tr>';

    $$('.perm-staff').forEach((el) => el.classList.toggle('hidden', !hasPerm('treasury')));
    applyPermissions();
  } catch (err) { showError(err); }
}

async function saveExpense() {
  const description = $('expDesc').value.trim();
  const amount = Number($('expAmount').value) || 0;
  if (!description) return toast('أدخل بيان المصروف', 'warn');
  if (amount <= 0) return toast('أدخل مبلغًا صحيحًا', 'warn');
  try {
    await api('expenses:add', { description, amount });
    closeModal('expenseModal');
    $('expDesc').value = '';
    $('expAmount').value = '';
    await renderTreasury();
    toast('تم تسجيل المصروف');
  } catch (err) { showError(err); }
}

async function saveTreasury() {
  const type = $('trType').value;
  const amount = Number($('trAmount').value) || 0;
  const reason = $('trReason').value.trim();
  if (amount <= 0) return toast('أدخل مبلغًا صحيحًا', 'warn');
  if (!reason) return toast('أدخل سبب الحركة', 'warn');
  try {
    await api('treasury:add', { type, amount, reason });
    closeModal('treasuryModal');
    $('trAmount').value = '';
    $('trReason').value = '';
    await renderTreasury();
    toast('تم تسجيل حركة الخزنة');
  } catch (err) { showError(err); }
}

async function deleteExpense(id) {
  if (!(await askConfirm('حذف مصروف', 'حذف هذا المصروف وإرجاع أثره على الخزنة؟'))) return;
  try {
    await api('expenses:delete', { id: Number(id) });
    await renderTreasury();
    toast('تم حذف المصروف');
  } catch (err) { showError(err); }
}

async function settleReceivable(id, remaining) {
  const input = await askPrompt('تحصيل ذمة آجلة', `المتبقي: ${money(remaining)} ${currency()}`, String(remaining));
  if (input === null) return;
  const amount = Number(input) || 0;
  if (amount <= 0) return;
  try {
    const res = await api('receivables:settle', { id: Number(id), amount });
    await renderTreasury();
    toast(res.status === 'paid' ? 'تم تحصيل الذمة بالكامل' : `تم التحصيل — المتبقي ${money(res.remaining)}`);
  } catch (err) { showError(err); }
}

/* ------------------------ تصدير تقارير الخزينة ------------------------ */
async function exportTreasuryExcel() {
  try {
    const res = await api('export:excel', { kind: 'treasury' });
    if (res && res.ok) toast('تم حفظ ملف Excel');
  } catch (err) { showError(err); }
}

function buildTreasuryPdfHtml(data) {
  const s = state.settings;
  const cur = currency();
  const { summary, expenses, movements, receivables } = data;
  const money3 = (n) => money(n);
  const section = (title, head, rows, emptyCols) => `
    <h2>${esc(title)}</h2>
    <table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows || `<tr><td colspan="${emptyCols}">لا توجد بيانات</td></tr>`}</tbody></table>`;

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
    table { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
    th, td { border-bottom: 1px solid #eee; padding: 3px 3px; text-align: right; }
    th { background: #f1f5f9; font-size: 9.5px; }
    .num { font-variant-numeric: tabular-nums; }
  </style></head><body>
    <h1>${esc(s.storeName || 'المتجر')} — تقرير الخزينة والمصروفات</h1>
    <div class="sub">${esc(fmtDateTime(Date.now()))} — ${esc(s.storeAddress || '')} ${esc(s.storePhone || '')}</div>
    <div class="cards">
      <div class="card">رصيد الخزينة<b>${money3(summary.balance)} ${esc(cur)}</b></div>
      <div class="card">إجمالي المصروفات<b>${money3(summary.expenses)} ${esc(cur)}</b></div>
      <div class="card">ذمم غير محصّلة<b>${money3(summary.receivablesOpen)} ${esc(cur)}</b></div>
      <div class="card">صافي حركة الخزينة<b>${money3(summary.treasuryNet)} ${esc(cur)}</b></div>
    </div>
    ${section('المصروفات', ['التاريخ', 'البيان', `المبلغ (${cur})`, 'المستخدم'],
      expenses.map((e) => `<tr><td>${esc(fmtDate(e.timestamp))}</td><td>${esc(e.description)}</td>
        <td class="num">${money3(e.amount)}</td><td>${esc(e.cashier || '')}</td></tr>`).join(''), 4)}
    ${section('حركة الخزينة', ['التاريخ', 'النوع', `المبلغ (${cur})`, 'البيان', 'المستخدم'],
      movements.map((t) => `<tr><td>${esc(fmtDate(t.timestamp))}</td><td>${t.type === 'in' ? 'إيداع' : 'سحب'}</td>
        <td class="num">${money3(t.amount)}</td><td>${esc(t.reason || '')}</td><td>${esc(t.cashier || '')}</td></tr>`).join(''), 5)}
    ${section('الآجل والذمم', ['الفاتورة', 'العميل', 'الهاتف', `المبلغ (${cur})`, 'المحصّل', 'المتبقي', 'الحالة'],
      receivables.map((r) => `<tr><td>${esc(r.serial)}</td><td>${esc(r.customerName || '-')}</td>
        <td class="num">${esc(r.customerPhone || '-')}</td><td class="num">${money3(r.amount)}</td>
        <td class="num">${money3(r.paid)}</td><td class="num">${money3(r.remaining)}</td>
        <td>${r.status === 'open' ? 'مفتوحة' : r.status === 'paid' ? 'محصّلة' : 'ملغاة'}</td></tr>`).join(''), 7)}
    <p style="margin-top:10px;color:#666;font-size:9px">POS Pro — تقرير آلي</p>
  </body></html>`;
}

async function exportTreasuryPdf() {
  try {
    const [summary, expenses, movements, receivables] = await Promise.all([
      api('treasury:summary', {}), api('expenses:list', {}), api('treasury:list', {}), api('receivables:list', {})
    ]);
    const res = await api('print:pdf', {
      html: buildTreasuryPdfHtml({ summary, expenses, movements, receivables }),
      widthMm: 210, heightMm: 297, marginMm: 10,
      defaultName: 'treasury-report'
    });
    if (res && res.ok) toast('تم حفظ تقرير الخزينة PDF');
  } catch (err) { showError(err); }
}

function switchTreasuryTab(tab) {
  ['expenses', 'movements', 'receivables', 'ledger'].forEach((name) => {
    const panel = $(`ttab-${name}`);
    if (panel) panel.classList.toggle('hidden', name !== tab);
  });
  $$('.ttab').forEach((btn) => {
    const active = btn.dataset.ttab === tab;
    btn.className = active
      ? 'ttab bg-slate-900 text-white px-3 py-1.5 rounded-lg text-xs font-bold'
      : 'ttab bg-white text-slate-700 border px-3 py-1.5 rounded-lg text-xs font-bold';
  });
}

function bindTreasuryEvents() {
  bind('openExpenseModalBtn', 'click', () => {
    $('expDesc').value = '';
    $('expAmount').value = '';
    openModal('expenseModal');
  });
  bind('cancelExpenseBtn', 'click', () => closeModal('expenseModal'));
  bind('saveExpenseBtn', 'click', saveExpense);

  bind('openTreasuryModalBtn', 'click', () => {
    $('trAmount').value = '';
    $('trReason').value = '';
    openModal('treasuryModal');
  });
  bind('cancelTreasuryBtn', 'click', () => closeModal('treasuryModal'));
  bind('saveTreasuryBtn', 'click', saveTreasury);

  bind('expensesTbody', 'click', (e) => {
    const btn = e.target.closest('[data-delexp]');
    if (btn) deleteExpense(btn.dataset.delexp);
  });
  bind('receivablesTbody', 'click', (e) => {
    const btn = e.target.closest('[data-settle]');
    if (btn) settleReceivable(btn.dataset.settle, Number(btn.dataset.remaining));
  });
  bind('treasuryExcelBtn', 'click', exportTreasuryExcel);
  bind('treasuryPdfBtn', 'click', exportTreasuryPdf);
  $$('.ttab').forEach((btn) => btn.addEventListener('click', () => switchTreasuryTab(btn.dataset.ttab)));
}
