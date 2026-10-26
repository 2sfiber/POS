'use strict';
/**
 * طبقة قاعدة البيانات - SQLite محلية داخل مجلد بيانات التطبيق.
 * لا علاقة لها بالمتصفح ولا بـ IndexedDB ولا تحتاج أي خدمة خارجية.
 *
 * ملاحظات التصميم:
 *  - كل المبالغ تُحسب في العملية الرئيسية من أسعار قاعدة البيانات (لا ثقة بمدخلات الواجهة).
 *  - العمليات المركّبة (بيع / إلغاء / إغلاق وردية) تُنفَّذ داخل معاملة واحدة.
 *  - حركة النقد كلها في جدول cash_ledger بحيث لا يتضاعف رصيد الخزنة أبدًا.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./security');

const SCHEMA_VERSION = 3;
let db = null;
let dbPath = null;

/* ------------------------------- أدوات ------------------------------- */
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (n, d = 0) => {
  const v = Number(n);
  return Number.isFinite(v) ? v : d;
};
const now = () => Date.now();
const json = (s, d) => {
  try { return JSON.parse(s); } catch { return d; }
};

function ensureDb() {
  if (!db) throw new Error('قاعدة البيانات غير مفتوحة');
  return db;
}

function tx(fn) {
  const d = ensureDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

/* ------------------------------- المخطط ------------------------------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','cashier')),
  password_hash TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '{}',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  name TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT,
  barcode TEXT,
  cost_price REAL NOT NULL DEFAULT 0,
  selling_price REAL NOT NULL DEFAULT 0,
  stock REAL NOT NULL DEFAULT 0,
  min_stock REAL NOT NULL DEFAULT 5,
  image TEXT,
  has_variants INTEGER NOT NULL DEFAULT 0,
  has_options INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  cashier TEXT NOT NULL,
  opening_float REAL NOT NULL DEFAULT 0,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  expected_cash REAL,
  closing_cash REAL,
  discrepancy REAL,
  total_sales REAL DEFAULT 0,
  cash_sales REAL DEFAULT 0,
  bank_sales REAL DEFAULT 0,
  credit_sales REAL DEFAULT 0,
  total_cost REAL DEFAULT 0,
  total_profit REAL DEFAULT 0,
  invoice_count INTEGER DEFAULT 0,
  cash_expenses REAL DEFAULT 0,
  treasury_net REAL DEFAULT 0,
  z_report_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status, user_id);

CREATE TABLE IF NOT EXISTS invoice_sequence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_number INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serial TEXT NOT NULL UNIQUE,
  shift_id INTEGER NOT NULL,
  user_id TEXT,
  cashier TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  delivery_company_id INTEGER,
  delivery_company TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  points_discount REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  change REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  profit REAL NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','bank','credit')),
  bank_name TEXT,
  transfer_info TEXT,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  cancel_reason TEXT,
  cancelled_by TEXT,
  cancelled_at INTEGER,
  points_earned REAL NOT NULL DEFAULT 0,
  points_redeemed REAL NOT NULL DEFAULT 0,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_shift ON invoices(shift_id);
CREATE INDEX IF NOT EXISTS idx_invoices_ts ON invoices(timestamp);
CREATE INDEX IF NOT EXISTS idx_invoices_status_ts ON invoices(status, timestamp);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_phone);
CREATE INDEX IF NOT EXISTS idx_invoices_serial ON invoices(serial);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id INTEGER,
  name TEXT,
  qty REAL NOT NULL DEFAULT 1,
  selling_price REAL NOT NULL DEFAULT 0,
  cost_price REAL NOT NULL DEFAULT 0,
  note TEXT,
  variant_id INTEGER,
  variant_name TEXT,
  options_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_invoice ON invoice_items(invoice_id);

CREATE TABLE IF NOT EXISTS product_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cost_price REAL NOT NULL DEFAULT 0,
  selling_price REAL NOT NULL DEFAULT 0,
  stock REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);

CREATE TABLE IF NOT EXISTS product_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_options_product ON product_options(product_id);

/* الخامات الأولية (Bill of Materials): تُخزَّن بالوحدة الأساسية للعائلة (لتر/كجم/قطعة) */
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('لتر','مل','كجم','جم','قطعة')),
  stock REAL NOT NULL DEFAULT 0,
  cost_price REAL NOT NULL DEFAULT 0,
  min_stock REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS product_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  qty REAL NOT NULL,
  unit TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pm_product ON product_materials(product_id);
CREATE INDEX IF NOT EXISTS idx_pm_material ON product_materials(material_id);

/* المرتجعات: رأس + أسطر، مربوطة بالفاتورة الأصلية وبسطرها */
CREATE TABLE IF NOT EXISTS returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serial TEXT NOT NULL UNIQUE,
  invoice_id INTEGER,
  invoice_serial TEXT,
  shift_id INTEGER,
  user_id TEXT,
  cashier TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  reason TEXT,
  note TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  profit_reversal REAL NOT NULL DEFAULT 0,
  refund_method TEXT NOT NULL DEFAULT 'cash' CHECK (refund_method IN ('cash','credit','none')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_returns_invoice ON returns(invoice_id);
CREATE INDEX IF NOT EXISTS idx_returns_ts ON returns(created_at);

CREATE TABLE IF NOT EXISTS return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  invoice_item_id INTEGER,
  product_id INTEGER,
  name TEXT,
  qty REAL NOT NULL DEFAULT 0,
  selling_price REAL NOT NULL DEFAULT 0,
  cost_price REAL NOT NULL DEFAULT 0,
  variant_id INTEGER,
  variant_name TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_ritems_return ON return_items(return_id);
CREATE INDEX IF NOT EXISTS idx_ritems_item ON return_items(invoice_item_id);

CREATE TABLE IF NOT EXISTS holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  cashier TEXT,
  note TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  delivery_company_id INTEGER,
  discount REAL DEFAULT 0,
  discount_type TEXT DEFAULT 'fixed',
  payment_method TEXT DEFAULT 'cash',
  items_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cart_drafts (
  user_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  phone TEXT PRIMARY KEY,
  name TEXT,
  points REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  shift_id INTEGER,
  user_id TEXT,
  cashier TEXT,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_ts ON expenses(timestamp);

CREATE TABLE IF NOT EXISTS treasury (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('in','out')),
  amount REAL NOT NULL,
  reason TEXT,
  shift_id INTEGER,
  user_id TEXT,
  cashier TEXT,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_treasury_ts ON treasury(timestamp);

CREATE TABLE IF NOT EXISTS cash_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  shift_id INTEGER,
  user_id TEXT,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  ref_table TEXT,
  ref_id INTEGER,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_ts ON cash_ledger(timestamp);
CREATE INDEX IF NOT EXISTS idx_ledger_shift ON cash_ledger(shift_id);

CREATE TABLE IF NOT EXISTS receivables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER UNIQUE,
  customer_name TEXT,
  customer_phone TEXT,
  amount REAL NOT NULL,
  paid REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_receivables_status ON receivables(status);

CREATE TABLE IF NOT EXISTS delivery_companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  commission REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp);
`;

/* ----------------------------- الإعدادات ----------------------------- */
const DEFAULT_SETTINGS = {
  printerWidth: '80',
  printerName: '',
  printMode: 'auto',
  printerDpi: 203,
  printerDots: 0,
  feedLines: 4,
  cutFeedMm: 20,
  cutPaper: true,
  printDelay: 5,
  printCustomer: true,
  printKitchen: true,
  autoPrint: false,
  previewBeforePrint: true,
  printDialog: false,
  copiesCustomer: 1,
  copiesKitchen: 1,
  storeName: 'دونو كريم',
  storeAddress: 'عدن - المنصورة',
  storePhone: '774465817',
  showAddressOnInvoice: true,
  showPhoneOnInvoice: true,
  taxNumber: '',
  currency: 'ر.ي',
  taxEnabled: false,
  taxName: 'الضريبة',
  taxRate: 0,
  footerText: 'شكراً لزيارتكم 🌹',
  invoicePrefix: 'INV-',
  showBarcodeOnInvoice: true,
  productCardWidth: 110,
  productNameFontSize: 12,
  productPriceFontSize: 12,
  productImageHeight: 60,
  logoData: '',
  showLogoOnInvoice: true,
  autoBackupEnabled: true,
  backupInterval: 24,
  backupKeep: 30,
  lowStockAlerts: true,
  kitchenPrinterName: '',
  reportPrinterName: '',
  reportA4PrinterName: ''
};

function defaultPermissions(role) {
  const admin = {
    pos: true, products: true, reports: true, treasury: true,
    invoices: true, users: true, settings: true,
    apply_discount: true, cancel_invoice: true
  };
  if (role === 'admin') return admin;
  return {
    pos: true, products: false, reports: false, treasury: false,
    invoices: false, users: false, settings: false,
    apply_discount: false, cancel_invoice: false
  };
}

/* ------------------------- محوّلات الصفوف ------------------------- */
function mapProduct(r) {
  if (!r) return null;
  return {
    id: Number(r.id), name: r.name, category: r.category, barcode: r.barcode,
    costPrice: num(r.cost_price), sellingPrice: num(r.selling_price),
    stock: num(r.stock), minStock: num(r.min_stock, 5),
    image: r.image || '', active: !!r.active,
    hasVariants: !!r.has_variants, hasOptions: !!r.has_options,
    hasRecipe: !!r.has_recipe,
    variants: [], options: [], recipe: []
  };
}
function mapVariant(r) {
  if (!r) return null;
  return {
    id: Number(r.id), productId: Number(r.product_id), name: r.name,
    costPrice: num(r.cost_price), sellingPrice: num(r.selling_price),
    stock: num(r.stock), sortOrder: num(r.sort_order)
  };
}
function mapOption(r) {
  if (!r) return null;
  return {
    id: Number(r.id), productId: Number(r.product_id), name: r.name,
    price: num(r.price), sortOrder: num(r.sort_order)
  };
}
function mapUser(r) {
  if (!r) return null;
  return {
    username: r.username, name: r.name, role: r.role,
    permissions: json(r.permissions, defaultPermissions(r.role)),
    mustChangePassword: !!r.must_change_password
  };
}
function mapShift(r) {
  if (!r) return null;
  return {
    id: Number(r.id), userId: r.user_id, cashier: r.cashier,
    openingFloat: num(r.opening_float), openedAt: r.opened_at, closedAt: r.closed_at,
    status: r.status, expectedCash: num(r.expected_cash), closingCash: num(r.closing_cash),
    discrepancy: num(r.discrepancy), totalSales: num(r.total_sales), cashSales: num(r.cash_sales),
    bankSales: num(r.bank_sales), creditSales: num(r.credit_sales), totalCost: num(r.total_cost),
    totalProfit: num(r.total_profit), invoiceCount: num(r.invoice_count),
    cashExpenses: num(r.cash_expenses), treasuryNet: num(r.treasury_net),
    zReport: json(r.z_report_json, null)
  };
}
function mapInvoice(r, items) {
  if (!r) return null;
  return {
    id: Number(r.id), serial: r.serial, shiftId: Number(r.shift_id),
    userId: r.user_id, cashier: r.cashier,
    customer: {
      name: r.customer_name || '', phone: r.customer_phone || '',
      deliveryId: r.delivery_company_id || '', company: r.delivery_company || ''
    },
    subtotal: num(r.subtotal), discount: num(r.discount), pointsDiscount: num(r.points_discount),
    tax: num(r.tax), total: num(r.total), amountPaid: num(r.amount_paid), change: num(r.change),
    totalCost: num(r.total_cost), profit: num(r.profit),
    paymentMethod: r.payment_method, bankName: r.bank_name || '', transferInfo: r.transfer_info || '',
    comment: r.comment || '', status: r.status,
    cancelReason: r.cancel_reason || '', cancelledBy: r.cancelled_by || '', cancelledAt: r.cancelled_at,
    pointsEarned: num(r.points_earned), pointsRedeemed: num(r.points_redeemed),
    timestamp: r.timestamp,
    items: (items || []).map((it) => ({
      id: Number(it.id),
      productId: it.product_id != null ? Number(it.product_id) : null,
      name: it.name, qty: num(it.qty), sellingPrice: num(it.selling_price),
      costPrice: num(it.cost_price), note: it.note || '',
      variantId: it.variant_id != null ? Number(it.variant_id) : null,
      variantName: it.variant_name || '',
      options: json(it.options_json, []),
      materials: json(it.materials_json, [])
    }))
  };
}

/* ------------------------------ التهيئة ------------------------------ */
/* ترقية المخطط: إضافة الأعمدة الجديدة لقواعد البيانات القائمة دون فقدان بيانات. */
function migrateColumns() {
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
  const add = (table, name, ddl) => {
    if (!columns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  };
  add('products', 'has_variants', 'INTEGER NOT NULL DEFAULT 0');
  add('products', 'has_options', 'INTEGER NOT NULL DEFAULT 0');
  add('invoice_items', 'variant_id', 'INTEGER');
  add('invoice_items', 'variant_name', 'TEXT');
  add('invoice_items', 'options_json', 'TEXT');
  add('products', 'has_recipe', 'INTEGER NOT NULL DEFAULT 0');
  add('invoice_items', 'materials_json', 'TEXT');
  add('returns', 'note', 'TEXT');
}

function init(userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  dbPath = path.join(userDataDir, 'pos.db');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrateColumns();

  const version = Number(db.prepare('PRAGMA user_version').get().user_version) || 0;
  if (version < SCHEMA_VERSION) {
    // مساحة للترحيلات المستقبلية: كل ترقية تضيف خطواتها هنا دون فقدان بيانات.
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  seed();
  return dbPath;
}

function integrityCheck() {
  try {
    const row = ensureDb().prepare('PRAGMA integrity_check').get();
    const value = row ? Object.values(row)[0] : 'unknown';
    return { ok: value === 'ok', message: String(value) };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

function seed() {
  const t = now();
  const hasUsers = db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0;
  if (!hasUsers) {
    const ins = db.prepare(`INSERT INTO users
      (username, name, role, password_hash, permissions, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)`);
    ins.run('admin', 'المدير', 'admin', hashPassword('admin123'),
      JSON.stringify(defaultPermissions('admin')), t, t);
    ins.run('cashier', 'الكاشير', 'cashier', hashPassword('cashier123'),
      JSON.stringify(defaultPermissions('cashier')), t, t);
  }

  const hasSettings = db.prepare("SELECT COUNT(*) AS c FROM settings WHERE key = 'main'").get().c > 0;
  if (!hasSettings) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('main', JSON.stringify(DEFAULT_SETTINGS));
  }

  const seq = db.prepare('SELECT COUNT(*) AS c FROM invoice_sequence').get().c > 0;
  if (!seq) db.prepare('INSERT INTO invoice_sequence (id, next_number) VALUES (1, 1)').run();

  const hasCats = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c > 0;
  if (!hasCats) {
    const insCat = db.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)');
    ['برجر', 'شاورما', 'مقبلات', 'مشروبات', 'بيتزا'].forEach((c) => insCat.run(c, t));
  }

  const hasProducts = db.prepare('SELECT COUNT(*) AS c FROM products').get().c > 0;
  if (!hasProducts) {
    const ins = db.prepare(`INSERT INTO products
      (name, category, barcode, cost_price, selling_price, stock, min_stock, image, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', 1, ?, ?)`);
    const sample = [
      ['برجر لحم', 'برجر', '1001', 8, 15, 50, 10],
      ['برجر دجاج', 'برجر', '1002', 7, 13, 50, 10],
      ['شاورما دجاج', 'شاورما', '1003', 6, 12, 40, 5],
      ['شاورما لحم', 'شاورما', '1004', 9, 16, 30, 5],
      ['بطاطس مقلية', 'مقبلات', '1005', 2, 6, 100, 20],
      ['كولا', 'مشروبات', '1006', 1.5, 4, 200, 30],
      ['ماء', 'مشروبات', '1007', 0.5, 2, 200, 30],
      ['عصير برتقال', 'مشروبات', '1008', 2, 7, 80, 10],
      ['بيتزا مارغريتا', 'بيتزا', '1009', 10, 22, 20, 5],
      ['بيتزا دجاج', 'بيتزا', '1010', 12, 26, 20, 5]
    ];
    sample.forEach((p) => ins.run(p[0], p[1], p[2], p[3], p[4], p[5], p[6], t, t));
  }
}

