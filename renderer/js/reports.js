'use strict';
/* ============================================================
   التقارير وإغلاق الوردية (Z-Report)
   ============================================================ */

function initReports() {
  const today = todayStr();
  if (!$('reportDateFrom').value) $('reportDateFrom').value = today;
  if (!$('reportDateTo').value) $('reportDateTo').value = today;
  fillReportCategories();
  runReports();
}

/* قائمة التصنيفات في فلتر التقارير (من التصنيفات المحفوظة) */
function fillReportCategories() {
  const sel = $('reportCategoryFilter');
  if (!sel) return;
  const current = sel.value;
  const list = Array.isArray(state.categories) ? state.categories : [];
  sel.innerHTML = '<option value="">كل التصنيفات</option>' +
    list.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (current && list.includes(current)) sel.value = current;
}

function reportFilters() {
  const fromStr = $('reportDateFrom').value;
  const toStr = $('reportDateTo').value;
  const { from, to } = dayRange(fromStr, toStr);
  return {
    from, to, fromStr, toStr,
    category: $('reportCategoryFilter').value || '',
    paymentMethod: $('reportPayFilter').value,
    search: $('reportSearch').value.trim()
  };
}

async function runReports() {
  const f = reportFilters();
  try {
    const [invoices, summary, advanced, staff] = await Promise.all([
      api('invoices:list', { from: f.from, to: f.to, category: f.category, paymentMethod: f.paymentMethod, search: f.search, limit: 3000 }),
      api('reports:summary', { from: f.from, to: f.to, category: f.category }),
      api('reports:advanced', { from: f.from, to: f.to, category: f.category }),
      api('reports:staff', { from: f.from, to: f.to, category: f.category })
    ]);
    state.reportData = { invoices, summary, advanced, staff, filters: f };
    renderReportCards(summary);
    renderReportTable(invoices);
    renderTopProducts(summary.topProducts || []);
    renderDailySales(summary.byDay || []);
    renderAdvanced(advanced);
    renderStaff(staff);
    renderDashboard(state.reportData);
    const sub = $('reportDashboardSubtitle');
    if (sub) {
      sub.textContent = `${f.fromStr} ← ${f.toStr}` + (f.category ? ` — التصنيف: ${f.category}` : ' — كل التصنيفات') +
        ` • ${summary.count} فاتورة • ${moneyCur(summary.sales)}`;
    }
  } catch (err) { showError(err); }
}

/* ------------------------ التحليلات المتقدمة ------------------------ */
const WEEKDAY_NAMES = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

