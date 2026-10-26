'use strict';
/**
 * التصدير والنسخ الاحتياطي: Excel عبر exceljs في العملية الرئيسية،
 * وملفات JSON كاملة (بدون كلمات مرور) تُحفظ في مجلد بيانات التطبيق.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const ExcelJS = require('exceljs');
const { dialog } = require('electron');
const db = require('./db');

const money = (n) => Number(Number(n || 0).toFixed(2));

function stampName(prefix, ext) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  row.alignment = { vertical: 'middle', horizontal: 'center', readingOrder: 'rtl' };
  row.height = 22;
}

function autoWidths(sheet) {
  sheet.columns.forEach((col) => {
    let max = 10;
    col.eachCell({ includeEmpty: true }, (cell) => {
      const v = cell.value == null ? '' : String(cell.value);
      max = Math.max(max, Math.min(40, v.length + 2));
    });
    col.width = Math.max(col.width || 10, max);
  });
}

async function buildWorkbook(kind, opts = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'POS Pro';
  wb.created = new Date();
  const settings = db.settingsGet();
  const currency = settings.currency || 'ر.ي';

  if (kind === 'products') {
    const sheet = wb.addWorksheet('الأصناف', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'كود', key: 'id', width: 8 },
      { header: 'الصنف', key: 'name', width: 28 },
      { header: 'الفئة', key: 'category', width: 16 },
      { header: 'الباركود', key: 'barcode', width: 18 },
      { header: `التكلفة (${currency})`, key: 'cost', width: 14 },
      { header: `سعر البيع (${currency})`, key: 'price', width: 16 },
      { header: 'المخزون', key: 'stock', width: 12 },
      { header: 'الحد الأدنى', key: 'min', width: 12 },
      { header: 'الأحجام (الاسم: المخزون)', key: 'variants', width: 30 },
      { header: 'النكهات / الإضافات', key: 'options', width: 30 },
      { header: 'الوصفة (الخامة: الكمية بوحدتها)', key: 'recipe', width: 36 },
      { header: 'قيمة المخزون', key: 'value', width: 16 }
    ];
    styleHeader(sheet.getRow(1));
    db.productsList(true).forEach((p) => sheet.addRow({
      id: p.id, name: p.name, category: p.category || '', barcode: p.barcode || '',
      cost: money(p.costPrice), price: money(p.sellingPrice), stock: p.stock,
      min: p.minStock,
      variants: (p.variants || []).map((v) => `${v.name}: ${v.stock}`).join(' | '),
      options: (p.options || []).map((o) => (Number(o.price) > 0 ? `${o.name} (+${o.price})` : o.name)).join(' | '),
      recipe: (p.recipe || []).map((r) => `${r.materialName}: ${r.qty} ${r.unit}`).join(' | '),
      value: money(p.stock * p.costPrice)
    }));
    autoWidths(sheet);
  } else if (kind === 'invoices') {
    const from = opts.from ? Number(opts.from) : 0;
    const to = opts.to ? Number(opts.to) : Date.now();
    const invoices = db.invoicesList({
      from, to,
      shiftId: opts.shiftId || null,
      ids: Array.isArray(opts.ids) && opts.ids.length ? opts.ids : null,
      limit: 5000
    });
    const sheet = wb.addWorksheet('الفواتير', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'الفاتورة', key: 'serial', width: 16 },
      { header: 'التاريخ', key: 'date', width: 20 },
      { header: 'الوقت', key: 'time', width: 12 },
      { header: 'الكاشير', key: 'cashier', width: 16 },
      { header: 'العميل', key: 'customer', width: 20 },
      { header: 'الهاتف', key: 'phone', width: 16 },
      { header: `المجموع (${currency})`, key: 'subtotal', width: 14 },
      { header: 'الخصم', key: 'discount', width: 12 },
      { header: 'الضريبة', key: 'tax', width: 12 },
      { header: `الإجمالي (${currency})`, key: 'total', width: 16 },
      { header: 'الربح', key: 'profit', width: 14 },
      { header: 'الدفع', key: 'method', width: 12 },
      { header: 'الحالة', key: 'status', width: 12 },
      { header: 'ملاحظة', key: 'comment', width: 24 }
    ];
    styleHeader(sheet.getRow(1));
    const labels = { cash: 'كاش', bank: 'تحويل', credit: 'آجل' };
    invoices.forEach((inv) => {
      const d = new Date(inv.timestamp);
      sheet.addRow({
        serial: inv.serial,
        date: d.toLocaleDateString('en-GB'),
        time: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        cashier: inv.cashier,
        customer: inv.customer.name || '',
        phone: inv.customer.phone || '',
        subtotal: money(inv.subtotal),
        discount: money(inv.discount + inv.pointsDiscount),
        tax: money(inv.tax),
        total: money(inv.total),
        profit: money(inv.profit),
        method: labels[inv.paymentMethod] || inv.paymentMethod,
        status: inv.status === 'cancelled' ? 'ملغية' : 'مكتملة',
        comment: inv.comment || ''
      });
    });
    autoWidths(sheet);

    const itemsSheet = wb.addWorksheet('تفاصيل الأصناف', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    itemsSheet.columns = [
      { header: 'الفاتورة', key: 'serial', width: 16 },
      { header: 'الصنف', key: 'name', width: 28 },
      { header: 'الحجم', key: 'variant', width: 14 },
      { header: 'الكمية', key: 'qty', width: 10 },
      { header: 'السعر', key: 'price', width: 12 },
      { header: 'الإجمالي', key: 'total', width: 14 },
      { header: 'النكهات / الإضافات', key: 'flavors', width: 24 },
      { header: 'ملاحظة', key: 'note', width: 24 }
    ];
    styleHeader(itemsSheet.getRow(1));
    invoices.forEach((inv) => inv.items.forEach((it) => itemsSheet.addRow({
      serial: inv.serial, name: it.name, variant: it.variantName || '', qty: it.qty,
      price: money(it.sellingPrice), total: money(it.qty * it.sellingPrice),
      flavors: (it.options || []).map((o) => o.name).join(' + '), note: it.note || ''
    })));
    autoWidths(itemsSheet);

    const summary = wb.addWorksheet('ملخص', { views: [{ rightToLeft: true }] });
    const s = db.reportsSummary(from, to);
    summary.columns = [{ header: 'البند', key: 'k', width: 26 }, { header: 'القيمة', key: 'v', width: 20 }];
    styleHeader(summary.getRow(1));
    [
      ['عدد الفواتير', s.count], ['إجمالي المبيعات', money(s.sales)], ['تكلفة المبيعات', money(s.cost)],
      ['مجمل الربح', money(s.profit)], ['الخصومات', money(s.discount)], ['الضريبة', money(s.tax)],
      ['مبيعات كاش', money(s.cash)], ['مبيعات تحويل', money(s.bank)], ['مبيعات آجلة', money(s.credit)],
      ['المصروفات', money(s.expenses)], ['صافي الربح', money(s.netProfit)],
      ['فواتير ملغاة', s.cancelledCount]
    ].forEach(([k, v]) => summary.addRow({ k, v }));
    autoWidths(summary);
  } else if (kind === 'staff') {
    const from = opts.from ? Number(opts.from) : 0;
    const to = opts.to ? Number(opts.to) : Date.now();
    const rowsData = db.reportsStaff(from, to);
    const sheet = wb.addWorksheet('أداء الموظفين', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'الموظف', key: 'name', width: 22 },
      { header: 'الصلاحية', key: 'role', width: 14 },
      { header: 'الورديات', key: 'shifts', width: 12 },
      { header: 'ساعات العمل', key: 'hours', width: 14 },
      { header: 'الفواتير', key: 'invoices', width: 12 },
      { header: 'المكتملة', key: 'completed', width: 12 },
      { header: 'الإلغاءات', key: 'cancelled', width: 12 },
      { header: `المبيعات (${currency})`, key: 'sales', width: 16 },
      { header: 'المرتجعات', key: 'returnsCount', width: 12 },
      { header: 'قيمة المرتجعات', key: 'returnsTotal', width: 16 },
      { header: 'صافي المبيعات', key: 'netSales', width: 16 },
      { header: 'الربح', key: 'profit', width: 14 },
      { header: 'متوسط الفاتورة', key: 'avg', width: 16 },
      { header: 'مبيعات/ساعة', key: 'perHour', width: 14 },
      { header: 'المساهمة %', key: 'share', width: 12 }
    ];
    styleHeader(sheet.getRow(1));
    rowsData.forEach((r) => sheet.addRow({
      name: r.name, role: r.role === 'admin' ? 'مدير' : r.role || '',
      shifts: r.shifts, hours: r.hours, invoices: r.invoices, completed: r.completed,
      cancelled: r.cancelled, sales: money(r.sales),
      returnsCount: r.returnsCount, returnsTotal: money(r.returnsTotal),
      netSales: money(r.netSales), profit: money(r.profit),
      avg: money(r.avgInvoice), perHour: money(r.salesPerHour), share: r.share
    }));
    autoWidths(sheet);
  } else if (kind === 'returns') {
    const from = opts.from ? Number(opts.from) : 0;
    const to = opts.to ? Number(opts.to) : Date.now();
    const list = db.returnsList({ from, to, limit: 5000 });
    const sheet = wb.addWorksheet('المرتجعات', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'رقم المرتجع', key: 'serial', width: 16 },
      { header: 'التاريخ', key: 'date', width: 20 },
      { header: 'الفاتورة الأصلية', key: 'invoice', width: 16 },
      { header: 'الكاشير', key: 'cashier', width: 16 },
      { header: 'العميل', key: 'customer', width: 20 },
      { header: 'السبب', key: 'reason', width: 20 },
      { header: 'الأصناف', key: 'items', width: 10 },
      { header: `قيمة البضاعة (${currency})`, key: 'subtotal', width: 16 },
      { header: `الصافي المسترد (${currency})`, key: 'total', width: 18 },
      { header: 'تكلفة البضاعة', key: 'cost', width: 14 },
      { header: 'عكس الربح', key: 'profit', width: 14 },
      { header: 'طريقة الاسترداد', key: 'method', width: 18 }
    ];
    styleHeader(sheet.getRow(1));
    const methodLabels = { cash: 'نقدي من الخزنة', credit: 'خصم من الآجل', none: 'بدون استرداد' };
    list.forEach((r) => {
      const d = new Date(r.timestamp);
      sheet.addRow({
        serial: r.serial, date: `${d.toLocaleDateString('en-GB')} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
        invoice: r.invoiceSerial, cashier: r.cashier, customer: r.customer.name || '',
        reason: r.reason || '', items: r.items.length,
        subtotal: money(r.subtotal), total: money(r.total), cost: money(r.totalCost),
        profit: money(r.profitReversal), method: methodLabels[r.refundMethod] || r.refundMethod
      });
    });
    autoWidths(sheet);

    const itemsSheet = wb.addWorksheet('تفاصيل المرتجعات', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    itemsSheet.columns = [
      { header: 'المرتجع', key: 'serial', width: 16 },
      { header: 'الفاتورة', key: 'invoice', width: 16 },
      { header: 'الصنف', key: 'name', width: 28 },
      { header: 'الحجم', key: 'variant', width: 14 },
      { header: 'الكمية', key: 'qty', width: 10 },
      { header: 'السعر', key: 'price', width: 12 },
      { header: 'الإجمالي', key: 'total', width: 14 },
      { header: 'السبب', key: 'reason', width: 22 }
    ];
    styleHeader(itemsSheet.getRow(1));
    list.forEach((r) => r.items.forEach((it) => itemsSheet.addRow({
      serial: r.serial, invoice: r.invoiceSerial, name: it.name, variant: it.variantName || '',
      qty: it.qty, price: money(it.sellingPrice), total: money(it.qty * it.sellingPrice),
      reason: it.reason || ''
    })));
    autoWidths(itemsSheet);

    const summary = wb.addWorksheet('ملخص', { views: [{ rightToLeft: true }] });
    const s = db.returnsSummary(from, to);
    summary.columns = [{ header: 'البند', key: 'k', width: 26 }, { header: 'القيمة', key: 'v', width: 20 }];
    styleHeader(summary.getRow(1));
    [
      ['عدد المرتجعات', s.count],
      ['إجمالي الصافي المسترد', money(s.total)],
      ['تكلفة البضاعة المرتجعة', money(s.cost)],
      ['عكس الربح', money(s.profitReversal)],
      ['استرداد نقدي', money((s.byMethod.find((m) => m.method === 'cash') || {}).total || 0)],
      ['خصم من الآجل', money((s.byMethod.find((m) => m.method === 'credit') || {}).total || 0)]
    ].forEach(([k, v]) => summary.addRow({ k, v }));
    autoWidths(summary);
  } else if (kind === 'treasury') {
    const from = opts.from ? Number(opts.from) : 0;
    const to = opts.to ? Number(opts.to) : Date.now();
    const summary = db.treasurySummary(from, to);

    const summarySheet = wb.addWorksheet('ملخص الخزينة', { views: [{ rightToLeft: true }] });
    summarySheet.columns = [{ header: 'البند', key: 'k', width: 30 }, { header: 'القيمة', key: 'v', width: 20 }];
    styleHeader(summarySheet.getRow(1));
    [
      ['رصيد الخزينة الحالي', money(summary.balance)],
      ['إجمالي المصروفات', money(summary.expenses)],
      ['مصروفات الفترة', money(summary.expensesRange)],
      ['إيداعات الفترة', money(summary.treasuryIn)],
      ['مسحوبات الفترة', money(summary.treasuryOut)],
      ['صافي حركة الخزينة', money(summary.treasuryNet)],
      ['مبيعات نقدية في الفترة', money(summary.cashSalesRange)],
      ['ذمم آجلة غير محصلة', money(summary.receivablesOpen)]
    ].forEach(([k, v]) => summarySheet.addRow({ k, v }));
    autoWidths(summarySheet);

    const expSheet = wb.addWorksheet('المصروفات', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    expSheet.columns = [
      { header: 'التاريخ', key: 'date', width: 18 },
      { header: 'البيان', key: 'desc', width: 32 },
      { header: `المبلغ (${currency})`, key: 'amount', width: 16 },
      { header: 'المستخدم', key: 'user', width: 18 }
    ];
    styleHeader(expSheet.getRow(1));
    db.expensesList(from, to).forEach((e) => expSheet.addRow({
      date: new Date(e.timestamp).toLocaleDateString('en-GB'),
      desc: e.description, amount: money(e.amount), user: e.cashier || ''
    }));
    autoWidths(expSheet);

    const movSheet = wb.addWorksheet('حركة الخزينة', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    movSheet.columns = [
      { header: 'التاريخ', key: 'date', width: 18 },
      { header: 'النوع', key: 'type', width: 14 },
      { header: `المبلغ (${currency})`, key: 'amount', width: 16 },
      { header: 'البيان', key: 'reason', width: 32 },
      { header: 'المستخدم', key: 'user', width: 18 }
    ];
    styleHeader(movSheet.getRow(1));
    db.treasuryList()
      .filter((t) => t.timestamp >= from && t.timestamp <= to)
      .forEach((t) => movSheet.addRow({
        date: new Date(t.timestamp).toLocaleDateString('en-GB'),
        type: t.type === 'in' ? 'إيداع' : 'سحب',
        amount: money(t.amount), reason: t.reason || '', user: t.cashier || ''
      }));
    autoWidths(movSheet);

    const recSheet = wb.addWorksheet('الذمم الآجلة', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    recSheet.columns = [
      { header: 'الفاتورة', key: 'serial', width: 16 },
      { header: 'العميل', key: 'customer', width: 24 },
      { header: 'الهاتف', key: 'phone', width: 16 },
      { header: `المبلغ (${currency})`, key: 'amount', width: 16 },
      { header: 'المحصّل', key: 'paid', width: 14 },
      { header: 'المتبقي', key: 'remaining', width: 14 },
      { header: 'الحالة', key: 'status', width: 12 }
    ];
    styleHeader(recSheet.getRow(1));
    db.receivablesList().forEach((r) => recSheet.addRow({
      serial: r.serial, customer: r.customerName || '', phone: r.customerPhone || '',
      amount: money(r.amount), paid: money(r.paid), remaining: money(r.remaining),
      status: r.status === 'open' ? 'مفتوحة' : r.status === 'paid' ? 'محصّلة' : 'ملغاة'
    }));
    autoWidths(recSheet);
  } else {
    throw new Error('نوع التصدير غير معروف');
  }
  return wb;
}

async function exportExcel(kind, opts) {
  const wb = await buildWorkbook(kind, opts || {});
  const prefix = kind === 'products' ? 'products'
    : kind === 'treasury' ? 'treasury'
      : kind === 'staff' ? 'staff'
        : kind === 'returns' ? 'returns' : 'invoices';
  const defName = stampName(prefix, 'xlsx');
  const res = await dialog.showSaveDialog({
    title: 'حفظ ملف Excel',
    defaultPath: path.join(require('electron').app.getPath('downloads'), defName),
    filters: [{ name: 'Excel', extensions: ['xlsx'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  await wb.xlsx.writeFile(res.filePath);
  return { ok: true, filePath: res.filePath };
}

/* ------------------------------ تصدير CSV ------------------------------ */
function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function tableToCsv(headers, rows) {
  return [headers, ...rows].map((line) => line.map(csvCell).join(',')).join('\r\n');
}