/* ------------------------------ المستخدمون ------------------------------ */
function usersList() {
  return ensureDb().prepare('SELECT * FROM users ORDER BY role DESC, name').all().map(mapUser);
}
function userRow(username) {
  return ensureDb().prepare('SELECT * FROM users WHERE username = ?').get(String(username));
}
function userGet(username) {
  return mapUser(userRow(username));
}
function userIsFirstAdmin(username) {
  const row = userRow(username);
  return row && row.role === 'admin';
}
function userCountAdmins() {
  return ensureDb().prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
}
function userSave(data, actor) {
  const username = String(data.username || '').trim().toLowerCase();
  const name = String(data.name || '').trim();
  const role = data.role === 'admin' ? 'admin' : 'cashier';
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error('اسم المستخدم غير صالح (3-32 حرفًا إنجليزيًا)');
  if (!name) throw new Error('الاسم الظاهر مطلوب');
  const perms = data.permissions && typeof data.permissions === 'object'
    ? data.permissions : defaultPermissions(role);
  const existing = userRow(username);
  const t = now();
  if (existing) {
    if (existing.role === 'admin' && role !== 'admin' && userCountAdmins() <= 1) {
      throw new Error('لا يمكن إزالة صلاحية آخر مدير للنظام');
    }
    const fields = [];
    const params = [];
    if (data.password) {
      fields.push('password_hash = ?', 'must_change_password = 0');
      params.push(hashPassword(data.password));
    }
    fields.push('name = ?', 'role = ?', 'permissions = ?', 'updated_at = ?');
    params.push(name, role, JSON.stringify(perms), t, username);
    ensureDb().prepare(`UPDATE users SET ${fields.join(', ')} WHERE username = ?`).run(...params);
  } else {
    if (!data.password || String(data.password).length < 6) {
      throw new Error('كلمة المرور مطلوبة (6 أحرف على الأقل)');
    }
    ensureDb().prepare(`INSERT INTO users
      (username, name, role, password_hash, permissions, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(username, name, role, hashPassword(data.password), JSON.stringify(perms), t, t);
  }
  audit(actor, 'user_save', { username, role });
  return userGet(username);
}
function userDelete(username, actor) {
  if (username === 'admin') throw new Error('لا يمكن حذف حساب admin الأساسي');
  const row = userRow(username);
  if (!row) throw new Error('المستخدم غير موجود');
  if (row.role === 'admin' && userCountAdmins() <= 1) throw new Error('لا يمكن حذف آخر مدير');
  ensureDb().prepare('DELETE FROM users WHERE username = ?').run(username);
  audit(actor, 'user_delete', { username });
  return true;
}
function userSetPassword(username, password, mustChange) {
  ensureDb().prepare('UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE username = ?')
    .run(hashPassword(password), mustChange ? 1 : 0, now(), username);
}

/* ------------------------------ الإعدادات ------------------------------ */
function settingsGet() {
  const row = ensureDb().prepare("SELECT value FROM settings WHERE key = 'main'").get();
  const stored = json(row ? row.value : '{}', {});
  return { ...DEFAULT_SETTINGS, ...stored };
}
function settingsSave(patch) {
  const current = settingsGet();
  const next = { ...current };
  Object.keys(patch || {}).forEach((k) => {
    if (k === 'key') return;
    next[k] = patch[k];
  });
  ensureDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('main', JSON.stringify(next));
  return next;
}

/* --------------------- وحدات القياس والخامات (الوصفات) --------------------- */
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const UNITS = {
  'لتر': { family: 'volume', factor: 1 },
  'مل': { family: 'volume', factor: 0.001 },
  'كجم': { family: 'mass', factor: 1 },
  'جم': { family: 'mass', factor: 0.001 },
  'قطعة': { family: 'piece', factor: 1 }
};
const MATERIAL_UNITS = Object.keys(UNITS);

function unitInfo(unit) {
  const info = UNITS[String(unit || '').trim()];
  if (!info) throw new Error('وحدة قياس غير صالحة (لتر، مل، كجم، جم، قطعة)');
  return info;
}
/** تحويل كمية بين وحدتين من العائلة نفسها (200 مل → 0.2 لتر). */
function convertQty(qty, fromUnit, toUnit) {
  const from = unitInfo(fromUnit);
  const to = unitInfo(toUnit);
  if (from.family !== to.family) throw new Error(`لا يمكن تحويل «${fromUnit}» إلى «${toUnit}»`);
  return round4(Number(qty) * from.factor / to.factor);
}

function mapMaterial(r) {
  if (!r) return null;
  return {
    id: Number(r.id), name: r.name, unit: r.unit,
    stock: num(r.stock), costPrice: num(r.cost_price),
    minStock: num(r.min_stock), active: !!r.active
  };
}
function materialsList(includeInactive = false) {
  const sql = includeInactive
    ? 'SELECT * FROM materials ORDER BY name'
    : 'SELECT * FROM materials WHERE active = 1 ORDER BY name';
  return ensureDb().prepare(sql).all().map(mapMaterial);
}
function materialGet(id) {
  return mapMaterial(ensureDb().prepare('SELECT * FROM materials WHERE id = ?').get(Number(id)));
}
function materialSave(data, actor) {
  const name = String(data.name || '').trim().slice(0, 80);
  if (!name) throw new Error('اسم الخامة مطلوب');
  const unit = String(data.unit || '').trim();
  unitInfo(unit);
  const stock = round4(num(data.stock));
  const cost = round2(num(data.costPrice));
  const minStock = round4(num(data.minStock));
  if (stock < 0) throw new Error('مخزون الخامة غير صالح');
  if (cost < 0) throw new Error('تكلفة الخامة غير صالحة');
  if (minStock < 0) throw new Error('الحد الأدنى للخامة غير صالح');
  const id = Number(data.id) || 0;
  const d = ensureDb();
  const clash = d.prepare('SELECT id FROM materials WHERE name = ? AND id != ?').get(name, id);
  if (clash) throw new Error('اسم الخامة مستخدم مسبقًا');
  if (id) {
    const existing = materialGet(id);
    if (!existing) throw new Error('الخامة غير موجودة');
    if (existing.unit !== unit) {
      const used = d.prepare('SELECT COUNT(*) AS c FROM product_materials WHERE material_id = ?').get(id).c;
      if (used > 0) throw new Error('لا يمكن تغيير وحدة خامة مرتبطة بوصفة — أوقف الربط أولًا');
    }
    d.prepare('UPDATE materials SET name=?, unit=?, stock=?, cost_price=?, min_stock=?, updated_at=? WHERE id=?')
      .run(name, unit, stock, cost, minStock, now(), id);
    audit(actor, 'material_update', { id, name, unit, stock });
  } else {
    const res = d.prepare(`INSERT INTO materials (name, unit, stock, cost_price, min_stock, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(name, unit, stock, cost, minStock, now(), now());
    audit(actor, 'material_create', { id: Number(res.lastInsertRowid), name, unit, stock });
  }
  return materialsList();
}
function materialDelete(id, actor) {
  const material = materialGet(id);
  if (!material) throw new Error('الخامة غير موجودة');
  const used = ensureDb().prepare('SELECT COUNT(*) AS c FROM product_materials WHERE material_id = ?').get(Number(id)).c;
  if (used > 0) throw new Error('الخامة مرتبطة بوصفة صنف — أزلها من الوصفات أولًا');
  ensureDb().prepare('DELETE FROM materials WHERE id = ?').run(Number(id));
  audit(actor, 'material_delete', { id: Number(id), name: material.name });
  return materialsList();
}

/** أسطر وصفة الصنف مع بيانات الخامة (الوحدة والمخزون). */
function productRecipe(productId) {
  return ensureDb().prepare(`SELECT pm.*, m.name AS material_name, m.unit AS material_unit, m.stock AS material_stock
    FROM product_materials pm JOIN materials m ON m.id = pm.material_id
    WHERE pm.product_id = ? ORDER BY pm.sort_order, pm.id`).all(Number(productId))
    .map((r) => ({
      id: Number(r.id), materialId: Number(r.material_id), materialName: r.material_name,
      materialUnit: r.material_unit, stock: num(r.material_stock),
      qty: num(r.qty), unit: r.unit
    }));
}

/** تنظيم أسطر الوصفة: خامة صالحة، كمية موجبة، ووحدة من عائلة الخامة نفسها. */
function cleanRecipe(input) {
  const rows = Array.isArray(input) ? input : [];
  const seen = new Set();
  return rows.map((r, index) => {
    const materialId = Number(r && r.materialId);
    const material = materialGet(materialId);
    if (!material || !material.active) throw new Error('اختر خامة صالحة للوصفة');
    if (seen.has(materialId)) throw new Error(`الخامة مكررة في الوصفة: ${material.name}`);
    seen.add(materialId);
    const qty = num(r.qty);
    if (qty <= 0) throw new Error(`كمية الخامة «${material.name}» يجب أن تكون أكبر من صفر`);
    const unit = String(r.unit || material.unit).trim();
    convertQty(qty, unit, material.unit); // يتحقق من توافق العائلة
    return { materialId, qty: round4(qty), unit, sortOrder: index };
  });
}

function saveRecipe(productId, list) {
  const d = ensureDb();
  d.prepare('DELETE FROM product_materials WHERE product_id = ?').run(Number(productId));
  const ins = d.prepare(`INSERT INTO product_materials (product_id, material_id, qty, unit, sort_order)
    VALUES (?, ?, ?, ?, ?)`);
  list.forEach((line) => ins.run(Number(productId), line.materialId, line.qty, line.unit, line.sortOrder));
}

/** استهلاك خامات صنف واحد لكمية مبيعة — بوحدة مخزون الخامة. */
function recipeUsage(productId, qty) {
  return productRecipe(productId).map((row) => ({
    materialId: row.materialId,
    name: row.materialName,
    unit: row.materialUnit,
    qty: convertQty(row.qty * Number(qty || 0), row.unit, row.materialUnit)
  })).filter((row) => row.qty > 0);
}

/** إعادة خامات مسجّلة في لقطة سطر الفاتورة (عند الإلغاء أو المرتجع). */
function restoreMaterials(materials, ratio = 1) {
  if (!Array.isArray(materials) || !materials.length) return;
  const upd = ensureDb().prepare('UPDATE materials SET stock = ROUND(stock + ?, 4), updated_at = ? WHERE id = ?');
  materials.forEach((m) => {
    const id = Number(m && m.materialId);
    const qty = round4(num(m && m.qty) * Number(ratio || 0));
    if (id > 0 && qty > 0) upd.run(qty, now(), id);
  });
}

/* ------------------------------ الأصناف ------------------------------ */
/** إرفاق الأحجام والنكهات بكل صنف (استعلامان لكل القائمة لا لكل صنف). */
function attachProductExtras(products) {
  if (!products.length) return products;
  const d = ensureDb();
  const byId = new Map(products.map((p) => [p.id, p]));
  const materialRows = new Map(d.prepare('SELECT * FROM materials').all()
    .map((row) => [Number(row.id), row]));
  d.prepare('SELECT * FROM product_materials ORDER BY sort_order, id').all().forEach((row) => {
    const product = byId.get(Number(row.product_id));
    const material = materialRows.get(Number(row.material_id));
    if (!product || !material) return;
    product.recipe.push({
      id: Number(row.id), materialId: Number(row.material_id),
      materialName: material.name, materialUnit: material.unit,
      // مخزون الخامة وحدها الأدنى: تُستخدم في تنبيه نقص الخامات على بطاقة الصنف
      stock: num(material.stock), minStock: num(material.min_stock),
      unit: row.unit, qty: num(row.qty)
    });
  });
  d.prepare('SELECT * FROM product_variants ORDER BY sort_order, id').all().forEach((row) => {
    const product = byId.get(Number(row.product_id));
    if (product) product.variants.push(mapVariant(row));
  });
  d.prepare('SELECT * FROM product_options ORDER BY sort_order, id').all().forEach((row) => {
    const product = byId.get(Number(row.product_id));
    if (product) product.options.push(mapOption(row));
  });
  return products;
}
function productsList(includeInactive = false) {
  const sql = includeInactive
    ? 'SELECT * FROM products ORDER BY name'
    : 'SELECT * FROM products WHERE active = 1 ORDER BY name';
  return attachProductExtras(ensureDb().prepare(sql).all().map(mapProduct));
}
function productGet(id) {
  const row = ensureDb().prepare('SELECT * FROM products WHERE id = ?').get(Number(id));
  return row ? attachProductExtras([mapProduct(row)])[0] : null;
}

/** تنظيم مدخلات الأحجام: بلا حد أعلى للعدد، وبرفض القيم غير الصالحة. */
function cleanVariants(input) {
  const rows = Array.isArray(input) ? input : [];
  const seen = new Set();
  return rows.map((v, index) => {
    const name = String(v && v.name || '').trim().slice(0, 60);
    if (!name) throw new Error('اسم الحجم مطلوب');
    if (seen.has(name)) throw new Error(`اسم الحجم مكرر: ${name}`);
    seen.add(name);
    const cost = round2(num(v.costPrice));
    const price = round2(num(v.sellingPrice));
    const stock = num(v.stock);
    if (cost < 0) throw new Error(`تكلفة الحجم «${name}» غير صالحة`);
    if (price <= 0) throw new Error(`سعر بيع الحجم «${name}» يجب أن يكون أكبر من صفر`);
    if (stock < 0) throw new Error(`مخزون الحجم «${name}» غير صالح`);
    return { id: Number(v.id) || 0, name, costPrice: cost, sellingPrice: price, stock, sortOrder: index };
  });
}

/** تنظيم النكهات/الإضافات: إدخال حر بلا حد أدنى أو أعلى للعدد. */
function cleanOptions(input) {
  const rows = Array.isArray(input) ? input : [];
  const seen = new Set();
  return rows.map((o, index) => {
    const name = String(o && o.name || '').trim().slice(0, 60);
    if (!name) throw new Error('اسم النكهة/الإضافة مطلوب');
    if (seen.has(name)) throw new Error(`اسم النكهة مكرر: ${name}`);
    seen.add(name);
    const price = round2(num(o.price));
    if (price < 0) throw new Error(`سعر الإضافة «${name}» غير صالح`);
    return { id: Number(o.id) || 0, name, price, sortOrder: index };
  });
}

function saveVariants(productId, list) {
  const d = ensureDb();
  const keep = new Set();
  for (const v of list) {
    if (v.id) {
      const res = d.prepare(`UPDATE product_variants SET name=?, cost_price=?, selling_price=?, stock=?,
        sort_order=?, updated_at=? WHERE id=? AND product_id=?`)
        .run(v.name, v.costPrice, v.sellingPrice, v.stock, v.sortOrder, now(), v.id, productId);
      if (res.changes === 1) { keep.add(v.id); continue; }
    }
    const res = d.prepare(`INSERT INTO product_variants
      (product_id, name, cost_price, selling_price, stock, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(productId, v.name, v.costPrice, v.sellingPrice, v.stock, v.sortOrder, now(), now());
    keep.add(Number(res.lastInsertRowid));
  }
  for (const row of d.prepare('SELECT id FROM product_variants WHERE product_id = ?').all(productId)) {
    if (!keep.has(Number(row.id))) d.prepare('DELETE FROM product_variants WHERE id = ?').run(Number(row.id));
  }
}

function saveOptions(productId, list) {
  const d = ensureDb();
  const keep = new Set();
  for (const o of list) {
    if (o.id) {
      const res = d.prepare('UPDATE product_options SET name=?, price=?, sort_order=? WHERE id=? AND product_id=?')
        .run(o.name, o.price, o.sortOrder, o.id, productId);
      if (res.changes === 1) { keep.add(o.id); continue; }
    }
    const res = d.prepare('INSERT INTO product_options (product_id, name, price, sort_order, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(productId, o.name, o.price, o.sortOrder, now());
    keep.add(Number(res.lastInsertRowid));
  }
  for (const row of d.prepare('SELECT id FROM product_options WHERE product_id = ?').all(productId)) {
    if (!keep.has(Number(row.id))) d.prepare('DELETE FROM product_options WHERE id = ?').run(Number(row.id));
  }
}

function productsSave(data, actor) {
  const name = String(data.name || '').trim();
  if (!name) throw new Error('اسم الصنف مطلوب');
  const category = String(data.category || '').trim();
  if (!category) throw new Error('الفئة مطلوبة');
  const hasVariants = !!data.hasVariants;
  const hasOptions = !!data.hasOptions;
  const hasRecipe = !!data.hasRecipe;
  const variants = hasVariants ? cleanVariants(data.variants) : [];
  if (hasVariants && variants.length === 0) {
    throw new Error('أضف حجمًا واحدًا على الأقل أو أوقف خيار الأحجام');
  }
  const options = hasOptions ? cleanOptions(data.options) : [];
  if (hasOptions && options.length === 0) {
    throw new Error('أضف نكهة/إضافة واحدة على الأقل أو أوقف خيار النكهات');
  }
  const recipe = hasRecipe ? cleanRecipe(data.recipe) : [];
  if (hasRecipe && recipe.length === 0) {
    throw new Error('أضف خامة واحدة على الأقل أو أوقف ربط الوصفة');
  }
  let cost;
  let price;
  let stock;
  if (hasVariants) {
    // الحقول العامة تُلغى: المخزون مجموع الأحجام، والتكلفة متوسط مرجّح، والسعر أقل سعر.
    const totalStock = round2(variants.reduce((sum, v) => sum + v.stock, 0));
    const stockCost = variants.reduce((sum, v) => sum + v.stock * v.costPrice, 0);
    cost = totalStock > 0
      ? round2(stockCost / totalStock)
      : round2(Math.min(...variants.map((v) => v.costPrice)));
    price = round2(Math.min(...variants.map((v) => v.sellingPrice)));
    stock = totalStock;
  } else {
    cost = round2(num(data.costPrice));
    price = round2(num(data.sellingPrice));
    stock = num(data.stock);
    if (cost < 0) throw new Error('سعر التكلفة غير صالح');
    if (price <= 0) throw new Error('سعر البيع يجب أن يكون أكبر من صفر');
    if (stock < 0) throw new Error('الكمية غير صالحة');
  }
  const minStock = num(data.minStock, 5);
  let barcode = String(data.barcode || '').trim() || null;
  if (barcode) {
    const clash = ensureDb().prepare('SELECT id FROM products WHERE barcode = ? AND id != ?')
      .get(barcode, Number(data.id) || 0);
    if (clash) throw new Error('الباركود مستخدم لصنف آخر');
  }
  const image = typeof data.image === 'string' && data.image.startsWith('data:image/') ? data.image : '';
  const t = now();
  let id = Number(data.id) || 0;
  if (id) {
    const existing = productGet(id);
    if (!existing) throw new Error('الصنف غير موجود');
  }
  tx(() => {
    if (id) {
      const existing = productGet(id);
      ensureDb().prepare(`UPDATE products SET name=?, category=?, barcode=?, cost_price=?, selling_price=?,
        stock=?, min_stock=?, image=?, has_variants=?, has_options=?, has_recipe=?, active=1, updated_at=? WHERE id=?`)
        .run(name, category, barcode, cost, price, stock, minStock,
          image || existing.image || '', hasVariants ? 1 : 0, hasOptions ? 1 : 0, hasRecipe ? 1 : 0, t, id);
      audit(actor, 'product_update', { id, name, hasVariants, hasOptions, hasRecipe });
    } else {
      const res = ensureDb().prepare(`INSERT INTO products
        (name, category, barcode, cost_price, selling_price, stock, min_stock, image,
         has_variants, has_options, has_recipe, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(name, category, barcode, cost, price, stock, minStock, image,
          hasVariants ? 1 : 0, hasOptions ? 1 : 0, hasRecipe ? 1 : 0, t, t);
      id = Number(res.lastInsertRowid);
      audit(actor, 'product_create', { id, name, hasVariants, hasOptions, hasRecipe });
    }
    saveVariants(id, variants);
    saveOptions(id, options);
    saveRecipe(id, recipe);
  });
  return productGet(id);
}
function productsDelete(id, actor) {
  const product = productGet(id);
  if (!product) throw new Error('الصنف غير موجود');
  const used = ensureDb().prepare('SELECT COUNT(*) AS c FROM invoice_items WHERE product_id = ?').get(Number(id)).c > 0;
  if (used) {
    // لا نحذف صنفًا له تاريخ مبيعات: نُخفيه فقط حفاظًا على التقارير.
    ensureDb().prepare('UPDATE products SET active = 0, updated_at = ? WHERE id = ?').run(now(), Number(id));
  } else {
    ensureDb().prepare('DELETE FROM product_variants WHERE product_id = ?').run(Number(id));
    ensureDb().prepare('DELETE FROM product_options WHERE product_id = ?').run(Number(id));
    ensureDb().prepare('DELETE FROM products WHERE id = ?').run(Number(id));
  }
  audit(actor, 'product_delete', { id: Number(id), name: product.name, hidden: used });
  return { hidden: used };
}

/* ------------------------------ الفئات ------------------------------ */
function categoriesList() {
  return ensureDb().prepare('SELECT name FROM categories ORDER BY name').all().map((r) => r.name);
}
function categoryAdd(name, actor) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('اسم الفئة مطلوب');
  const exists = ensureDb().prepare('SELECT name FROM categories WHERE name = ?').get(clean);
  if (exists) throw new Error('الفئة موجودة بالفعل');
  ensureDb().prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)').run(clean, now());
  audit(actor, 'category_add', { name: clean });
  return categoriesList();
}
function categoryDelete(name, actor) {
  const used = ensureDb().prepare('SELECT COUNT(*) AS c FROM products WHERE category = ? AND active = 1').get(name).c;
  if (used > 0) throw new Error('لا يمكن حذف فئة تحتوي أصنافًا');
  ensureDb().prepare('DELETE FROM categories WHERE name = ?').run(name);
  audit(actor, 'category_delete', { name });
  return categoriesList();
}

