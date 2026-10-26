'use strict';
/**
 * استيراد نسخة النظام القديمة (المتصفح / IndexedDB) إلى قاعدة SQLite الجديدة.
 * يحوّل البنية القديمة (فواتير بأصناف مدمجة، مستخدمون بكلمات مرور صريحة...)
 * إلى البنية الجديدة، ويعيد بناء دفتر النقدية والذمم من البيانات نفسها.
 */
const db = require('./db');
const { hashPassword } = require('./security');

const now = () => Date.now();
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const str = (v, max = 200) => String(v == null ? '' : v).slice(0, max);

function isLegacyBackup(data) {
  return !!data && Array.isArray(data.products) && Array.isArray(data.invoices) &&
    data.invoices.some((inv) => Array.isArray(inv.items));
}

function importLegacy(data, actor) {
  if (!isLegacyBackup(data)) throw new Error('الملف ليس نسخة احتياطية من نسخة المتصفح القديمة');
  const h = db.getHandle();
  const t = now();

  const legacySettings = Array.isArray(data.settings)
    ? (data.settings.find((s) => s && s.key === 'main') || {})
    : {};
  const settings = db.settingsGet();
  const merged = { ...settings };
  [
    'printerWidth', 'printerName', 'printDelay', 'printCustomer', 'printKitchen', 'autoPrint',
    'previewBeforePrint', 'copiesCustomer', 'copiesKitchen', 'storeName', 'storeAddress',
    'storePhone', 'showPhoneOnInvoice', 'showAddressOnInvoice', 'taxNumber', 'currency',
    'taxEnabled', 'taxName', 'taxRate', 'footerText', 'invoicePrefix', 'showBarcodeOnInvoice',
    'productCardWidth', 'productNameFontSize', 'productPriceFontSize', 'productImageHeight',
    'logoData', 'showLogoOnInvoice', 'autoBackupEnabled', 'backupInterval'
  ].forEach((key) => {
    if (legacySettings[key] !== undefined) merged[key] = legacySettings[key];
  });
  merged.printerName = ''; // اسم طابعة المتصفح لا معنى له في سطح المكتب
  merged.migratedFromLegacy = true;

  const tables = ['users', 'settings', 'categories', 'products', 'product_materials', 'shifts',
    'invoice_sequence', 'return_items', 'returns', 'invoices', 'invoice_items', 'holds',
    'customers', 'expenses', 'treasury', 'cash_ledger', 'receivables', 'delivery_companies', 'audit_log'];
  let invoiceCount = 0;

  h.exec('PRAGMA foreign_keys = OFF');
  try {
    h.exec('BEGIN IMMEDIATE');
    tables.forEach((table) => h.prepare(`DELETE FROM ${table}`).run());

    /* ---------- المستخدمون ---------- */
    const users = Array.isArray(data.users) && data.users.length
      ? data.users
      : [{ username: 'admin', password: 'admin123', role: 'admin', name: 'المدير' }];
    const insUser = h.prepare(`INSERT INTO users
      (username, name, role, password_hash, permissions, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)`);
    const permAll = {
      pos: true, products: true, reports: true, treasury: true, invoices: true,
      users: true, settings: true, apply_discount: true, cancel_invoice: true
    };
    const permCashier = {
      pos: true, products: false, reports: false, treasury: false, invoices: false,
      users: false, settings: false, apply_discount: false, cancel_invoice: false
    };
    users.forEach((u) => {
      const username = str(u.username || 'user', 32).toLowerCase().replace(/[^a-z0-9._-]/g, '') || `user${Math.random().toString(36).slice(2, 6)}`;
      const role = u.role === 'admin' ? 'admin' : 'cashier';
      const password = typeof u.password === 'string' && u.password ? u.password : '123456';
      const permissions = u.permissions && typeof u.permissions === 'object'
        ? u.permissions : (role === 'admin' ? permAll : permCashier);
      try {
        insUser.run(username, str(u.name || username, 80), role,
          hashPassword(password), JSON.stringify(permissions), t, t);
      } catch { /* تجاهل تكرار اسم المستخدم */ }
    });
    if (h.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin'").get().c === 0) {
      insUser.run('admin', 'المدير', 'admin', hashPassword('admin123'), JSON.stringify(permAll), t, t);
    }

    /* ---------- الإعدادات ---------- */
    h.prepare("INSERT INTO settings (key, value) VALUES ('main', ?)")
      .run(JSON.stringify({ ...db.settingsGet(), ...merged }));

    /* ---------- الفئات والأصناف ---------- */
    const cats = new Set();
    (Array.isArray(data.categories) ? data.categories : []).forEach((c) => {
      const name = typeof c === 'string' ? c : c && c.name;
      if (name) cats.add(str(name, 80));
    });
    data.products.forEach((p) => { if (p && p.category) cats.add(str(p.category, 80)); });
    const insCat = h.prepare('INSERT OR IGNORE INTO categories (name, created_at) VALUES (?, ?)');
    [...cats].filter(Boolean).forEach((c) => insCat.run(c, t));

    const insProduct = h.prepare(`INSERT INTO products
      (id, name, category, barcode, cost_price, selling_price, stock, min_stock, image, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
    let productId = 0;
    data.products.forEach((p) => {
      if (!p || !p.name) return;
      productId = Math.max(productId, num(p.id));
      const image = typeof p.image === 'string' && p.image.startsWith('data:image') ? p.image : '';
      insProduct.run(num(p.id) || null, str(p.name, 120), str(p.category || 'عام', 80),
        str(p.barcode || '', 60) || null, round2(num(p.costPrice)), round2(num(p.sellingPrice)),
        num(p.stock), num(p.minStock, 5), image, t, t);
    });

    /* ---------- الورديات ---------- */
    const insShift = h.prepare(`INSERT INTO shifts
      (id, user_id, cashier, opening_float, opened_at, closed_at, status, expected_cash,
       closing_cash, discrepancy, total_sales, cash_sales, bank_sales, credit_sales,
       total_cost, total_profit, invoice_count, cash_expenses, treasury_net)
      VALUES (?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const shiftIds = new Set();
    const legacyShifts = Array.isArray(data.shifts) ? data.shifts : [];
    legacyShifts.forEach((s) => {
      if (!s) return;
      const id = num(s.id);
      if (!id) return;
      shiftIds.add(id);
      insShift.run(id, str(s.userId || 'legacy', 32), str(s.cashier || 'مستورد', 80),
        round2(num(s.openingFloat)), num(s.openedAt, t), num(s.closedAt, t),
        round2(num(s.expectedCash)), round2(num(s.closingCash)),
        round2(num(s.discrepancy)), round2(num(s.totalSales)), round2(num(s.cashSales)),
        round2(num(s.electronicSales)), round2(num(s.creditSales)),
        round2(num(s.totalCost)), round2(num(s.totalProfit)), num(s.invoiceCount),
        0, 0);
    });
    let fallbackShift = [...shiftIds][0];
    if (!fallbackShift) {
      const res = insShift.run(null, 'legacy', 'وردية مستوردة', 0, t, t, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      fallbackShift = Number(res.lastInsertRowid);
      shiftIds.add(fallbackShift);
    }

    /* ---------- الفواتير ---------- */
    const insInvoice = h.prepare(`INSERT INTO invoices
      (id, serial, shift_id, user_id, cashier, customer_name, customer_phone, delivery_company_id, delivery_company,
       subtotal, discount, points_discount, tax, total, amount_paid, change, total_cost, profit,
       payment_method, bank_name, transfer_info, comment, status, cancel_reason, cancelled_by,
       cancelled_at, points_earned, points_redeemed, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`);
    const insItem = h.prepare(`INSERT INTO invoice_items
      (invoice_id, product_id, name, qty, selling_price, cost_price, note) VALUES (?, ?, ?, ?, ?, ?, ?)`);

    let maxSerial = 0;
    data.invoices.forEach((inv) => {
      if (!inv || !Array.isArray(inv.items) || inv.items.length === 0) return;
      const items = inv.items.map((i) => ({
        productId: num(i.productId) || null,
        name: str(i.name || 'صنف', 120),
        qty: num(i.qty, 1),
        price: round2(num(i.sellingPrice)),
        cost: round2(num(i.costPrice)),
        note: str(i.note || '', 200)
      }));
      const subtotal = round2(items.reduce((s, i) => s + i.price * i.qty, 0));
      const discount = round2(num(inv.discount));
      const tax = round2(num(inv.tax));
      const total = round2(num(inv.total, Math.max(0, subtotal - discount) + tax));
      const cost = round2(items.reduce((s, i) => s + i.cost * i.qty, 0));
      const method = ['cash', 'bank', 'credit'].includes(inv.paymentMethod) ? inv.paymentMethod : 'cash';
      const status = inv.status === 'cancelled' ? 'cancelled' : 'completed';
      const shiftId = shiftIds.has(num(inv.shiftId)) ? num(inv.shiftId) : fallbackShift;
      const serial = str(inv.serial || '', 60) || `LEG-${String(inv.id || ++invoiceCount).padStart(6, '0')}`;
      const serialNum = Number((serial.match(/(\d+)\s*$/) || [])[1] || 0);
      maxSerial = Math.max(maxSerial, serialNum);
      const res = insInvoice.run(num(inv.id) || null, serial, shiftId,
        str(inv.userId || 'legacy', 32), str(inv.cashier || 'مستورد', 80),
        str(inv.customer && inv.customer.name || '', 120) || null,
        str(inv.customer && inv.customer.phone || '', 40) || null,
        subtotal, discount, tax, total, round2(num(inv.amountPaid, total)),
        round2(num(inv.change)), cost, round2(num(inv.profit, total - discount - cost)),
        method, str(inv.bankName || '', 120), str(inv.transferInfo || '', 120),
        str(inv.invoiceComment || '', 300), status,
        str(inv.cancelReason || '', 200) || null, str(inv.cancelledBy || '', 80) || null,
        num(inv.cancelledAt) || null, num(inv.timestamp, t));
      const invoiceId = Number(res.lastInsertRowid);
      items.forEach((i) => insItem.run(invoiceId, i.productId, i.name, i.qty, i.price, i.cost, i.note));
      invoiceCount++;
    });

    /* ---------- الزبائن ---------- */
    const insCustomer = h.prepare(`INSERT OR REPLACE INTO customers (phone, name, points, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`);
    (Array.isArray(data.customers) ? data.customers : []).forEach((c) => {
      if (!c || !c.phone) return;
      insCustomer.run(str(c.phone, 40), str(c.name || '', 120), num(c.points), t, t);
    });

    /* ---------- المصروفات والخزنة ---------- */
    const insExpense = h.prepare('INSERT INTO expenses (id, description, amount, shift_id, user_id, cashier, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)');
    (Array.isArray(data.expenses) ? data.expenses : []).forEach((e) => {
      if (!e) return;
      insExpense.run(num(e.id) || null, str(e.description || 'مصروف', 200), round2(num(e.amount)),
        fallbackShift, 'legacy', str(e.cashier || '', 80), num(e.timestamp, t));
    });
    const insTreasury = h.prepare('INSERT INTO treasury (id, type, amount, reason, shift_id, user_id, cashier, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    (Array.isArray(data.treasury) ? data.treasury : []).forEach((m) => {
      if (!m) return;
      insTreasury.run(num(m.id) || null, m.type === 'out' ? 'out' : 'in', round2(num(m.amount)),
        str(m.reason || '', 200), fallbackShift, 'legacy', str(m.cashier || '', 80), num(m.timestamp, t));
    });

    /* ---------- إعادة بناء دفتر النقدية والذمم ---------- */
    const insLedger = h.prepare(`INSERT INTO cash_ledger (timestamp, shift_id, user_id, type, amount, ref_table, ref_id, note)
      VALUES (?, ?, 'legacy', ?, ?, ?, ?, ?)`);
    legacyShifts.forEach((s) => {
      const float = round2(num(s && s.openingFloat));
      if (float > 0) insLedger.run(num(s.openedAt, t), num(s.id), 'opening', float, 'shifts', num(s.id), 'عهدة افتتاحية');
    });
    const invRows = h.prepare('SELECT id, serial, total, payment_method, status, shift_id, timestamp FROM invoices').all();
    invRows.forEach((inv) => {
      if (inv.payment_method === 'cash') {
        if (inv.status === 'completed') insLedger.run(inv.timestamp, inv.shift_id, 'sale_cash', inv.total, 'invoices', inv.id, inv.serial);
        else insLedger.run(inv.timestamp, inv.shift_id, 'refund_cash', -inv.total, 'invoices', inv.id, `إلغاء ${inv.serial}`);
      }
    });
    h.prepare('SELECT id, amount, shift_id, timestamp, description FROM expenses').all()
      .forEach((e) => insLedger.run(e.timestamp, e.shift_id, 'expense', -e.amount, 'expenses', e.id, e.description));
    h.prepare('SELECT id, type, amount, shift_id, timestamp, reason FROM treasury').all()
      .forEach((m) => insLedger.run(m.timestamp, m.shift_id,
        m.type === 'in' ? 'treasury_in' : 'treasury_out',
        m.type === 'in' ? m.amount : -m.amount, 'treasury', m.id, m.reason));

    const insReceivable = h.prepare(`INSERT INTO receivables (invoice_id, customer_name, customer_phone, amount, paid, status, created_at)
      VALUES (?, ?, ?, ?, 0, 'open', ?)`);
    h.prepare("SELECT id, customer_name, customer_phone, total, timestamp FROM invoices WHERE payment_method='credit' AND status='completed'")
      .all().forEach((inv) => {
        insReceivable.run(inv.id, inv.customer_name, inv.customer_phone, inv.total, inv.timestamp);
      });

    /* ---------- تسلسل الفواتير ---------- */
    h.prepare(`INSERT INTO invoice_sequence (id, next_number) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET next_number = excluded.next_number`).run(maxSerial + 1);

    h.exec('COMMIT');
  } catch (err) {
    try { h.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    h.exec('PRAGMA foreign_keys = ON');
  }

  db.audit(actor || 'system', 'legacy_import', {
    products: data.products.length,
    invoices: invoiceCount
  });

  return {
    ok: true,
    products: data.products.length,
    invoices: invoiceCount,
    categories: db.categoriesList().length,
    users: db.usersList().length,
    balance: db.vaultBalance()
  };
}

module.exports = { isLegacyBackup, importLegacy };