function renderAdvanced(adv) {
  if (!adv) return;
  $('categoryReportTbody').innerHTML = (adv.byCategory || []).length
    ? adv.byCategory.map((c) => `<tr class="border-b"><td class="p-1.5">${esc(c.category)}</td>
        <td class="p-1.5 font-mono">${esc(c.qty)}</td><td class="p-1.5 font-mono">${money(c.total)}</td>
        <td class="p-1.5 font-mono text-emerald-700">${money(c.profit)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="text-center text-slate-400 py-4">لا توجد بيانات</td></tr>';

  const paymentTotal = (adv.byPayment || []).reduce((s, p) => s + p.total, 0);
  $('paymentReportTbody').innerHTML = (adv.byPayment || []).length
    ? adv.byPayment.map((p) => `<tr class="border-b"><td class="p-1.5">${esc(PAY_LABELS[p.method] || p.method)}</td>
        <td class="p-1.5 font-mono">${esc(p.count)}</td><td class="p-1.5 font-mono">${money(p.total)}</td>
        <td class="p-1.5 font-mono text-slate-600">${paymentTotal ? Math.round((p.total / paymentTotal) * 1000) / 10 : 0}%</td></tr>`).join('')
    : '<tr><td colspan="4" class="text-center text-slate-400 py-4">لا توجد بيانات</td></tr>';

  $('hoursReportTbody').innerHTML = (adv.byHour || []).length
    ? adv.byHour.map((h) => `<tr class="border-b"><td class="p-1.5 font-mono">${esc(h.hour)}:00</td>
        <td class="p-1.5 font-mono">${esc(h.count)}</td><td class="p-1.5 font-mono">${money(h.total)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="text-center text-slate-400 py-4">لا توجد بيانات</td></tr>';

  $('topCustomersTbody').innerHTML = (adv.topCustomers || []).length
    ? adv.topCustomers.map((c) => `<tr class="border-b"><td class="p-1.5">${esc(c.name)}</td>
        <td class="p-1.5 font-mono text-[11px]">${esc(c.phone || '-')}</td><td class="p-1.5 font-mono">${esc(c.count)}</td>
        <td class="p-1.5 font-mono text-emerald-700">${money(c.total)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="text-center text-slate-400 py-4">لا توجد بيانات</td></tr>';

  const o = adv.offers || {};
  const cards = [
    { label: 'متوسط الفاتورة', value: moneyCur(adv.avgTicket), cls: 'bg-indigo-600' },
    { label: 'فواتير عليها خصم', value: `${o.discounted || 0} من ${o.invoices || 0}`, cls: 'bg-amber-600' },
    { label: 'إجمالي الخصومات', value: moneyCur(o.discountTotal || 0), cls: 'bg-red-600' },
    { label: 'قيمة المخزون (تكلفة)', value: moneyCur((adv.stock || {}).costValue || 0), cls: 'bg-slate-700' }
  ];
  $('reportInsights').innerHTML = cards.map((c) => `
    <div class="${c.cls} text-white rounded-lg p-3 shadow">
      <div class="text-[10px] opacity-85">${esc(c.label)}</div>
      <div class="text-sm font-bold font-mono mt-0.5">${esc(c.value)}</div>
    </div>`).join('');
}

/* ------------------------ أداء الموظفين ------------------------ */
function renderStaff(list) {
  const rows = Array.isArray(list) ? list : [];
  $('staffReportTbody').innerHTML = rows.length
    ? rows.map((r) => `<tr class="border-b hover:bg-slate-50">
        <td class="p-1.5 font-bold">${esc(r.name)}${r.role === 'admin' ? ' <span class="text-[9px] bg-slate-200 px-1 rounded">مدير</span>' : ''}</td>
        <td class="p-1.5 font-mono">${esc(r.shifts)}</td>
        <td class="p-1.5 font-mono">${esc(r.hours)}</td>
        <td class="p-1.5 font-mono">${esc(r.invoices)}</td>
        <td class="p-1.5 font-mono font-bold text-emerald-700">${money(r.sales)}</td>
        <td class="p-1.5 font-mono text-[11px] text-rose-600">${r.returnsCount || 0} — ${money(r.returnsTotal || 0)}</td>
        <td class="p-1.5 font-mono font-bold">${money(r.netSales != null ? r.netSales : r.sales)}</td>
        <td class="p-1.5 font-mono">${money(r.profit)}</td>
        <td class="p-1.5 font-mono">${money(r.avgInvoice)}</td>
        <td class="p-1.5 font-mono ${r.cancelled ? 'text-red-600 font-bold' : ''}">${esc(r.cancelled)}</td>
        <td class="p-1.5 font-mono">${esc(r.share)}%</td>
      </tr>`).join('')
    : '<tr><td colspan="11" class="text-center text-slate-400 py-4">لا توجد بيانات في هذه الفترة</td></tr>';
}

function buildStaffPdfHtml(list, range) {
  const s = state.settings;
  const cur = currency();
  const rows = list.map((r) => `<tr>
    <td>${esc(r.name)}</td><td class="num">${esc(r.shifts)}</td><td class="num">${esc(r.hours)}</td>
    <td class="num">${esc(r.invoices)}</td>
    <td class="num">${money(r.sales)}</td><td class="num">${esc(r.returnsCount || 0)} — ${money(r.returnsTotal || 0)}</td>
    <td class="num">${money(r.netSales != null ? r.netSales : r.sales)}</td><td class="num">${money(r.profit)}</td>
    <td class="num">${money(r.avgInvoice)}</td><td class="num">${esc(r.cancelled)}</td><td class="num">${esc(r.share)}%</td></tr>`).join('');
  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">
  <style>
    @page { size: A4; margin: 12mm; }
    body { font-family: 'Cairo', Tahoma, sans-serif; direction: rtl; color: #111; font-size: 11px; margin: 0; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .sub { color: #555; margin-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 5px 4px; text-align: right; }
    th { background: #f1f5f9; font-size: 10.5px; }
    .num { font-variant-numeric: tabular-nums; }
  </style></head><body>
    <h1>${esc(s.storeName || 'المتجر')} — تقرير أداء الموظفين</h1>
    <div class="sub">${esc(range)}</div>
    <table><thead><tr><th>الموظف</th><th>الورديات</th><th>ساعات العمل</th><th>الفواتير</th>
      <th>المبيعات (${esc(cur)})</th><th>المرتجعات</th><th>صافي المبيعات</th><th>الربح</th>
      <th>متوسط الفاتورة</th><th>الإلغاءات</th><th>المساهمة</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="11">لا توجد بيانات</td></tr>'}</tbody></table>
    <p style="margin-top:10px;color:#666;font-size:9.5px">تم إنشاء التقرير بواسطة POS Pro — ${esc(fmtDateTime(Date.now()))}</p>
  </body></html>`;
}

async function exportStaffExcel() {
  const f = reportFilters();
  try {
    const res = await api('export:excel', { kind: 'staff', from: f.from, to: f.to });
    if (res && res.ok) toast('تم حفظ ملف Excel');
  } catch (err) { showError(err); }
}

async function exportStaffPdf() {
  const list = (state.reportData && state.reportData.staff) || [];
  const f = reportFilters();
  try {
    const res = await api('print:pdf', {
      html: buildStaffPdfHtml(list, `من ${f.fromStr} إلى ${f.toStr}`),
      widthMm: 210, heightMm: 297, marginMm: 10,
      defaultName: 'staff-performance'
    });
    if (res && res.ok) toast('تم حفظ تقرير الموظفين PDF');
  } catch (err) { showError(err); }
}

function renderReportCards(s) {
  const cards = [
    { icon: '💵', label: 'إجمالي الإيرادات', value: moneyCur(s.sales), cls: 'from-emerald-600 to-emerald-800' },
    { icon: '🧾', label: 'عدد الفواتير', value: String(s.count), cls: 'from-slate-700 to-slate-900' },
    { icon: '📈', label: 'مجمل الربح', value: moneyCur(s.profit), cls: 'from-blue-600 to-blue-800' },
    { icon: '↩️', label: 'المرتجعات', value: `${s.returnsCount || 0} — ${moneyCur(s.returnsTotal || 0)}`, cls: 'from-rose-600 to-rose-800' },
    { icon: '🧮', label: 'المصروفات', value: moneyCur(s.expenses), cls: 'from-red-600 to-red-800' },
    { icon: '🏆', label: 'صافي الربح', value: moneyCur(s.netProfit), cls: 'from-purple-600 to-purple-800' }
  ];
  $('reportCards').innerHTML = cards.map((c) => `
    <div class="relative overflow-hidden bg-gradient-to-br ${c.cls} text-white rounded-xl p-3 shadow-md">
      <div class="absolute -left-2 -bottom-4 text-5xl opacity-15 select-none">${c.icon}</div>
      <div class="text-[10px] opacity-90">${esc(c.label)}</div>
      <div class="text-base font-extrabold font-mono mt-0.5 relative">${esc(c.value)}</div>
    </div>`).join('');
}

/* لوحة بيانية سريعة أعلى التقارير (تُطبَع كما تظهر) */
const PAY_COLORS = { cash: 'bg-emerald-500', bank: 'bg-blue-500', credit: 'bg-amber-500' };

function renderDashboard(data) {
  const el = $('reportDashboard');
  if (!el || !data) return;
  const s = data.summary || {};
  const adv = data.advanced || {};
  const f = data.filters || {};
  const days = (s.byDay || []).slice(0, 10).reverse();
  const maxDay = Math.max(1, ...days.map((d) => Number(d.total) || 0));
  const payments = adv.byPayment || [];
  const payTotal = payments.reduce((a, p) => a + (Number(p.total) || 0), 0) || 1;

  const chart = days.length
    ? `<div class="flex items-end gap-2 h-36">${days.map((d) => {
      const h = Math.max(4, Math.round(((Number(d.total) || 0) / maxDay) * 78));
      return `<div class="flex-1 flex flex-col items-center justify-end gap-1" title="${esc(d.day)} — ${money(d.total)}">
        <div class="text-[9px] font-mono text-slate-500">${money(d.total)}</div>
        <div class="w-full bg-gradient-to-t from-emerald-600 to-emerald-400 rounded-t" style="height:${h}%"></div>
        <div class="text-[9px] text-slate-400 font-mono">${esc(String(d.day || '').slice(5))}</div>
      </div>`;
    }).join('')}</div>`
    : '<div class="text-center text-slate-400 text-xs py-10">لا توجد مبيعات في هذه الفترة</div>';

  const payBars = payments.length
    ? payments.map((p) => {
      const pct = Math.round(((Number(p.total) || 0) / payTotal) * 1000) / 10;
      return `<div>
        <div class="flex justify-between text-[11px] mb-1">
          <span class="font-semibold">${esc(PAY_LABELS[p.method] || p.method)} <span class="text-slate-400">${esc(p.count)} فاتورة</span></span>
          <span class="font-mono">${money(p.total)} · ${pct}%</span>
        </div>
        <div class="h-2.5 bg-slate-100 rounded-full overflow-hidden"><div class="${PAY_COLORS[p.method] || 'bg-slate-400'} h-full rounded-full" style="width:${pct}%"></div></div>
      </div>`;
    }).join('')
    : '<div class="text-center text-slate-400 text-xs py-6">لا توجد بيانات</div>';

  el.innerHTML = `
    <div class="bg-white rounded-xl shadow p-4">
      <div class="flex justify-between items-center mb-3">
        <h3 class="font-bold text-sm text-slate-700">📈 حركة المبيعات في الفترة</h3>
        <span class="text-[10px] text-slate-400 font-mono">${esc(f.fromStr || '')} ← ${esc(f.toStr || '')}</span>
      </div>
      ${chart}
    </div>
    <div class="bg-white rounded-xl shadow p-4">
      <div class="flex justify-between items-center mb-3">
        <h3 class="font-bold text-sm text-slate-700">💳 توزيع طرق الدفع</h3>
        <span class="text-[10px] text-slate-400">${f.category ? 'التصنيف: ' + esc(f.category) : 'كل التصنيفات'}</span>
      </div>
      <div class="space-y-3">${payBars}</div>
      <div class="mt-3 pt-2 border-t flex justify-between items-center text-[11px]">
        <span class="text-slate-500">متوسط الفاتورة</span>
        <b class="font-mono text-emerald-700">${moneyCur(adv.avgTicket || 0)}</b>
      </div>
    </div>`;
}

/* ------------------ تقرير A4 شامل (لوحة كاملة) ------------------ */
function a4ReportCss() {
  return `
    @page { size: A4; margin: 10mm; }
    body { font-family: 'Cairo', Tahoma, sans-serif; direction: rtl; color: #0f172a; font-size: 10.5px; margin: 0; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #047857; padding-bottom: 7px; margin-bottom: 9px; }
    .head h1 { font-size: 17px; margin: 0; }
    .brand { color: #475569; font-size: 10px; margin-top: 2px; }
    .meta { text-align: left; color: #475569; font-size: 9.5px; line-height: 1.7; }
    .kpis { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 4px; }
    .kpi { flex: 1 1 22%; border: 1px solid #e2e8f0; border-radius: 7px; padding: 6px 7px; }
    .kpi span { display: block; font-size: 8.5px; color: #64748b; }
    .kpi b { display: block; font-size: 12.5px; margin-top: 2px; font-variant-numeric: tabular-nums; }
    h2 { font-size: 11.5px; margin: 9px 0 3px; color: #047857; border-bottom: 1px solid #e2e8f0; padding-bottom: 2px; }
    table { width: 100%; border-collapse: collapse; font-size: 9.5px; }
    th, td { border-bottom: 1px solid #eef2f7; padding: 3px 4px; text-align: right; }
    th { background: #f1f5f9; font-size: 9px; }
    .num { font-variant-numeric: tabular-nums; }
    .cols { display: flex; gap: 9px; }
    .cols > div { flex: 1; min-width: 0; }
    .foot { margin-top: 10px; border-top: 1px solid #e2e8f0; padding-top: 5px; color: #64748b; font-size: 8.5px; display: flex; justify-content: space-between; }
    tr { page-break-inside: avoid; }
    h2 { page-break-after: avoid; }
  `;
}

function a4Table(headers, rows, emptyCols) {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows.length
    ? rows.join('')
    : `<tr><td colspan="${emptyCols || headers.length}" style="text-align:center;color:#94a3b8;padding:8px">لا توجد بيانات</td></tr>`;
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** لوحة تقرير واحدة تُستخدم للطباعة A4 والتصدير PDF (بنفس الترتيب والبيانات المعروضة). */
function buildReportsA4Html(data) {
  const s = state.settings;
  const cur = currency();
  const sum = data.summary || {};
  const adv = data.advanced || {};
  const staff = Array.isArray(data.staff) ? data.staff : [];
  const f = data.filters || {};
  const offers = adv.offers || {};
  const filtersLine = [
    `من ${f.fromStr || '—'} إلى ${f.toStr || '—'}`,
    f.category ? `التصنيف: ${f.category}` : 'كل التصنيفات',
    f.paymentMethod ? `طريقة الدفع: ${PAY_LABELS[f.paymentMethod] || f.paymentMethod}` : '',
    f.search ? `بحث: ${f.search}` : ''
  ].filter(Boolean).join(' — ');

  const kpi = [
    ['إجمالي الإيرادات', `${money(sum.sales)} ${cur}`],
    ['عدد الفواتير', String(sum.count || 0)],
    ['مجمل الربح', `${money(sum.profit)} ${cur}`],
    ['المرتجعات', `${sum.returnsCount || 0} — ${money(sum.returnsTotal || 0)} ${cur}`],
    ['صافي المبيعات', `${money(sum.netSales != null ? sum.netSales : sum.sales)} ${cur}`],
    ['المصروفات', `${money(sum.expenses)} ${cur}`],
    ['صافي الربح', `${money(sum.netProfit)} ${cur}`],
    ['متوسط الفاتورة', `${money(adv.avgTicket || 0)} ${cur}`]
  ].map(([label, value]) => `<div class="kpi"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('');

  const payTotal = (adv.byPayment || []).reduce((a, p) => a + (Number(p.total) || 0), 0) || 1;
  const payRows = (adv.byPayment || []).map((p) => `<tr><td>${esc(PAY_LABELS[p.method] || p.method)}</td>
    <td class="num">${esc(p.count)}</td><td class="num">${money(p.total)}</td>
    <td class="num">${Math.round(((Number(p.total) || 0) / payTotal) * 1000) / 10}%</td></tr>`);

  const catRows = (adv.byCategory || []).map((c) => `<tr><td>${esc(c.category)}</td>
    <td class="num">${esc(c.qty)}</td><td class="num">${money(c.total)}</td><td class="num">${money(c.profit)}</td></tr>`);

  const topRows = (sum.topProducts || []).map((p) => `<tr><td>${esc(p.name)}</td>
    <td class="num">${esc(p.qty)}</td><td class="num">${money(p.total)}</td><td class="num">${money(p.profit)}</td></tr>`);

  const hourRows = (adv.byHour || []).map((h) => `<tr><td class="num">${esc(h.hour)}:00</td>
    <td class="num">${esc(h.count)}</td><td class="num">${money(h.total)}</td></tr>`);

  const dayRows = (sum.byDay || []).map((d) => `<tr><td class="num">${esc(d.day)}</td>
    <td class="num">${esc(d.count)}</td><td class="num">${money(d.total)}</td><td class="num">${money(d.profit)}</td></tr>`);

  const custRows = (adv.topCustomers || []).map((c) => `<tr><td>${esc(c.name)}</td>
    <td class="num">${esc(c.phone || '-')}</td><td class="num">${esc(c.count)}</td><td class="num">${money(c.total)}</td></tr>`);

  const staffRows = staff.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${esc(r.shifts)}</td>
    <td class="num">${esc(r.hours)}</td><td class="num">${esc(r.invoices)}</td><td class="num">${money(r.sales)}</td>
    <td class="num">${esc(r.returnsCount || 0)} — ${money(r.returnsTotal || 0)}</td>
    <td class="num">${money(r.netSales != null ? r.netSales : r.sales)}</td>
    <td class="num">${money(r.profit)}</td><td class="num">${esc(r.cancelled)}</td><td class="num">${esc(r.share)}%</td></tr>`);

  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">
  <style>${a4ReportCss()}</style></head><body>
    <div class="head">
      <div>
        <h1>${esc(s.storeName || 'المتجر')} — لوحة التقارير والأداء</h1>
        <div class="brand">${esc(filtersLine)}</div>
      </div>
      <div class="meta">
        ${s.storeAddress ? esc(s.storeAddress) + '<br>' : ''}
        ${s.storePhone ? 'هاتف: ' + esc(s.storePhone) + '<br>' : ''}
        إجمالي مبيعات الفترة: <b>${money(sum.sales)} ${esc(cur)}</b><br>
        ${esc(fmtDateTime(Date.now()))}
      </div>
    </div>
    <div class="kpis">${kpi}</div>
    <div class="cols">
      <div>
        <h2>🏷️ المبيعات حسب التصنيف</h2>
        ${a4Table(['التصنيف', 'الكمية', 'القيمة', 'الربح'], catRows, 4)}
        <h2>💳 طرق الدفع</h2>
        ${a4Table(['الطريقة', 'الفواتير', 'القيمة', 'النسبة'], payRows, 4)}
        <h2>🕒 أوقات الذروة</h2>
        ${a4Table(['الساعة', 'الفواتير', 'الإجمالي'], hourRows, 3)}
      </div>
      <div>
        <h2>🔥 أكثر الأصناف مبيعًا</h2>
        ${a4Table(['الصنف', 'الكمية', 'القيمة', 'الربح'], topRows, 4)}
        <h2>📅 المبيعات اليومية</h2>
        ${a4Table(['اليوم', 'الفواتير', 'الإجمالي', 'الربح'], dayRows, 4)}
        <h2>🌟 أفضل العملاء</h2>
        ${a4Table(['العميل', 'الهاتف', 'الفواتير', 'الإجمالي'], custRows, 4)}
      </div>
    </div>
    <h2>👥 أداء الموظفين</h2>
    ${a4Table(['الموظف', 'الورديات', 'الساعات', 'الفواتير', 'المبيعات', 'المرتجعات', 'صافي المبيعات', 'الربح', 'الإلغاءات', 'المساهمة'], staffRows, 10)}
    <h2>🎁 العروض والمخزون</h2>
    <table><tbody>
      <tr><td>فواتير عليها خصم</td><td class="num">${esc(offers.discounted || 0)} من ${esc(offers.invoices || 0)}</td>
        <td>إجمالي الخصومات</td><td class="num">${money(offers.discountTotal || 0)} ${esc(cur)}</td></tr>
      <tr><td>فواتير ملغية</td><td class="num">${esc(sum.cancelledCount || 0)}</td>
        <td>قيمة المخزون (تكلفة)</td><td class="num">${money((adv.stock || {}).costValue || 0)} ${esc(cur)}</td></tr>
    </tbody></table>
    <div class="foot"><span>POS Pro — نظام نقاط البيع الاحترافي — ورق A4</span>
      <span>${esc(s.storePhone || '')}</span></div>
  </body></html>`;
}

async function printReportsA4() {
  const data = state.reportData;
  if (!data) return toast('لا توجد بيانات للطباعة', 'warn');
  try {
    toast('جارٍ إرسال التقرير إلى طابعة A4…');
    const res = await api('print:a4', {
      html: buildReportsA4Html(data),
      printerName: (state.settings && state.settings.reportA4PrinterName) || '',
      jobName: 'تقرير المبيعات A4'
    });
    if (res && res.ok) toast(`تمت الطباعة على ${res.printer || 'الطابعة الافتراضية'} — ورق A4`);
    else toast('فشلت طباعة A4: ' + ((res && res.error) || 'سبب غير معروف'), 'error');
  } catch (err) { showError(err); }
}

function renderReportTable(invoices) {
  $('filteredInvoicesCount').textContent = `${invoices.length} فاتورة`;
  const tbody = $('filteredReportsTbody');
  if (invoices.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-slate-400 py-6">لا توجد فواتير مطابقة</td></tr>';
    return;
  }
  tbody.innerHTML = invoices.map((inv) => {
    const cancelled = inv.status === 'cancelled';
    return `
      <tr class="border-b hover:bg-slate-50 ${cancelled ? 'bg-red-50 opacity-75' : ''}">
        <td class="p-2 font-bold ${cancelled ? 'line-through text-red-700' : ''}">${esc(inv.serial)}</td>
        <td class="p-2 text-slate-500 font-mono text-[11px]">${esc(fmtDateTime(inv.timestamp))}</td>
        <td class="p-2 text-slate-500">${esc(inv.cashier || '')}</td>
        <td class="p-2">${esc(inv.customer.name || '-')}</td>
        <td class="p-2 font-bold font-mono ${cancelled ? 'line-through text-red-700' : ''}">${money(inv.total)}</td>
        <td class="p-2 font-mono text-emerald-600">${cancelled ? '0.00' : money(inv.profit)}</td>
        <td class="p-2 text-[11px]">${esc(PAY_LABELS[inv.paymentMethod] || '')}</td>
        <td class="p-2 text-[11px]">${cancelled
          ? '<span class="text-red-600 font-bold bg-red-100 px-2 py-0.5 rounded">ملغية</span>'
          : '<span class="text-emerald-600 font-bold bg-emerald-100 px-2 py-0.5 rounded">مكتملة</span>'}</td>
      </tr>`;
  }).join('');
}

function renderTopProducts(list) {
  $('topProductsTbody').innerHTML = list.length
    ? list.map((p) => `<tr class="border-b"><td class="p-1.5">${esc(p.name)}</td>
        <td class="p-1.5 font-mono">${esc(p.qty)}</td><td class="p-1.5 font-mono">${money(p.total)}</td>
        <td class="p-1.5 font-mono text-emerald-700">${money(p.profit)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="text-center text-slate-400 py-4">لا توجد بيانات</td></tr>';
}

function renderDailySales(list) {
  $('dailySalesTbody').innerHTML = list.length
    ? list.map((d) => `<tr class="border-b"><td class="p-1.5 font-mono">${esc(d.day)}</td>
        <td class="p-1.5 font-mono">${esc(d.count)}</td><td class="p-1.5 font-mono">${money(d.total)}</td>
        <td class="p-1.5 font-mono text-emerald-700">${money(d.profit)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="text-center text-slate-400 py-4">لا توجد بيانات</td></tr>';
}

/* ------------------------------ إغلاق الوردية ------------------------------ */
async function openCloseShiftModal() {
  if (!state.shift) return toast('لا توجد وردية مفتوحة', 'warn');
  try {
    const summary = await api('shift:summary', { shiftId: state.shift.id });
    state.shiftSummary = summary;
    $('closeShiftSummary').innerHTML = `
      <div class="flex justify-between"><span>الوردية</span><b class="font-mono">#${esc(state.shift.id)}</b></div>
      <div class="flex justify-between"><span>عهدة افتتاحية</span><b class="font-mono">${money(summary.openingFloat)}</b></div>
      <div class="flex justify-between"><span>فواتير مكتملة</span><b class="font-mono">${esc(summary.invoiceCount)}</b></div>
      <div class="flex justify-between"><span>مبيعات كاش</span><b class="font-mono">${money(summary.cashSales)}</b></div>
      <div class="flex justify-between"><span>مبيعات تحويل</span><b class="font-mono">${money(summary.bankSales)}</b></div>
      <div class="flex justify-between"><span>مبيعات آجلة</span><b class="font-mono">${money(summary.creditSales)}</b></div>
      <div class="flex justify-between border-t pt-1 mt-1"><span>إجمالي المبيعات</span><b class="font-mono">${money(summary.totalSales)}</b></div>
      ${summary.returnsCount ? `<div class="flex justify-between text-red-600"><span>المرتجعات (${esc(summary.returnsCount)})</span><b class="font-mono">− ${money(summary.returnsTotal)}</b></div>
      <div class="flex justify-between"><span>صافي المبيعات</span><b class="font-mono">${money(summary.netSales)}</b></div>` : ''}
      <div class="flex justify-between text-emerald-700"><span>الأرباح</span><b class="font-mono">${money(summary.totalProfit)}</b></div>
      <div class="flex justify-between text-red-600"><span>مصروفات من الدرج</span><b class="font-mono">${money(summary.cashExpenses)}</b></div>
      <div class="flex justify-between text-blue-700"><span>صافي حركة الخزنة</span><b class="font-mono">${money(summary.treasuryNet)}</b></div>
      <div class="flex justify-between bg-amber-50 px-1 rounded"><span>النقدية المتوقعة</span><b class="font-mono">${money(summary.expectedCash)}</b></div>`;
    $('actualCash').value = Number(summary.expectedCash).toFixed(2);
    updateDiscrepancy();
    openModal('closeShiftModal');
  } catch (err) { showError(err); }
}

function updateDiscrepancy() {
  const summary = state.shiftSummary;
  if (!summary) return;
  const actual = Number($('actualCash').value) || 0;
  const diff = round2(actual - summary.expectedCash);
  const box = $('discrepancyBox');
  const base = 'text-center py-2 rounded-xl font-bold mb-2 text-sm font-mono';
  if (Math.abs(diff) < 0.01) {
    box.className = `${base} bg-emerald-100 text-emerald-700`;
    box.textContent = '✅ مطابق تمامًا';
  } else if (diff > 0) {
    box.className = `${base} bg-blue-100 text-blue-700`;
    box.textContent = `⬆️ زيادة: ${money(diff)} ${currency()}`;
  } else {
    box.className = `${base} bg-red-100 text-red-700`;
    box.textContent = `⬇️ عجز: ${money(Math.abs(diff))} ${currency()}`;
  }
}

let shiftClosing = false;
/**
 * إغلاق الوردية بثلاثة خيارات واضحة داخل النافذة نفسها:
 *   printReport = true  → تأكيد + طباعة تقرير الوردية (Z-Report)
 *   printReport = false → تأكيد وحفظ بدون طباعة
 *   إلغاء                → إغلاق النافذة دون أي تغيير
 * لا يوجد تأكيد إضافي (النافذة نفسها هي التأكيد)، ويُسجّل الخروج بعد الإغلاق.
 */
async function confirmCloseShift(printReport) {
  if (!state.shift || shiftClosing) return;
  shiftClosing = true;
  const printBtn = $('confirmCloseShiftPrint');
  const noPrintBtn = $('confirmCloseShiftNoPrint');
  const cancelBtn = $('cancelCloseShift');
  const statusEl = $('closeShiftStatus');
  printBtn.disabled = true;
  noPrintBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
  if (statusEl) {
    statusEl.textContent = printReport ? 'جارٍ إغلاق الوردية وطباعة التقرير…' : 'جارٍ إغلاق الوردية…';
    statusEl.classList.remove('hidden');
  }
  try {
    const shift = await api('shift:close', {
      shiftId: state.shift.id,
      actualCash: Number($('actualCash').value) || 0
    });
    closeModal('closeShiftModal');
    // نسخة احتياطية كاملة ومضغوطة في لحظة إغلاق الوردية (الطريق الآخر هو تسجيل الخروج)
    await runSessionBackup('shift_close');
    if (printReport) await printZReport(shift);
    state.shift = null;
    state.shiftSummary = null;
    toast(printReport ? 'تم إغلاق الوردية وطباعة تقريرها' : 'تم إغلاق الوردية بدون طباعة');
    setTimeout(() => doLogout(true), printReport ? 1600 : 1200);
  } catch (err) {
    showError(err);
  } finally {
    shiftClosing = false;
    printBtn.disabled = false;
    noPrintBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
    if (statusEl) { statusEl.textContent = ''; statusEl.classList.add('hidden'); }
  }
}

/* ------------------------------ التصدير ------------------------------ */
async function exportReportsExcel() {
  const f = reportFilters();
  try {
    const res = await api('export:excel', { kind: 'invoices', from: f.from, to: f.to });
    if (res && res.ok) toast('تم حفظ ملف Excel');
  } catch (err) { showError(err); }
}

async function exportReportsPdf() {
  const data = state.reportData;
  if (!data) return toast('لا توجد بيانات للتصدير', 'warn');
  try {
    const res = await api('print:pdf', {
      html: buildReportsA4Html(data),
      widthMm: 210, heightMm: 297, marginMm: 10,
      defaultName: 'sales-report'
    });
    if (res && res.ok) toast('تم حفظ تقرير A4 بصيغة PDF');
  } catch (err) { showError(err); }
}

function bindReportEvents() {
  bind('applyReportFilterBtn', 'click', runReports);
  bind('resetReportFilterBtn', 'click', () => {
    $('reportDateFrom').value = todayStr();
    $('reportDateTo').value = todayStr();
    $('reportPayFilter').value = '';
    $('reportCategoryFilter').value = '';
    $('reportSearch').value = '';
    runReports();
  });
  bind('printReportsA4Btn', 'click', printReportsA4);
  bind('reportSearch', 'keydown', (e) => { if (e.key === 'Enter') runReports(); });
  bind('closeShiftBtn', 'click', openCloseShiftModal);
  bind('actualCash', 'input', updateDiscrepancy);
  bind('cancelCloseShift', 'click', () => closeModal('closeShiftModal'));
  bind('closeShiftX', 'click', () => closeModal('closeShiftModal'));
  bind('confirmCloseShiftPrint', 'click', () => confirmCloseShift(true));
  bind('confirmCloseShiftNoPrint', 'click', () => confirmCloseShift(false));
  bind('exportInvoicesExcelBtn', 'click', exportReportsExcel);
  bind('exportInvoicesPdfBtn', 'click', exportReportsPdf);
  bind('staffExcelBtn', 'click', exportStaffExcel);
  bind('staffPdfBtn', 'click', exportStaffPdf);
}