function csvData(kind, opts = {}) {
  const from = opts.from ? Number(opts.from) : 0;
  const to = opts.to ? Number(opts.to) : Date.now();
  if (kind === 'returns') {
    const list = db.returnsList({ from, to, limit: 5000 });
    const method = { cash: 'نقدي من الخزنة', credit: 'خصم من الآجل', none: 'بدون استرداد' };
    const headers = ['رقم المرتجع', 'التاريخ', 'الفاتورة', 'الكاشير', 'العميل', 'السبب',
      'قيمة البضاعة', 'الصافي المسترد', 'تكلفة البضاعة', 'عكس الربح', 'طريقة الاسترداد'];
    const rows = [];
    list.forEach((r) => {
      rows.push([r.serial, new Date(r.timestamp).toLocaleString('en-GB'), r.invoiceSerial,
        r.cashier, r.customer.name || '', r.reason || '', money(r.subtotal), money(r.total),
        money(r.totalCost), money(r.profitReversal), method[r.refundMethod] || r.refundMethod]);
      r.items.forEach((it) => {
        rows.push([`${r.serial} / ${it.name}${it.variantName ? ' - ' + it.variantName : ''}`,
          '', '', '', '', it.reason || '', '', money(it.qty * it.sellingPrice), '', '', `الكمية ${it.qty}`]);
      });
    });
    return { prefix: 'returns', headers, rows };
  }
  if (kind === 'staff') {
    const rowsData = db.reportsStaff(from, to);
    const headers = ['الموظف', 'الصلاحية', 'الورديات', 'ساعات العمل', 'الفواتير', 'المكتملة',
      'الإلغاءات', 'المبيعات', 'المرتجعات', 'قيمة المرتجعات', 'صافي المبيعات', 'الربح', 'متوسط الفاتورة', 'المساهمة %'];
    const rows = rowsData.map((r) => [r.name, r.role === 'admin' ? 'مدير' : 'كاشير', r.shifts, r.hours,
      r.invoices, r.completed, r.cancelled, money(r.sales), r.returnsCount, money(r.returnsTotal),
      money(r.netSales), money(r.profit), money(r.avgInvoice), r.share]);
    return { prefix: 'staff', headers, rows };
  }
  if (kind === 'invoices') {
    const list = db.invoicesList({ from, to, limit: 5000 });
    const headers = ['الفاتورة', 'التاريخ', 'الكاشير', 'العميل', 'الهاتف', 'المجموع', 'الخصم',
      'الضريبة', 'الإجمالي', 'الربح', 'الدفع', 'الحالة'];
    const labels = { cash: 'كاش', bank: 'تحويل', credit: 'آجل' };
    const rows = list.map((inv) => [inv.serial, new Date(inv.timestamp).toLocaleString('en-GB'),
      inv.cashier, inv.customer.name || '', inv.customer.phone || '', money(inv.subtotal),
      money(inv.discount + inv.pointsDiscount), money(inv.tax), money(inv.total), money(inv.profit),
      labels[inv.paymentMethod] || inv.paymentMethod, inv.status === 'cancelled' ? 'ملغية' : 'مكتملة']);
    return { prefix: 'invoices', headers, rows };
  }
  throw new Error('نوع تصدير CSV غير معروف');
}