/* ------------------------------ الورديات ------------------------------ */
function shiftActive(userId) {
  const row = ensureDb().prepare("SELECT * FROM shifts WHERE status = 'active' AND user_id = ? ORDER BY id DESC LIMIT 1")
    .get(String(userId));
  return mapShift(row);
}
function shiftGet(id) {
  return mapShift(ensureDb().prepare('SELECT * FROM shifts WHERE id = ?').get(Number(id)));
}
function shiftOpen(user, openingFloat) {
  const existing = shiftActive(user.username);
  if (existing) return existing;
  const float = round2(Math.max(0, num(openingFloat)));
  const t = now();
  return tx(() => {
    const res = ensureDb().prepare(`INSERT INTO shifts (user_id, cashier, opening_float, opened_at, status)
      VALUES (?, ?, ?, ?, 'active')`).run(user.username, user.name, float, t);
    const id = Number(res.lastInsertRowid);
    if (float > 0) {
      ledgerAdd({ type: 'opening', amount: float, shiftId: id, userId: user.username, note: 'عهدة افتتاحية' });
    }
    audit(user.username, 'shift_open', { shiftId: id, float });
    return shiftGet(id);
  });
}
function shiftSummary(shiftId) {
  const rows = ensureDb().prepare(`SELECT payment_method, COUNT(*) AS c, SUM(total) AS total,
      SUM(total_cost) AS cost, SUM(profit) AS profit
    FROM invoices WHERE shift_id = ? AND status = 'completed' GROUP BY payment_method`).all(Number(shiftId));
  const agg = { cash: 0, bank: 0, credit: 0, count: 0, total: 0, cost: 0, profit: 0 };
  rows.forEach((r) => {
    agg[r.payment_method] = num(r.total);
    agg.count += num(r.c);
    agg.total += num(r.total);
    agg.cost += num(r.cost);
    agg.profit += num(r.profit);
  });
  const expected = num(ensureDb().prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM cash_ledger WHERE shift_id = ?')
    .get(Number(shiftId)).s);
  const expenses = num(ensureDb().prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE shift_id = ?')
    .get(Number(shiftId)).s);
  const tIn = num(ensureDb().prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM treasury WHERE shift_id = ? AND type = 'in'")
    .get(Number(shiftId)).s);
  const tOut = num(ensureDb().prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM treasury WHERE shift_id = ? AND type = 'out'")
    .get(Number(shiftId)).s);
  const returnRow = ensureDb().prepare('SELECT COUNT(*) AS c, COALESCE(SUM(total), 0) AS total FROM returns WHERE shift_id = ?')
    .get(Number(shiftId));
  const returnsTotal = round2(num(returnRow.total));
  const shift = shiftGet(shiftId);
  return {
    openingFloat: shift ? shift.openingFloat : 0,
    totalSales: round2(agg.total),
    cashSales: round2(agg.cash),
    bankSales: round2(agg.bank),
    creditSales: round2(agg.credit),
    totalCost: round2(agg.cost),
    totalProfit: round2(agg.profit),
    invoiceCount: agg.count,
    cashExpenses: round2(expenses),
    treasuryIn: round2(tIn),
    treasuryOut: round2(tOut),
    treasuryNet: round2(tIn - tOut),
    returnsCount: num(returnRow.c),
    returnsTotal,
    netSales: round2(agg.total - returnsTotal),
    expectedCash: round2(expected)
  };
}
function shiftClose(shiftId, actualCash, user) {
  const shift = shiftGet(shiftId);
  if (!shift) throw new Error('الوردية غير موجودة');
  if (shift.status !== 'active') throw new Error('الوردية مغلقة بالفعل');
  const summary = shiftSummary(shiftId);
  const actual = round2(num(actualCash));
  const discrepancy = round2(actual - summary.expectedCash);
  return tx(() => {
    ensureDb().prepare(`UPDATE shifts SET status='closed', closed_at=?, expected_cash=?, closing_cash=?,
      discrepancy=?, total_sales=?, cash_sales=?, bank_sales=?, credit_sales=?, total_cost=?, total_profit=?,
      invoice_count=?, cash_expenses=?, treasury_net=?, z_report_json=? WHERE id=?`)
      .run(now(), summary.expectedCash, actual, discrepancy, summary.totalSales, summary.cashSales,
        summary.bankSales, summary.creditSales, summary.totalCost, summary.totalProfit,
        summary.invoiceCount, summary.cashExpenses, summary.treasuryNet,
        JSON.stringify({ ...summary, actual, discrepancy }), Number(shiftId));
    audit(user && user.username, 'shift_close', { shiftId: Number(shiftId), discrepancy });
    return {
      ...shiftGet(shiftId),
      returnsCount: summary.returnsCount,
      returnsTotal: summary.returnsTotal,
      netSales: summary.netSales
    };
  });
}