async function exportCsv(kind, opts) {
  const { prefix, headers, rows } = csvData(kind, opts);
  const res = await dialog.showSaveDialog({
    title: 'حفظ ملف CSV',
    defaultPath: path.join(require('electron').app.getPath('downloads'), stampName(prefix, 'csv')),
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  // BOM حتى يفتح Excel العربية بترميز صحيح
  fs.writeFileSync(res.filePath, '\uFEFF' + tableToCsv(headers, rows), 'utf8');
  return { ok: true, filePath: res.filePath, rows: rows.length };
}

/* ------------------------------ النسخ الاحتياطي ------------------------------ */
function backupDir() {
  const dir = path.join(require('electron').app.getPath('userData'), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listBackups() {
  const dir = backupDir();
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      return { name: f, path: full, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function pruneBackups(keep) {
  const files = listBackups();
  const limit = Math.max(3, Number(keep) || 30);
  files.slice(limit).forEach((f) => { try { fs.unlinkSync(f.path); } catch { /* ignore */ } });
}

function createBackup(reason = 'manual') {
  const file = db.backupFile(backupDir());
  pruneBackups(db.settingsGet().backupKeep);
  return { file, reason, at: Date.now() };
}

/**
 * نسخة احتياطية كاملة ومضغوطة من ملف قاعدة البيانات نفسه (pos.db → gzip).
 * تُستخدم عند إغلاق الوردية وعند تسجيل الخروج كخطة طوارئ:
 * تحتوي كل شيء (المخطط والبيانات) بحجم أصغر بكثير من ملف JSON.
 * الاستعادة: إيقاف البرنامج ثم فك الضغط فوق pos.db.
 */
function createDbBackup(reason = 'session') {
  const info = db.dbInfo();
  if (!info || !info.path) throw new Error('مسار قاعدة البيانات غير معروف');
  const dir = path.join(backupDir(), 'db');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tmp = path.join(dir, `pos-db-${stamp}.snapshot`);
  const out = `${tmp}.gz`;
  try {
    // VACUUM INTO يعطي لقطة متسقة للقاعدة حتى أثناء الكتابة (يشمل ملفات WAL)
    db.getHandle().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const raw = fs.readFileSync(tmp);
    fs.writeFileSync(out, zlib.gzipSync(raw, { level: 9 }));
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
  pruneDbBackups(db.settingsGet().backupKeep);
  db.audit('system', 'db_backup', {
    reason, file: out, sourceBytes: info.size, gzipBytes: fs.statSync(out).size
  });
  return { file: out, reason, at: Date.now(), size: fs.statSync(out).size, sourceSize: info.size };
}

/** الاحتفاظ بعدد محدود من لقطات قاعدة البيانات (نفس مبدأ النسخ العادية). */
function pruneDbBackups(keep) {
  const dir = path.join(backupDir(), 'db');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.gz'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const limit = Math.max(3, Number(keep) || 30);
  files.slice(limit).forEach((x) => {
    try { fs.unlinkSync(path.join(dir, x.f)); } catch { /* ignore */ }
  });
}

async function exportBackupAs() {
  const res = await dialog.showSaveDialog({
    title: 'حفظ نسخة احتياطية',
    defaultPath: path.join(require('electron').app.getPath('documents'), stampName('pos-backup', 'json')),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(res.filePath, JSON.stringify(db.dumpAll()), 'utf8');
  return { ok: true, filePath: res.filePath };
}

async function importBackupFromFile(actor) {
  const res = await dialog.showOpenDialog({
    title: 'اختيار ملف النسخة الاحتياطية',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  const file = res.filePaths[0];
  const text = fs.readFileSync(file, 'utf8');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('الملف ليس JSON صالحًا'); }
  if (!data || !Array.isArray(data.products) || !Array.isArray(data.invoices)) {
    throw new Error('الملف لا يبدو نسخة احتياطية صالحة من النظام');
  }
  // نسخة أمان قبل الاستبدال
  createBackup('pre-restore');
  const result = db.replaceAll(data);
  db.audit(actor, 'backup_restore', { file, ...result });
  return { ok: true, ...result };
}

module.exports = {
  exportExcel, exportCsv, buildWorkbook, csvData,
  createBackup, createDbBackup, listBackups, exportBackupAs, importBackupFromFile,
  backupDir, stampName
};