/* ------------------------------ النقد ------------------------------ */
function ledgerAdd({ type, amount, shiftId = null, userId = null, refTable = null, refId = null, note = '', timestamp = null }) {
  ensureDb().prepare(`INSERT INTO cash_ledger (timestamp, shift_id, user_id, type, amount, ref_table, ref_id, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(timestamp || now(), shiftId, userId, type, round2(amount), refTable, refId, note || '');
}

function vaultBalance() {
  return round2(num(ensureDb().prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM cash_ledger').get().s));
}

/* ------------------------------ الزبائن والولاء ------------------------------ */
function customerGet(phone) {
  const row = ensureDb().prepare('SELECT * FROM customers WHERE phone = ?').get(String(phone));
  if (!row) return null;
  return { phone: row.phone, name: row.name || '', points: num(row.points) };
}
function customerSave(phone, name) {
  const p = String(phone || '').trim();
  if (!p) throw new Error('رقم الهاتف مطلوب');
  const t = now();
  ensureDb().prepare(`INSERT INTO customers (phone, name, points, created_at, updated_at)
    VALUES (?, ?, 0, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET name = CASE WHEN excluded.name != '' THEN excluded.name ELSE customers.name END,
      updated_at = excluded.updated_at`)
    .run(p, String(name || '').trim(), t, t);
  return customerGet(p);
}

/* ------------------------------ الفواتير ------------------------------ */
function invoiceItems(invoiceId) {
  return ensureDb().prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(Number(invoiceId));
}
function invoiceGet(id) {
  const row = ensureDb().prepare('SELECT * FROM invoices WHERE id = ?').get(Number(id));
  return mapInvoice(row, row ? invoiceItems(row.id) : []);
}
function nextSerial(prefix) {
  const row = ensureDb().prepare('SELECT next_number FROM invoice_sequence WHERE id = 1').get();
  const n = Number(row ? row.next_number : 1);
  ensureDb().prepare('UPDATE invoice_sequence SET next_number = ? WHERE id = 1').run(n + 1);
  return `${prefix || 'INV-'}${String(n).padStart(6, '0')}`;
}
/**
 * إنشاء فاتورة: كل المبالغ تُحسب من أسعار قاعدة البيانات.
 * payload: { items:[{productId, qty, note}], discountType, discountValue,
 *            paymentMethod, amountPaid, customer:{name, phone, deliveryId}, comment, bankName, transferInfo }
 */
function invoiceCreate(payload, user) {
  const shift = shiftActive(user.username);
  if (!shift) throw new Error('يجب فتح وردية أولاً');
  const settings = settingsGet();
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) throw new Error('السلة فارغة');

  return tx(() => {
    const lines = [];
    let subtotal = 0;
    let totalCost = 0;
    for (const raw of items) {
      const qty = num(raw.qty);
      if (qty <= 0) throw new Error('كمية غير صالحة');
      const prod = ensureDb().prepare('SELECT * FROM products WHERE id = ?').get(Number(raw.productId));
      if (!prod || !prod.active) throw new Error('صنف غير موجود أو محذوف');
      let variant = null;
      let price = num(prod.selling_price);
      let cost = num(prod.cost_price);
      if (prod.has_variants) {
        variant = ensureDb().prepare('SELECT * FROM product_variants WHERE id = ? AND product_id = ?')
          .get(Number(raw.variantId), Number(prod.id));
        if (!variant) throw new Error(`اختر حجمًا صالحًا للصنف: ${prod.name}`);
        if (num(variant.stock) < qty) throw new Error(`مخزون الحجم «${variant.name}» غير كافٍ: ${prod.name}`);
        price = num(variant.selling_price);
        cost = num(variant.cost_price);
      } else if (num(prod.stock) < qty) {
        throw new Error(`المخزون غير كافٍ: ${prod.name}`);
      }
      // النكهات/الإضافات: تُتحقق من قاعدة البيانات ويُضاف سعرها إلى سعر الوحدة
      const optionIds = Array.isArray(raw.optionIds)
        ? raw.optionIds.map((v) => Number(v)).filter((v) => v > 0) : [];
      const opts = [];
      if (optionIds.length) {
        const findOption = ensureDb().prepare('SELECT * FROM product_options WHERE id = ? AND product_id = ?');
        for (const optionId of optionIds) {
          const row = findOption.get(optionId, Number(prod.id));
          if (!row) throw new Error(`نكهة غير صالحة للصنف: ${prod.name}`);
          if (!opts.some((o) => o.id === Number(row.id))) {
            opts.push({ id: Number(row.id), name: String(row.name), price: round2(num(row.price)) });
          }
        }
        price += opts.reduce((sum, o) => sum + o.price, 0);
      }
      subtotal += price * qty;
      totalCost += cost * qty;
      lines.push({
        productId: Number(prod.id), name: prod.name, qty,
        sellingPrice: round2(price), costPrice: round2(cost),
        variantId: variant ? Number(variant.id) : null,
        variantName: variant ? String(variant.name) : '',
        options: opts,
        materials: recipeUsage(prod.id, qty),
        note: String(raw.note || '').trim().slice(0, 200)
      });
    }
    subtotal = round2(subtotal);
    totalCost = round2(totalCost);

    /* الوصفات: تجميع استهلاك الخامات والتحقق من كفايتها قبل الخصم */
    const materialTotals = new Map();
    lines.forEach((line) => line.materials.forEach((use) => {
      const current = materialTotals.get(use.materialId) || { name: use.name, unit: use.unit, qty: 0 };
      current.qty = round4(current.qty + use.qty);
      materialTotals.set(use.materialId, current);
    }));
    for (const [materialId, use] of materialTotals) {
      const row = ensureDb().prepare('SELECT * FROM materials WHERE id = ?').get(materialId);
      if (!row) throw new Error(`خامة الوصفة غير موجودة: ${use.name}`);
      if (num(row.stock) < use.qty) {
        throw new Error(`مخزون الخامة «${use.name}» غير كافٍ (المطلوب ${use.qty} ${use.unit} — المتاح ${num(row.stock)})`);
      }
    }

    // الخصم
    const type = payload.discountType === 'percent' ? 'percent' : 'fixed';
    const discount = type === 'percent'
      ? round2(subtotal * Math.min(Math.max(num(payload.discountValue), 0), 100) / 100)
      : round2(Math.min(Math.max(num(payload.discountValue), 0), subtotal));

    // نظام الولاء أُزيل بالكامل: لا خصم نقاط ولا نقاط مكتسبة
    const phone = String(payload.customer && payload.customer.phone || '').trim();
    let customer = phone ? customerGet(phone) : null;

    const taxable = round2(Math.max(0, subtotal - discount));
    const taxRate = settings.taxEnabled ? num(settings.taxRate) : 0;
    const tax = round2(taxable * taxRate / 100);
    const total = round2(taxable + tax);
    const profit = round2(taxable - totalCost);

    const method = ['cash', 'bank', 'credit'].includes(payload.paymentMethod) ? payload.paymentMethod : 'cash';
    let amountPaid = round2(num(payload.amountPaid, total));
    if (method === 'cash') {
      if (amountPaid < total) throw new Error('المبلغ المدفوع أقل من المطلوب');
    } else {
      amountPaid = total;
    }
    const change = round2(amountPaid - total);

    // خصم المخزون داخل نفس المعاملة
    const updStock = ensureDb().prepare('UPDATE products SET stock = stock - ?, updated_at = ? WHERE id = ? AND stock >= ?');
    const updVariant = ensureDb().prepare('UPDATE product_variants SET stock = stock - ?, updated_at = ? WHERE id = ? AND stock >= ?');
    for (const line of lines) {
      const res = updStock.run(line.qty, now(), line.productId, line.qty);
      if (res.changes !== 1) throw new Error(`تعذّر خصم المخزون للصنف: ${line.name}`);
      if (line.variantId) {
        const vres = updVariant.run(line.qty, now(), line.variantId, line.qty);
        if (vres.changes !== 1) throw new Error(`تعذّر خصم مخزون الحجم: ${line.name}`);
      }
    }

    /* خصم الخامات المستهلكة وفق الوصفة (لحظيًّا داخل نفس المعاملة) */
    const updMaterial = ensureDb().prepare('UPDATE materials SET stock = ROUND(stock - ?, 4), updated_at = ? WHERE id = ? AND stock >= ?');
    for (const [materialId, use] of materialTotals) {
      const mres = updMaterial.run(use.qty, now(), materialId, use.qty);
      if (mres.changes !== 1) throw new Error(`تعذّر خصم مخزون الخامة: ${use.name}`);
    }

    const serial = nextSerial(settings.invoicePrefix);
    const t = now();
    const deliveryId = payload.customer && payload.customer.deliveryId ? Number(payload.customer.deliveryId) : null;
    let deliveryName = '';
    if (deliveryId) {
      const dc = ensureDb().prepare('SELECT name FROM delivery_companies WHERE id = ?').get(deliveryId);
      deliveryName = dc ? dc.name : '';
    }

    const res = ensureDb().prepare(`INSERT INTO invoices
      (serial, shift_id, user_id, cashier, customer_name, customer_phone, delivery_company_id, delivery_company,
       subtotal, discount, points_discount, tax, total, amount_paid, change, total_cost, profit,
       payment_method, bank_name, transfer_info, comment, status, points_earned, points_redeemed, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`)
      .run(serial, shift.id, user.username, user.name,
        String(payload.customer && payload.customer.name || '').trim().slice(0, 120),
        phone || null, deliveryId, deliveryName,
        subtotal, discount, 0, tax, total, amountPaid, change, totalCost, profit,
        method, String(payload.bankName || '').slice(0, 120), String(payload.transferInfo || '').slice(0, 120),
        String(payload.comment || '').slice(0, 300),
        0, 0, t);
    const invoiceId = Number(res.lastInsertRowid);

    const insItem = ensureDb().prepare(`INSERT INTO invoice_items
      (invoice_id, product_id, name, qty, selling_price, cost_price, note,
       variant_id, variant_name, options_json, materials_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    lines.forEach((l) => insItem.run(invoiceId, l.productId, l.name, l.qty, l.sellingPrice, l.costPrice, l.note,
      l.variantId, l.variantName || null, l.options.length ? JSON.stringify(l.options) : null,
      l.materials.length ? JSON.stringify(l.materials) : null));

    // قيود النقد
    if (method === 'cash') {
      ledgerAdd({
        type: 'sale_cash', amount: total, shiftId: shift.id, userId: user.username,
        refTable: 'invoices', refId: invoiceId, note: serial
      });
    } else if (method === 'credit') {
      ensureDb().prepare(`INSERT INTO receivables (invoice_id, customer_name, customer_phone, amount, paid, status, created_at)
        VALUES (?, ?, ?, ?, 0, 'open', ?)`)
        .run(invoiceId, String(payload.customer && payload.customer.name || '').trim() || null, phone || null, total, t);
    }

    // العميل: يُنشأ أو يُحدَّث اسمه فقط (نظام الولاء ونقاطه أُزيل بالكامل)
    if (phone) {
      const name = String(payload.customer && payload.customer.name || '').trim();
      if (!customer) {
        ensureDb().prepare('INSERT INTO customers (phone, name, points, created_at, updated_at) VALUES (?, ?, 0, ?, ?)')
          .run(phone, name, t, t);
      } else {
        ensureDb().prepare('UPDATE customers SET updated_at = ?, name = COALESCE(NULLIF(?, \'\'), name) WHERE phone = ?')
          .run(t, name, phone);
      }
    }

    audit(user.username, 'invoice_create', { invoiceId, serial, total, method });
    return invoiceGet(invoiceId);
  });
}

function invoiceCancel(id, reason, user) {
  const invoice = invoiceGet(id);
  if (!invoice) throw new Error('الفاتورة غير موجودة');
  if (invoice.status === 'cancelled') throw new Error('الفاتورة ملغاة مسبقًا');

  /* ترابط الفواتير بالمرتجعات:
   * الإلغاء يُعيد كامل المخزون ويعكس كامل النقد، بينما المرتجع أعاد جزءًا فعلًا.
   * السماح بالإلغاء هنا يعني إضافة المخزون والنقد مرتين — لذلك نمنعه برسالة واضحة.
   */
  const returnsCount = num(ensureDb().prepare('SELECT COUNT(*) AS c FROM returns WHERE invoice_id = ?')
    .get(invoice.id).c);
  if (returnsCount > 0) {
    throw new Error(
      `لا يمكن إلغاء فاتورة عليها ${returnsCount} مرتجع — ` +
      'الإلغاء سيُعيد المخزون ويعكس النقد مرتين. راجع شاشة المرتجعات.'
    );
  }

  return tx(() => {
    // إرجاع المخزون
    const upd = ensureDb().prepare('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?');
    const updVariant = ensureDb().prepare('UPDATE product_variants SET stock = stock + ?, updated_at = ? WHERE id = ?');
    invoice.items.forEach((it) => {
      if (it.productId) upd.run(it.qty, now(), it.productId);
      if (it.variantId) updVariant.run(it.qty, now(), it.variantId);
      // إعادة خامات الوصفة التي استُهلكت مع هذا السطر
      restoreMaterials(it.materials, 1);
    });

    // عكس النقد
    if (invoice.paymentMethod === 'cash') {
      ledgerAdd({
        type: 'refund_cash', amount: -invoice.total, shiftId: invoice.shiftId, userId: user.username,
        refTable: 'invoices', refId: invoice.id, note: `إلغاء ${invoice.serial}`
      });
    }
    if (invoice.paymentMethod === 'credit') {
      const rec = ensureDb().prepare('SELECT * FROM receivables WHERE invoice_id = ?').get(invoice.id);
      if (rec && num(rec.paid) > 0) {
        throw new Error('لا يمكن إلغاء فاتورة آجلة تم تحصيل جزء منها. سجّل مرتجعًا بدلًا من ذلك.');
      }
      ensureDb().prepare("UPDATE receivables SET status = 'cancelled' WHERE invoice_id = ?").run(invoice.id);
    }

    // نقاط الولاء أُزيلت: لا شيء يُعكس هنا

    ensureDb().prepare(`UPDATE invoices SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?, cancelled_at = ?
      WHERE id = ?`).run(String(reason || '').slice(0, 200), user.name, now(), invoice.id);
    audit(user.username, 'invoice_cancel', { invoiceId: invoice.id, serial: invoice.serial, reason });
    return invoiceGet(invoice.id);
  });
}

/* ------------------------------ المرتجعات ------------------------------ */
function mapReturn(r, items) {
  if (!r) return null;
  return {
    id: Number(r.id), serial: r.serial,
    invoiceId: r.invoice_id != null ? Number(r.invoice_id) : null,
    invoiceSerial: r.invoice_serial || '', shiftId: r.shift_id,
    userId: r.user_id, cashier: r.cashier || '',
    customer: { name: r.customer_name || '', phone: r.customer_phone || '' },
    reason: r.reason || '', note: r.note || '',
    subtotal: num(r.subtotal), total: num(r.total), totalCost: num(r.total_cost),
    profitReversal: num(r.profit_reversal), refundMethod: r.refund_method,
    timestamp: r.created_at,
    items: (items || []).map((it) => ({
      id: Number(it.id), invoiceItemId: it.invoice_item_id != null ? Number(it.invoice_item_id) : null,
      productId: it.product_id != null ? Number(it.product_id) : null,
      name: it.name || '', qty: num(it.qty), sellingPrice: num(it.selling_price),
      costPrice: num(it.cost_price), variantId: it.variant_id != null ? Number(it.variant_id) : null,
      variantName: it.variant_name || '', reason: it.reason || ''
    }))
  };
}
function returnItems(returnId) {
  return ensureDb().prepare('SELECT * FROM return_items WHERE return_id = ? ORDER BY id').all(Number(returnId));
}
function returnGet(id) {
  const row = ensureDb().prepare('SELECT * FROM returns WHERE id = ?').get(Number(id));
  return mapReturn(row, row ? returnItems(row.id) : []);
}
function returnsForInvoice(invoiceId) {
  return ensureDb().prepare('SELECT * FROM returns WHERE invoice_id = ? ORDER BY id DESC').all(Number(invoiceId))
    .map((r) => mapReturn(r, returnItems(r.id)));
}
/** الفاتورة مع الكميات القابلة للإرجاع (المبيعة − المرتجعة سابقًا). */
function returnableInvoice(invoiceId) {
  const invoice = invoiceGet(invoiceId);
  if (!invoice) return null;
  const used = new Map(ensureDb().prepare(`SELECT ri.invoice_item_id AS item_id, COALESCE(SUM(ri.qty), 0) AS qty
    FROM return_items ri JOIN returns r ON r.id = ri.return_id
    WHERE r.invoice_id = ? GROUP BY ri.invoice_item_id`).all(invoice.id)
    .map((r) => [Number(r.item_id), num(r.qty)]));
  invoice.items = invoice.items.map((it) => {
    const returned = used.get(it.id) || 0;
    return { ...it, returnedQty: round4(returned), returnableQty: round4(Math.max(0, it.qty - returned)) };
  });
  return invoice;
}
function returnsFind(term) {
  const q = String(term || '').trim();
  if (!q) return null;
  const d = ensureDb();
  let row = d.prepare("SELECT id FROM invoices WHERE status = 'completed' AND serial = ? COLLATE NOCASE").get(q);
  if (!row && /^\d+$/.test(q)) row = d.prepare("SELECT id FROM invoices WHERE status = 'completed' AND id = ?").get(Number(q));
  if (!row) {
    row = d.prepare("SELECT id FROM invoices WHERE status = 'completed' AND serial LIKE ? ORDER BY id DESC LIMIT 1")
      .get(`%${q}%`);
  }
  if (!row) {
    // البحث بالباركود: أحدث فاتورة تحتوي هذا الصنف
    const prod = d.prepare('SELECT id FROM products WHERE barcode = ?').get(q);
    if (prod) {
      row = d.prepare(`SELECT i.id FROM invoices i JOIN invoice_items it ON it.invoice_id = i.id
        WHERE i.status = 'completed' AND it.product_id = ? ORDER BY i.id DESC LIMIT 1`).get(Number(prod.id));
    }
  }
  if (!row) return null;
  const invoice = returnableInvoice(row.id);
  return { invoice, previous: returnsForInvoice(row.id) };
}

function returnsList(filter = {}) {
  const where = [];
  const params = [];
  if (filter.from) { where.push('created_at >= ?'); params.push(Number(filter.from)); }
  if (filter.to) { where.push('created_at <= ?'); params.push(Number(filter.to)); }
  if (filter.invoiceId) { where.push('invoice_id = ?'); params.push(Number(filter.invoiceId)); }
  const limit = Math.min(Math.max(Number(filter.limit) || 500, 1), 5000);
  const rows = ensureDb().prepare(`SELECT * FROM returns ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT ?`).all(...params, limit);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const items = ensureDb().prepare(`SELECT * FROM return_items WHERE return_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);
  const grouped = new Map();
  items.forEach((it) => {
    if (!grouped.has(it.return_id)) grouped.set(it.return_id, []);
    grouped.get(it.return_id).push(it);
  });
  return rows.map((r) => mapReturn(r, grouped.get(r.id) || []));
}

function returnsSummary(from, to) {
  const f = Number(from) || 0;
  const t = Number(to) || now();
  const d = ensureDb();
  const row = d.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(total), 0) AS total,
      COALESCE(SUM(total_cost), 0) AS cost, COALESCE(SUM(profit_reversal), 0) AS profit
    FROM returns WHERE created_at BETWEEN ? AND ?`).get(f, t);
  const byMethod = d.prepare(`SELECT refund_method AS method, COUNT(*) AS c, SUM(total) AS total
    FROM returns WHERE created_at BETWEEN ? AND ? GROUP BY refund_method`).all(f, t)
    .map((r) => ({ method: r.method, count: num(r.c), total: round2(num(r.total)) }));
  const byDay = d.prepare(`SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
      COUNT(*) AS c, SUM(total) AS total FROM returns WHERE created_at BETWEEN ? AND ?
    GROUP BY day ORDER BY day DESC LIMIT 31`).all(f, t)
    .map((r) => ({ day: r.day, count: num(r.c), total: round2(num(r.total)) }));
  const topItems = d.prepare(`SELECT ri.name, SUM(ri.qty) AS qty, SUM(ri.qty * ri.selling_price) AS total
    FROM return_items ri JOIN returns r ON r.id = ri.return_id
    WHERE r.created_at BETWEEN ? AND ? GROUP BY ri.name ORDER BY qty DESC LIMIT 10`).all(f, t)
    .map((r) => ({ name: r.name, qty: round4(num(r.qty)), total: round2(num(r.total)) }));
  return {
    count: num(row.c), total: round2(num(row.total)), cost: round2(num(row.cost)),
    profitReversal: round2(num(row.profit)), byMethod, byDay, topItems
  };
}

/**
 * تسجيل مرتجع: يتحقق من الكميات المتاحة، يعيد مخزون الصنف/الحجم/الخامات،
 * ويكتب القيد العكسي (نقدي من الخزنة أو تخفيض ذمة آجلة) داخل معاملة واحدة.
 */
function returnsCreate(payload, user) {
  const invoice = invoiceGet(Number(payload.invoiceId));
  if (!invoice) throw new Error('الفاتورة غير موجودة');
  if (invoice.status !== 'completed') throw new Error('لا يمكن الإرجاع من فاتورة ملغاة');
  const requested = Array.isArray(payload.items) ? payload.items : [];
  const d = ensureDb();
  const usedRow = d.prepare(`SELECT ri.invoice_item_id AS item_id, COALESCE(SUM(ri.qty), 0) AS qty
    FROM return_items ri JOIN returns r ON r.id = ri.return_id
    WHERE r.invoice_id = ? GROUP BY ri.invoice_item_id`);
  const used = new Map(usedRow.all(invoice.id).map((r) => [Number(r.item_id), num(r.qty)]));
  const rows = [];
  const requestedTotals = new Map();
  let goods = 0;
  let cost = 0;
  for (const raw of requested) {
    const itemId = Number(raw.invoiceItemId);
    const item = invoice.items.find((it) => it.id === itemId);
    if (!item) throw new Error('سطر فاتورة غير صالح');
    const qty = round4(num(raw.qty));
    if (qty <= 0) continue;
    const available = round4(item.qty - (used.get(itemId) || 0));
    const already = round4(requestedTotals.get(itemId) || 0);
    if (round4(already + qty) > available + 1e-6) {
      throw new Error(`الكمية المرتجعة أكبر من المتاح للصنف «${item.name}» (${available})`);
    }
    requestedTotals.set(itemId, round4(already + qty));
    goods += item.sellingPrice * qty;
    cost += item.costPrice * qty;
    rows.push({
      invoiceItemId: itemId, productId: item.productId, name: item.name, qty,
      sellingPrice: item.sellingPrice, costPrice: item.costPrice,
      variantId: item.variantId, variantName: item.variantName,
      materials: Array.isArray(item.materials) ? item.materials : [],
      invoiceQty: item.qty,
      reason: String(raw.reason || payload.reason || '').trim().slice(0, 120)
    });
  }
  if (!rows.length) throw new Error('اختر صنفًا واحدًا على الأقل بكمية صحيحة');
  // النسبة تطبّق خصم/ضريبة الفاتورة الأصلية حتى يكون الصافي المسترد مطابقًا
  const ratio = invoice.subtotal > 0 ? invoice.total / invoice.subtotal : 1;
  const subtotal = round2(goods);
  const total = round2(goods * ratio);
  const totalCost = round2(cost);
  const method = ['cash', 'credit', 'none'].includes(payload.refundMethod) ? payload.refundMethod : 'cash';
  const shift = shiftActive(user.username);
  if (!shift) throw new Error('يجب فتح وردية أولاً لتسجيل المرتجع');
  let receivable = null;
  if (method === 'credit') {
    receivable = d.prepare('SELECT * FROM receivables WHERE invoice_id = ?').get(invoice.id);
    if (!receivable) throw new Error('الفاتورة ليست آجلة — اختر استردادًا نقديًا أو بدون استرداد');
    if (receivable.status !== 'open') throw new Error('ذمة الفاتورة مغلقة — لا يمكن خصم المرتجع منها');
  }

  return tx(() => {
    const updProduct = d.prepare('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?');
    const updVariant = d.prepare('UPDATE product_variants SET stock = stock + ?, updated_at = ? WHERE id = ?');
    rows.forEach((line) => {
      if (line.productId) updProduct.run(line.qty, now(), line.productId);
      if (line.variantId) updVariant.run(line.qty, now(), line.variantId);
      // إعادة الخامات المستهلكة بنسبة الكمية المرتجعة من سطر الفاتورة
      restoreMaterials(line.materials, line.invoiceQty > 0 ? line.qty / line.invoiceQty : 0);
    });

    const nextNo = Number(d.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM returns').get().n);
    const serial = `RET-${String(nextNo).padStart(6, '0')}`;
    const res = d.prepare(`INSERT INTO returns
      (serial, invoice_id, invoice_serial, shift_id, user_id, cashier, customer_name, customer_phone,
       reason, note, subtotal, total, total_cost, profit_reversal, refund_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(serial, invoice.id, invoice.serial, shift.id, user.username, user.name,
        invoice.customer.name || null, invoice.customer.phone || null,
        String(payload.reason || '').slice(0, 120), String(payload.note || '').slice(0, 300),
        subtotal, total, totalCost, round2(total - totalCost), method, now());
    const returnId = Number(res.lastInsertRowid);
    const insItem = d.prepare(`INSERT INTO return_items
      (return_id, invoice_item_id, product_id, name, qty, selling_price, cost_price, variant_id, variant_name, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    rows.forEach((line) => insItem.run(returnId, line.invoiceItemId, line.productId, line.name,
      line.qty, line.sellingPrice, line.costPrice, line.variantId || null, line.variantName || null, line.reason));

    // القيد المحاسبي العكسي
    if (method === 'cash' && total > 0) {
      ledgerAdd({
        type: 'refund_cash', amount: -total, shiftId: shift.id, userId: user.username,
        refTable: 'returns', refId: returnId, note: `مرتجع ${serial} — فاتورة ${invoice.serial}`
      });
    } else if (method === 'credit' && receivable) {
      const paid = num(receivable.paid);
      const nextAmount = Math.max(paid, round2(num(receivable.amount) - total));
      const status = paid >= nextAmount - 0.005 ? 'paid' : 'open';
      d.prepare('UPDATE receivables SET amount = ?, status = ?, settled_at = ? WHERE id = ?')
        .run(nextAmount, status, status === 'paid' ? now() : null, Number(receivable.id));
    }
    audit(user.username, 'return_create', {
      returnId, serial, invoiceId: invoice.id, invoiceSerial: invoice.serial, total, method
    });
    return returnGet(returnId);
  });
}

/* فلتر التصنيف: الفواتير التي تحتوي صنفًا واحدًا على الأقل من هذا التصنيف */
function categoryFilterSql(alias, category) {
  const name = String(category || '').trim();
  if (!name) return null;
  return {
    sql: `${alias}.id IN (SELECT it.invoice_id FROM invoice_items it JOIN products p ON p.id = it.product_id WHERE p.category = ?)`,
    params: [name]
  };
}

function invoicesList(filter = {}) {
  const where = [];
  const params = [];
  if (filter.from) { where.push('timestamp >= ?'); params.push(Number(filter.from)); }
  if (filter.to) { where.push('timestamp <= ?'); params.push(Number(filter.to)); }
  if (filter.paymentMethod) { where.push('payment_method = ?'); params.push(filter.paymentMethod); }
  if (filter.status) { where.push('status = ?'); params.push(filter.status); }
  if (filter.shiftId) { where.push('shift_id = ?'); params.push(Number(filter.shiftId)); }
  const cat = categoryFilterSql('invoices', filter.category);
  if (cat) { where.push(cat.sql); params.push(...cat.params); }
  if (Array.isArray(filter.ids) && filter.ids.length) {
    const ids = filter.ids.map((v) => Number(v)).filter((v) => Number.isFinite(v)).slice(0, 2000);
    if (ids.length) {
      where.push(`id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
  }
  if (filter.search) {
    const q = `%${String(filter.search).trim()}%`;
    where.push('(serial LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)');
    params.push(q, q, q);
  }
  const limit = Math.min(Math.max(Number(filter.limit) || 500, 1), 5000);
  const sql = `SELECT * FROM invoices ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT ?`;
  const rows = ensureDb().prepare(sql).all(...params, limit);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const itemRows = ensureDb().prepare(`SELECT * FROM invoice_items WHERE invoice_id IN (${placeholders}) ORDER BY id`).all(...ids);
  const grouped = new Map();
  itemRows.forEach((it) => {
    if (!grouped.has(it.invoice_id)) grouped.set(it.invoice_id, []);
    grouped.get(it.invoice_id).push(it);
  });
  return rows.map((r) => mapInvoice(r, grouped.get(r.id) || []));
}

function reportsSummary(from, to, category) {
  const d = ensureDb();
  const fromTs = Number(from) || 0;
  const toTs = Number(to) || now();
  const cat = categoryFilterSql('invoices', category);
  const catSql = cat ? ` AND ${cat.sql}` : '';
  const catParams = cat ? cat.params : [];
  const rows = d.prepare(`SELECT payment_method, status, COUNT(*) AS c, SUM(total) AS total,
      SUM(total_cost) AS cost, SUM(profit) AS profit, SUM(tax) AS tax, SUM(discount) AS discount
    FROM invoices WHERE timestamp BETWEEN ? AND ?${catSql} GROUP BY payment_method, status`)
    .all(fromTs, toTs, ...catParams);
  const out = {
    sales: 0, cost: 0, profit: 0, tax: 0, discount: 0, count: 0,
    cash: 0, bank: 0, credit: 0, cancelledCount: 0, cancelledTotal: 0
  };
  rows.forEach((r) => {
    if (r.status === 'completed') {
      out.sales += num(r.total);
      out.cost += num(r.cost);
      out.profit += num(r.profit);
      out.tax += num(r.tax);
      out.discount += num(r.discount);
      out.count += num(r.c);
      out[r.payment_method] = (out[r.payment_method] || 0) + num(r.total);
    } else {
      out.cancelledCount += num(r.c);
      out.cancelledTotal += num(r.total);
    }
  });
  out.expenses = round2(num(d.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM expenses WHERE timestamp BETWEEN ? AND ?')
    .get(fromTs, toTs).s));
  // المرتجعات تُطرح من صافي المبيعات والربح (القيمة والعدد)
  const ret = d.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(total), 0) AS total,
      COALESCE(SUM(total_cost), 0) AS cost FROM returns WHERE created_at BETWEEN ? AND ?`).get(fromTs, toTs);
  out.returnsCount = num(ret.c);
  out.returnsTotal = round2(num(ret.total));
  out.returnsCost = round2(num(ret.cost));
  out.netSales = round2(out.sales - out.returnsTotal);
  out.netProfit = round2(out.profit - (out.returnsTotal - out.returnsCost) - out.expenses);
  ['sales', 'cost', 'profit', 'tax', 'discount', 'cash', 'bank', 'credit', 'cancelledTotal', 'expenses',
    'returnsTotal', 'returnsCost', 'netSales', 'netProfit']
    .forEach((k) => { out[k] = round2(out[k]); });
  // أكثر الأصناف: عند اختيار تصنيف نعرض أصناف هذا التصنيف فقط
  const topCatSql = cat ? ' AND it.product_id IN (SELECT id FROM products WHERE category = ?)' : '';
  const topCatParams = cat ? cat.params : [];
  out.topProducts = d.prepare(`SELECT it.name, SUM(it.qty) AS qty, SUM(it.qty * it.selling_price) AS total,
      SUM(it.qty * (it.selling_price - it.cost_price)) AS profit
    FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
    WHERE i.status = 'completed' AND i.timestamp BETWEEN ? AND ?${topCatSql}
    GROUP BY it.name ORDER BY qty DESC LIMIT 10`).all(fromTs, toTs, ...topCatParams)
    .map((r) => ({ name: r.name, qty: num(r.qty), total: round2(num(r.total)), profit: round2(num(r.profit)) }));
  out.byDay = d.prepare(`SELECT strftime('%Y-%m-%d', timestamp/1000, 'unixepoch', 'localtime') AS day,
      SUM(total) AS total, SUM(profit) AS profit, COUNT(*) AS count
    FROM invoices WHERE status='completed' AND timestamp BETWEEN ? AND ?${catSql}
    GROUP BY day ORDER BY day DESC LIMIT 31`).all(fromTs, toTs, ...catParams)
    .map((r) => ({ day: r.day, total: round2(num(r.total)), profit: round2(num(r.profit)), count: num(r.count) }));
  return out;
}

/* -------------------- تحليلات متقدمة (تصنيفات، عروض، ساعات، عملاء) -------------------- */
function reportsAdvanced(from, to, category) {
  const f = Number(from) || 0;
  const t = Number(to) || now();
  const d = ensureDb();
  const cat = categoryFilterSql('i', category);
  const catSql = cat ? ` AND ${cat.sql}` : '';
  const catParams = cat ? cat.params : [];

  const byCategory = d.prepare(`SELECT COALESCE(NULLIF(p.category, ''), 'عام') AS category,
      SUM(it.qty) AS qty, SUM(it.qty * it.selling_price) AS total,
      SUM(it.qty * (it.selling_price - it.cost_price)) AS profit,
      COUNT(DISTINCT i.id) AS invoices
    FROM invoice_items it
    JOIN invoices i ON i.id = it.invoice_id
    LEFT JOIN products p ON p.id = it.product_id
    WHERE i.status = 'completed' AND i.timestamp BETWEEN ? AND ?${cat ? ' AND p.category = ?' : ''}
    GROUP BY category ORDER BY total DESC`).all(f, t, ...catParams)
    .map((r) => ({
      category: r.category, qty: num(r.qty), total: round2(num(r.total)),
      profit: round2(num(r.profit)), invoices: num(r.invoices)
    }));

  const byPayment = d.prepare(`SELECT payment_method, COUNT(*) AS c, SUM(total) AS total
    FROM invoices i WHERE status = 'completed' AND timestamp BETWEEN ? AND ?${catSql}
    GROUP BY payment_method`).all(f, t, ...catParams)
    .map((r) => ({ method: r.payment_method, count: num(r.c), total: round2(num(r.total)) }));

  const byHour = d.prepare(`SELECT strftime('%H', timestamp / 1000, 'unixepoch', 'localtime') AS hour,
      COUNT(*) AS c, SUM(total) AS total
    FROM invoices i WHERE status = 'completed' AND timestamp BETWEEN ? AND ?${catSql}
    GROUP BY hour ORDER BY hour`).all(f, t, ...catParams)
    .map((r) => ({ hour: String(r.hour || '').padStart(2, '0'), count: num(r.c), total: round2(num(r.total)) }));

  const byWeekday = d.prepare(`SELECT strftime('%w', timestamp / 1000, 'unixepoch', 'localtime') AS wd,
      COUNT(*) AS c, SUM(total) AS total
    FROM invoices i WHERE status = 'completed' AND timestamp BETWEEN ? AND ?${catSql}
    GROUP BY wd ORDER BY wd`).all(f, t, ...catParams)
    .map((r) => ({ weekday: num(r.wd), count: num(r.c), total: round2(num(r.total)) }));

  const topCustomers = d.prepare(`SELECT COALESCE(NULLIF(customer_name, ''), 'عميل نقدي') AS name,
      MAX(customer_phone) AS phone, COUNT(*) AS c, SUM(total) AS total, MAX(timestamp) AS last_at
    FROM invoices i WHERE status = 'completed' AND timestamp BETWEEN ? AND ?${catSql}
    GROUP BY COALESCE(NULLIF(customer_phone, ''), NULLIF(customer_name, ''), 'cash')
    ORDER BY total DESC LIMIT 15`).all(f, t, ...catParams)
    .map((r) => ({
      name: r.name, phone: r.phone || '', count: num(r.c),
      total: round2(num(r.total)), lastAt: r.last_at
    }));

  const offers = d.prepare(`SELECT COUNT(*) AS invoices,
      COALESCE(SUM(CASE WHEN discount > 0 THEN 1 ELSE 0 END), 0) AS discounted,
      COALESCE(SUM(discount), 0) AS discount_total,
      COALESCE(SUM(points_discount), 0) AS points_total,
      COALESCE(SUM(points_redeemed), 0) AS points_used
    FROM invoices i WHERE status = 'completed' AND timestamp BETWEEN ? AND ?${catSql}`).get(f, t, ...catParams);

  const totals = d.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(total), 0) AS total, COALESCE(SUM(profit), 0) AS profit
    FROM invoices i WHERE status = 'completed' AND timestamp BETWEEN ? AND ?${catSql}`).get(f, t, ...catParams);

  // قيمة المخزون تُحسب من الأحجام عند تفعيلها، ومن الصنف نفسه خلاف ذلك
  const stock = d.prepare(`SELECT
      (SELECT COUNT(*) FROM products WHERE active = 1) AS items,
      (SELECT COALESCE(SUM(stock), 0) FROM products WHERE active = 1) AS units,
      (SELECT COALESCE(SUM(stock * cost_price), 0) FROM products
        WHERE active = 1 AND has_variants = 0)
      + (SELECT COALESCE(SUM(v.stock * v.cost_price), 0) FROM product_variants v
        JOIN products p ON p.id = v.product_id WHERE p.active = 1) AS cost_value,
      (SELECT COALESCE(SUM(stock * selling_price), 0) FROM products
        WHERE active = 1 AND has_variants = 0)
      + (SELECT COALESCE(SUM(v.stock * v.selling_price), 0) FROM product_variants v
        JOIN products p ON p.id = v.product_id WHERE p.active = 1) AS sale_value,
      (SELECT COUNT(*) FROM products
        WHERE active = 1 AND has_variants = 0 AND stock <= min_stock)
      + (SELECT COUNT(*) FROM product_variants v
        JOIN products p ON p.id = v.product_id
        WHERE p.active = 1 AND v.stock <= p.min_stock) AS low_count`).get();

  const count = num(totals.c);
  const sales = round2(num(totals.total));
  return {
    byCategory, byPayment, byHour, byWeekday, topCustomers,
    offers: {
      invoices: num(offers.invoices),
      discounted: num(offers.discounted),
      discountTotal: round2(num(offers.discount_total)),
      pointsTotal: round2(num(offers.points_total)),
      pointsUsed: round2(num(offers.points_used))
    },
    avgTicket: count ? round2(sales / count) : 0,
    stock: {
      items: num(stock.items), units: num(stock.units),
      costValue: round2(num(stock.cost_value)), saleValue: round2(num(stock.sale_value)),
      lowCount: num(stock.low_count)
    }
  };
}

/* -------------------- أداء الموظفين والمستخدمين -------------------- */
function reportsStaff(from, to, category) {
  const f = Number(from) || 0;
  const t = Number(to) || now();
  const d = ensureDb();
  const cat = categoryFilterSql('invoices', category);
  const catSql = cat ? ` AND ${cat.sql}` : '';
  const catParams = cat ? cat.params : [];
  const invoices = d.prepare(`SELECT user_id, cashier,
      COUNT(*) AS total_count,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
      COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN total ELSE 0 END), 0) AS sales,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN profit ELSE 0 END), 0) AS profit,
      MAX(timestamp) AS last_at
    FROM invoices WHERE timestamp BETWEEN ? AND ?${catSql}
    GROUP BY user_id`).all(f, t, ...catParams);
  const shifts = d.prepare(`SELECT user_id, cashier,
      COUNT(*) AS shifts,
      COALESCE(SUM(CASE WHEN status = 'closed' THEN COALESCE(closed_at, ?) - opened_at ELSE ? - opened_at END), 0) AS ms
    FROM shifts WHERE opened_at BETWEEN ? AND ?
    GROUP BY user_id`).all(t, t, f, t);
  const returnRows = d.prepare(`SELECT user_id, cashier, COUNT(*) AS c, COALESCE(SUM(total), 0) AS total
    FROM returns WHERE created_at BETWEEN ? AND ? GROUP BY user_id`).all(f, t);

  const users = d.prepare('SELECT username, name, role FROM users').all();
  const byUser = new Map();
  const entry = (id, cashier) => {
    const key = String(id || 'unknown');
    if (!byUser.has(key)) {
      const u = users.find((x) => x.username === key);
      byUser.set(key, {
        userId: key,
        name: (u && u.name) || cashier || key,
        role: (u && u.role) || '',
        invoices: 0, completed: 0, cancelled: 0, sales: 0, profit: 0,
        returnsCount: 0, returnsTotal: 0,
        shifts: 0, hours: 0, lastAt: 0
      });
    }
    return byUser.get(key);
  };
  invoices.forEach((r) => {
    const row = entry(r.user_id, r.cashier);
    row.invoices += num(r.total_count);
    row.completed += num(r.completed);
    row.cancelled += num(r.cancelled);
    row.sales += num(r.sales);
    row.profit += num(r.profit);
    row.lastAt = Math.max(row.lastAt, num(r.last_at));
  });
  shifts.forEach((r) => {
    const row = entry(r.user_id, r.cashier);
    row.shifts += num(r.shifts);
    row.hours += num(r.ms) / 3600000;
  });
  returnRows.forEach((r) => {
    const row = entry(r.user_id, r.cashier);
    row.returnsCount += num(r.c);
    row.returnsTotal += num(r.total);
  });
  const totalSales = [...byUser.values()].reduce((s, r) => s + Math.max(0, r.sales - r.returnsTotal), 0);
  return [...byUser.values()]
    .map((r) => ({
      ...r,
      sales: round2(r.sales),
      returnsTotal: round2(r.returnsTotal),
      netSales: round2(r.sales - r.returnsTotal),
      profit: round2(r.profit),
      hours: Math.round(r.hours * 100) / 100,
      avgInvoice: r.completed ? round2(r.sales / r.completed) : 0,
      cancelRate: r.invoices ? Math.round((r.cancelled / r.invoices) * 1000) / 10 : 0,
      share: totalSales ? Math.round((Math.max(0, r.sales - r.returnsTotal) / totalSales) * 1000) / 10 : 0,
      salesPerHour: r.hours > 0 ? round2(r.sales / r.hours) : 0
    }))
    .sort((a, b) => b.netSales - a.netSales);
}

/* ------------------------------ المعلّقة ------------------------------ */
function mapHold(r) {
  return {
    id: Number(r.id), userId: r.user_id, cashier: r.cashier, note: r.note || '',
    customer: { name: r.customer_name || '', phone: r.customer_phone || '', deliveryId: r.delivery_company_id || '' },
    discount: num(r.discount), discountType: r.discount_type, paymentMethod: r.payment_method,
    items: json(r.items_json, []), timestamp: r.created_at
  };
}
function holdsList(userId) {
  if (userId) {
    return ensureDb().prepare('SELECT * FROM holds WHERE user_id = ? ORDER BY id DESC').all(String(userId)).map(mapHold);
  }
  return ensureDb().prepare('SELECT * FROM holds ORDER BY id DESC').all().map(mapHold);
}
function holdsAdd(payload, user) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) throw new Error('لا يمكن تعليق سلة فارغة');
  const res = ensureDb().prepare(`INSERT INTO holds
    (user_id, cashier, note, customer_name, customer_phone, delivery_company_id, discount, discount_type, payment_method, items_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(user.username, user.name, String(payload.note || '').slice(0, 200),
      String(payload.customer && payload.customer.name || '').slice(0, 120),
      String(payload.customer && payload.customer.phone || ''),
      payload.customer && payload.customer.deliveryId ? Number(payload.customer.deliveryId) : null,
      num(payload.discount), payload.discountType === 'percent' ? 'percent' : 'fixed',
      ['cash', 'bank', 'credit'].includes(payload.paymentMethod) ? payload.paymentMethod : 'cash',
      JSON.stringify(items.map((i) => ({
        productId: Number(i.productId), name: String(i.name || ''), qty: num(i.qty),
        sellingPrice: num(i.sellingPrice), costPrice: num(i.costPrice), note: String(i.note || ''),
        variantId: Number(i.variantId) || null,
        variantName: String(i.variantName || ''),
        options: Array.isArray(i.options)
          ? i.options.map((o) => ({ id: Number(o.id) || 0, name: String(o.name || ''), price: num(o.price) }))
          : []
      }))), now());
  audit(user.username, 'hold_add', { holdId: Number(res.lastInsertRowid) });
  return mapHold(ensureDb().prepare('SELECT * FROM holds WHERE id = ?').get(Number(res.lastInsertRowid)));
}
/* --------------------- مسودّة السلة (استعادة بعد إغلاق مفاجئ) --------------------- */
function cartDraftGet(userId) {
  const row = ensureDb().prepare('SELECT * FROM cart_drafts WHERE user_id = ?').get(String(userId));
  if (!row) return null;
  const data = json(row.payload_json, null);
  if (!data || !Array.isArray(data.items) || data.items.length === 0) return null;
  return { ...data, savedAt: row.updated_at };
}
function cartDraftSave(userId, payload) {
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  const clean = items
    .map((it) => ({
      productId: Number(it.productId),
      variantId: Number(it.variantId) || null,
      optionIds: Array.isArray(it.optionIds) ? it.optionIds.map((v) => Number(v) || 0).filter((v) => v > 0) : [],
      qty: num(it.qty),
      note: String((it && it.note) || '').slice(0, 160)
    }))
    .filter((it) => Number.isFinite(it.productId) && it.productId > 0 && it.qty > 0)
    .slice(0, 300);
  if (!clean.length) return cartDraftClear(userId);
  const customer = (payload && payload.customer) || {};
  const data = {
    items: clean,
    discountType: payload.discountType === 'percent' ? 'percent' : 'fixed',
    discountValue: Math.max(0, round2(num(payload.discountValue))),
    pointsRedeemed: Math.max(0, Math.floor(num(payload.pointsRedeemed))),
    paymentMethod: ['cash', 'bank', 'credit'].includes(payload.paymentMethod) ? payload.paymentMethod : 'cash',
    customer: {
      name: String(customer.name || '').slice(0, 120),
      phone: String(customer.phone || '').slice(0, 40),
      deliveryId: String(customer.deliveryId || '').slice(0, 20)
    }
  };
  ensureDb().prepare(`INSERT INTO cart_drafts (user_id, payload_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`)
    .run(String(userId), JSON.stringify(data), now());
  return { items: clean.reduce((sum, it) => sum + it.qty, 0) };
}
function cartDraftClear(userId) {
  ensureDb().prepare('DELETE FROM cart_drafts WHERE user_id = ?').run(String(userId));
  return { items: 0 };
}
function holdsDelete(id) {
  ensureDb().prepare('DELETE FROM holds WHERE id = ?').run(Number(id));
  return true;
}

/** محو جميع الفواتير المعلقة التابعة لمستخدم عند تبديل الجلسة أو الخروج النهائي. */
function holdsClearForUser(userId) {
  ensureDb().prepare('DELETE FROM holds WHERE user_id = ?').run(String(userId));
  return true;
}

/* ------------------------------ المصروفات والخزنة ------------------------------ */
function expensesList(from, to) {
  const rows = Number(from) || Number(to)
    ? ensureDb().prepare('SELECT * FROM expenses WHERE timestamp BETWEEN ? AND ? ORDER BY id DESC')
      .all(Number(from) || 0, Number(to) || now())
    : ensureDb().prepare('SELECT * FROM expenses ORDER BY id DESC').all();
  return rows.map((r) => ({
    id: Number(r.id), description: r.description, amount: num(r.amount),
    shiftId: r.shift_id, cashier: r.cashier, timestamp: r.timestamp
  }));
}
function expenseAdd(payload, user) {
  const description = String(payload.description || '').trim();
  const amount = round2(num(payload.amount));
  if (!description) throw new Error('بيان المصروف مطلوب');
  if (amount <= 0) throw new Error('المبلغ غير صالح');
  const shift = shiftActive(user.username);
  return tx(() => {
    const res = ensureDb().prepare(`INSERT INTO expenses (description, amount, shift_id, user_id, cashier, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)`).run(description.slice(0, 200), amount, shift ? shift.id : null, user.username, user.name, now());
    ledgerAdd({
      type: 'expense', amount: -amount, shiftId: shift ? shift.id : null, userId: user.username,
      refTable: 'expenses', refId: Number(res.lastInsertRowid), note: description
    });
    audit(user.username, 'expense_add', { amount, description });
    return { id: Number(res.lastInsertRowid) };
  });
}
function expenseDelete(id, user) {
  const row = ensureDb().prepare('SELECT * FROM expenses WHERE id = ?').get(Number(id));
  if (!row) throw new Error('المصروف غير موجود');
  return tx(() => {
    ensureDb().prepare('DELETE FROM expenses WHERE id = ?').run(Number(id));
    ledgerAdd({
      type: 'expense_reversal', amount: num(row.amount), shiftId: row.shift_id, userId: user.username,
      refTable: 'expenses', refId: Number(id), note: 'حذف مصروف'
    });
    audit(user.username, 'expense_delete', { id: Number(id), amount: num(row.amount) });
    return true;
  });
}
function treasuryList(limit = 300) {
  return ensureDb().prepare('SELECT * FROM treasury ORDER BY id DESC LIMIT ?').all(Number(limit)).map((r) => ({
    id: Number(r.id), type: r.type, amount: num(r.amount), reason: r.reason || '',
    cashier: r.cashier, timestamp: r.timestamp
  }));
}
function treasuryAdd(payload, user) {
  const type = payload.type === 'out' ? 'out' : 'in';
  const amount = round2(num(payload.amount));
  const reason = String(payload.reason || '').trim();
  if (amount <= 0) throw new Error('المبلغ غير صالح');
  if (!reason) throw new Error('سبب الحركة مطلوب');
  const shift = shiftActive(user.username);
  return tx(() => {
    const res = ensureDb().prepare(`INSERT INTO treasury (type, amount, reason, shift_id, user_id, cashier, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(type, amount, reason.slice(0, 200), shift ? shift.id : null, user.username, user.name, now());
    ledgerAdd({
      type: type === 'in' ? 'treasury_in' : 'treasury_out', amount: type === 'in' ? amount : -amount,
      shiftId: shift ? shift.id : null, userId: user.username,
      refTable: 'treasury', refId: Number(res.lastInsertRowid), note: reason
    });
    audit(user.username, 'treasury_' + type, { amount, reason });
    return { id: Number(res.lastInsertRowid) };
  });
}

/* ------------------------------ الذمم (الآجل) ------------------------------ */
function receivablesList(status) {
  const rows = status
    ? ensureDb().prepare(`SELECT r.*, i.serial, i.timestamp FROM receivables r
        JOIN invoices i ON i.id = r.invoice_id WHERE r.status = ? ORDER BY r.id DESC`).all(status)
    : ensureDb().prepare(`SELECT r.*, i.serial, i.timestamp FROM receivables r
        JOIN invoices i ON i.id = r.invoice_id ORDER BY r.id DESC`).all();
  return rows.map((r) => ({
    id: Number(r.id), invoiceId: Number(r.invoice_id), serial: r.serial,
    customerName: r.customer_name || '', customerPhone: r.customer_phone || '',
    amount: num(r.amount), paid: num(r.paid), remaining: round2(num(r.amount) - num(r.paid)),
    status: r.status, createdAt: r.created_at, settledAt: r.settled_at
  }));
}
function receivableSettle(id, amount, user) {
  const rec = ensureDb().prepare('SELECT * FROM receivables WHERE id = ?').get(Number(id));
  if (!rec) throw new Error('الذمة غير موجودة');
  if (rec.status !== 'open') throw new Error('هذه الذمة مغلقة');
  const remaining = round2(num(rec.amount) - num(rec.paid));
  const value = round2(num(amount, remaining));
  if (value <= 0) throw new Error('المبلغ غير صالح');
  if (value > remaining) throw new Error('المبلغ أكبر من المتبقي');
  const shift = shiftActive(user.username);
  return tx(() => {
    const paid = round2(num(rec.paid) + value);
    const status = paid >= num(rec.amount) - 0.001 ? 'paid' : 'open';
    ensureDb().prepare('UPDATE receivables SET paid = ?, status = ?, settled_at = ? WHERE id = ?')
      .run(paid, status, status === 'paid' ? now() : null, Number(id));
    ledgerAdd({
      type: 'receivable_payment', amount: value, shiftId: shift ? shift.id : null, userId: user.username,
      refTable: 'receivables', refId: Number(id), note: 'تحصيل آجل'
    });
    audit(user.username, 'receivable_settle', { id: Number(id), value });
    return { paid, status, remaining: round2(num(rec.amount) - paid) };
  });
}

/* ------------------------------ شركات التوصيل ------------------------------ */
function deliveryList() {
  return ensureDb().prepare('SELECT * FROM delivery_companies ORDER BY name').all().map((r) => ({
    id: Number(r.id), name: r.name, commission: num(r.commission), active: !!r.active
  }));
}
function deliverySave(data, user) {
  const name = String(data.name || '').trim();
  if (!name) throw new Error('اسم الشركة مطلوب');
  const commission = Math.max(0, Math.min(100, num(data.commission)));
  if (data.id) {
    ensureDb().prepare('UPDATE delivery_companies SET name = ?, commission = ? WHERE id = ?')
      .run(name, commission, Number(data.id));
  } else {
    ensureDb().prepare('INSERT INTO delivery_companies (name, commission, active) VALUES (?, ?, 1)')
      .run(name, commission);
  }
  audit(user.username, 'delivery_save', { name, commission });
  return deliveryList();
}
function deliveryDelete(id, user) {
  ensureDb().prepare('DELETE FROM delivery_companies WHERE id = ?').run(Number(id));
  audit(user.username, 'delivery_delete', { id: Number(id) });
  return deliveryList();
}

/* ------------------------------ التدقيق ------------------------------ */
function audit(userId, action, details) {
  try {
    ensureDb().prepare('INSERT INTO audit_log (timestamp, user_id, action, details) VALUES (?, ?, ?, ?)')
      .run(now(), userId || 'system', action, JSON.stringify(details || {}));
  } catch { /* لا نُفشل العملية بسبب سجل التدقيق */ }
}
/* -------------------- تصفير المعاملات (مع الإبقاء على الإعدادات) -------------------- */
/**
 * الجداول التي تُحذف عند التصفير: كل ما يخص الحركة اليومية.
 * يبقى دائمًا: settings و users و products و categories و delivery_companies و customers.
 */
const DATA_TABLES = [
  'return_items', 'returns', 'invoice_items', 'invoices', 'holds', 'receivables', 'expenses',
  'treasury', 'cash_ledger', 'shifts', 'audit_log', 'cart_drafts'
];

function resetData(userId) {
  const d = ensureDb();
  const removed = {};
  tx(() => {
    for (const table of DATA_TABLES) {
      const info = d.prepare(`DELETE FROM ${table}`).run();
      removed[table] = Number(info.changes) || 0;
    }
    // نقاط الولاء وحدها تُصفَّر للعملاء (يبقى العميل وبياناته للتواصل)
    d.prepare('UPDATE customers SET points = 0, updated_at = ?').run(now());
    // مخزون الأصناف يُصفَّر أيضًا (يبدأ كل صنف وكل حجم من الصفر بعد التصفير)
    d.prepare('UPDATE products SET stock = 0, updated_at = ?').run(now());
    d.prepare('UPDATE product_variants SET stock = 0, updated_at = ?').run(now());
    d.prepare('UPDATE materials SET stock = 0, updated_at = ?').run(now());
    // إعادة العدّادات التلقائية من الصفر حتى تبدأ الفواتير بترقيم جديد
    d.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${DATA_TABLES.map(() => '?').join(',')})`)
      .run(...DATA_TABLES);
    d.prepare("INSERT INTO invoice_sequence (id, next_number) VALUES (1, 1) " +
      'ON CONFLICT(id) DO UPDATE SET next_number = 1').run();
  });
  audit(userId, 'data_reset', removed);
  return {
    removed,
    stockReset: true,
    kept: ['settings', 'users', 'products', 'categories', 'customers', 'delivery_companies']
  };
}

function auditList(limit = 300) {
  return ensureDb().prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(Number(limit)).map((r) => ({
    id: Number(r.id), timestamp: r.timestamp, userId: r.user_id, action: r.action,
    details: json(r.details, {})
  }));
}

/* ---------------- أرشفة سجل التدقيق (منع تضخم قاعدة البيانات) ---------------- */
/**
 * تحذف من audit_log كل سجل أقدم من المدة المحددة، بعد أرشفته أولًا في ملف
 * JSON مضغوط داخل مجلد audit-archive. الأرشفة تسبق الحذف دائمًا:
 * إذا فشل كتابة الأرشيف فلا يُحذف أي سطر.
 * تُستدعى مرة عند بدء البرنامج ثم يوميًّا.
 */
function auditArchive(retentionDays = 365) {
  const zlib = require('node:zlib');
  const days = Math.max(30, Number(retentionDays) || 365);
  const cutoff = now() - days * 24 * 60 * 60 * 1000;
  const d = ensureDb();
  const stale = d.prepare('SELECT * FROM audit_log WHERE timestamp < ? ORDER BY id').all(cutoff);
  if (!stale.length) return { archived: 0, removed: 0, file: '' };

  const dir = path.join(path.dirname(dbPath || '.'), 'audit-archive');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(cutoff).toISOString().slice(0, 10);
  const file = path.join(dir, `audit-log-older-than-${stamp}-${stale.length}.json.gz`);
  const payload = JSON.stringify({
    app: 'POS Pro', table: 'audit_log', archivedAt: now(),
    retentionDays: days, cutoff, count: stale.length, rows: stale
  });
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(payload, 'utf8')));

  let removed = 0;
  tx(() => {
    removed = Number(d.prepare('DELETE FROM audit_log WHERE timestamp < ?').run(cutoff).changes) || 0;
  });
  audit('system', 'audit_archive', { archived: stale.length, removed, cutoff, file });
  return { archived: stale.length, removed, file };
}

/**
 * الأصناف الأكثر طلبًا فعليًّا: تغذّي شريط «الأسرع طلبًا» في شاشة الكاشير.
 * تُحتسب الوحدات المباعة من فواتير مكتملة فقط (الملغاة والمُرجَعة خارجها).
 */
function topProducts(limit = 10) {
  const n = Math.min(Math.max(Number(limit) || 10, 1), 30);
  return ensureDb().prepare(`
    SELECT p.id AS id, p.name AS name,
           COALESCE(SUM(ii.qty), 0) AS units,
           COUNT(DISTINCT ii.invoice_id) AS orders
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      JOIN products p ON p.id = ii.product_id
     WHERE p.active = 1 AND i.status = 'completed'
     GROUP BY p.id
    HAVING units > 0
     ORDER BY units DESC, orders DESC, p.name
     LIMIT ?`).all(n)
    .map((r) => ({ id: Number(r.id), name: r.name, units: num(r.units), orders: num(r.orders) }));
}

/* ------------------------------ الخزنة (ملخص) ------------------------------ */
function treasurySummary(from, to) {
  const f = Number(from) || 0;
  const t = Number(to) || now();
  const expenses = round2(num(ensureDb().prepare('SELECT COALESCE(SUM(amount),0) AS s FROM expenses WHERE timestamp BETWEEN ? AND ?').get(f, t).s));
  const expensesAll = round2(num(ensureDb().prepare('SELECT COALESCE(SUM(amount),0) AS s FROM expenses').get().s));
  const inRange = round2(num(ensureDb().prepare("SELECT COALESCE(SUM(amount),0) AS s FROM treasury WHERE type='in' AND timestamp BETWEEN ? AND ?").get(f, t).s));
  const outRange = round2(num(ensureDb().prepare("SELECT COALESCE(SUM(amount),0) AS s FROM treasury WHERE type='out' AND timestamp BETWEEN ? AND ?").get(f, t).s));
  const cashSales = round2(num(ensureDb().prepare("SELECT COALESCE(SUM(total),0) AS s FROM invoices WHERE payment_method='cash' AND status='completed' AND timestamp BETWEEN ? AND ?").get(f, t).s));
  const creditOpen = round2(num(ensureDb().prepare("SELECT COALESCE(SUM(amount - paid),0) AS s FROM receivables WHERE status='open'").get().s));
  return {
    balance: vaultBalance(),
    expenses: expensesAll,
    expensesRange: expenses,
    treasuryIn: inRange,
    treasuryOut: outRange,
    treasuryNet: round2(inRange - outRange),
    cashSalesRange: cashSales,
    receivablesOpen: creditOpen,
    ledger: ensureDb().prepare('SELECT * FROM cash_ledger ORDER BY id DESC LIMIT 200').all().map((r) => ({
      id: Number(r.id), timestamp: r.timestamp, type: r.type, amount: num(r.amount),
      note: r.note || '', shiftId: r.shift_id, userId: r.user_id
    }))
  };
}

/* ------------------------------ النسخ الاحتياطي ------------------------------ */
const BACKUP_TABLES = [
  'users', 'settings', 'categories', 'products', 'product_variants', 'product_options',
  'materials', 'product_materials', 'returns', 'return_items',
  'shifts', 'invoice_sequence', 'invoices', 'invoice_items', 'holds', 'customers', 'expenses',
  'treasury', 'cash_ledger', 'receivables', 'delivery_companies', 'audit_log'
];

function dumpAll() {
  const data = {};
  BACKUP_TABLES.forEach((table) => {
    data[table] = ensureDb().prepare(`SELECT * FROM ${table}`).all();
  });
  data.exportedAt = now();
  data.app = 'POS Pro';
  data.schemaVersion = SCHEMA_VERSION;
  return data;
}

function replaceAll(data) {
  if (!data || typeof data !== 'object') throw new Error('ملف النسخة الاحتياطية غير صالح');
  const d = ensureDb();
  const known = BACKUP_TABLES.filter((t) => Array.isArray(data[t]));
  if (known.length < 5) throw new Error('ملف النسخة الاحتياطية لا يحتوي بيانات معروفة');
  d.exec('PRAGMA foreign_keys = OFF');
  try {
    d.exec('BEGIN IMMEDIATE');
    BACKUP_TABLES.forEach((t) => d.prepare(`DELETE FROM ${t}`).run());
    known.forEach((table) => {
      const rows = data[table];
      if (!rows.length) return;
      const cols = Object.keys(rows[0]);
      const stmt = d.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      rows.forEach((row) => stmt.run(...cols.map((c) => (row[c] === undefined ? null : row[c]))));
    });
    d.exec('COMMIT');
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    d.exec('PRAGMA foreign_keys = ON');
  }
  ensureDb().prepare("INSERT INTO settings (key, value) VALUES ('main', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify({ ...DEFAULT_SETTINGS, ...settingsGet() }));
  // مسودّات السلة لا تُستعاد من النسخة الاحتياطية (بيانات جلسة مؤقتة)
  ensureDb().prepare('DELETE FROM cart_drafts').run();
  return { restoredTables: known.length };
}

function backupFile(dir) {
  const fs = require('node:fs');
  const path = require('node:path');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `pos-backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(dumpAll()), 'utf8');
  return file;
}

function dbInfo() {
  const stat = dbPath ? fs.statSync(dbPath) : null;
  return { path: dbPath, size: stat ? stat.size : 0, version: SCHEMA_VERSION };
}

function close() {
  try { ensureDb().close(); } catch { /* ignore */ }
  db = null;
}

module.exports = {
  init, close, integrityCheck, dbInfo,
  usersList, userGet, userRow, userSave, userDelete, userSetPassword,
  settingsGet, settingsSave,
  productsList, productGet, productsSave, productsDelete,
  materialsList, materialGet, materialSave, materialDelete, productRecipe,
  categoriesList, categoryAdd, categoryDelete,
  shiftActive, shiftGet, shiftOpen, shiftSummary, shiftClose,
  invoiceCreate, invoiceCancel, invoiceGet, invoicesList, reportsSummary,
  reportsAdvanced, reportsStaff,
  returnsFind, returnsList, returnsSummary, returnsCreate, returnGet, returnableInvoice,
  returnsForInvoice,
  holdsList, holdsAdd, holdsDelete, holdsClearForUser,
  cartDraftGet, cartDraftSave, cartDraftClear,
  expensesList, expenseAdd, expenseDelete,
  treasuryList, treasuryAdd, treasurySummary, vaultBalance,
  receivablesList, receivableSettle,
  deliveryList, deliverySave, deliveryDelete,
  customers: { get: customerGet, save: customerSave },
  audit, auditList, auditArchive, topProducts, resetData, DATA_TABLES,
  dumpAll, replaceAll, backupFile, getHandle: () => ensureDb(),
  defaultPermissions, round2
};
