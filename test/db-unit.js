'use strict';
/* اختبار وحدات قاعدة البيانات: مسودّة السلة + إعدادات الشعار، وفحص ربط الإغلاق الآمن.
   لا يحتاج Electron (يُشغَّل بـ node) — يستخدم node:sqlite. */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('../electron/db');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✔', name);
  } catch (err) {
    console.error('  ✖', name, '—', err.message);
    process.exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-db-test-'));
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

db.init(tmp);
console.log('[unit] database');

check('جدول مسودّة السلة موجود', () => {
  const row = db.getHandle().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cart_drafts'").get();
  assert.ok(row && row.name === 'cart_drafts');
});

check('حفظ السلة ثم قراءتها بالبيانات نفسها', () => {
  const saved = db.cartDraftSave('cashier1', {
    items: [
      { productId: 3, qty: 2, note: 'بدون سكر' },
      { productId: 7, qty: 1, note: '' }
    ],
    discountType: 'percent',
    discountValue: 10,
    pointsRedeemed: 50,
    paymentMethod: 'bank',
    customer: { name: 'أحمد', phone: '777000111', deliveryId: '2' }
  });
  assert.strictEqual(saved.items, 3);
  const draft = db.cartDraftGet('cashier1');
  assert.ok(draft, 'يجب أن تعود المسودة');
  assert.strictEqual(draft.items.length, 2);
  assert.deepStrictEqual(draft.items[0], {
    productId: 3, variantId: null, optionIds: [], qty: 2, note: 'بدون سكر'
  });
  assert.strictEqual(draft.discountType, 'percent');
  assert.strictEqual(draft.discountValue, 10);
  assert.strictEqual(draft.pointsRedeemed, 50);
  assert.strictEqual(draft.paymentMethod, 'bank');
  assert.strictEqual(draft.customer.name, 'أحمد');
  assert.ok(draft.savedAt > 0);
});

check('كل مستخدم يرى سلته فقط', () => {
  db.cartDraftSave('cashier2', {
    items: [{ productId: 5, qty: 4 }],
    discountType: 'fixed', discountValue: 0, pointsRedeemed: 0, paymentMethod: 'cash'
  });
  assert.strictEqual(db.cartDraftGet('cashier2').items[0].qty, 4);
  assert.strictEqual(db.cartDraftGet('cashier1').items.length, 2);
});

check('تجاهل الأصناف غير الصالحة وتقليم الملاحظات', () => {
  const res = db.cartDraftSave('cashier2', {
    items: [
      { productId: 0, qty: 1 },
      { productId: 4, qty: 0 },
      { productId: 9, qty: -3 },
      { productId: 11, qty: 1, note: 'ن'.repeat(500) }
    ],
    paymentMethod: 'weird'
  });
  assert.strictEqual(res.items, 1);
  const draft = db.cartDraftGet('cashier2');
  assert.strictEqual(draft.items.length, 1);
  assert.strictEqual(draft.items[0].productId, 11);
  assert.strictEqual(draft.items[0].note.length, 160);
  assert.strictEqual(draft.paymentMethod, 'cash');
});

check('حفظ سلة فارغة يمحو المسودة', () => {
  db.cartDraftSave('cashier2', { items: [] });
  assert.strictEqual(db.cartDraftGet('cashier2'), null);
  db.cartDraftSave('cashier1', { items: [{ productId: 3, qty: 1 }] });
  db.cartDraftClear('cashier1');
  assert.strictEqual(db.cartDraftGet('cashier1'), null);
});

check('شعار المتجر يبقى محفوظًا بعد إعادة فتح قاعدة البيانات', () => {
  const logo = 'data:image/jpeg;base64,AAAA';
  db.settingsSave({ logoData: logo, storeName: 'متجر عدن' });
  db.close();
  db.init(tmp);
  const settings = db.settingsGet();
  assert.strictEqual(settings.logoData, logo);
  assert.strictEqual(settings.storeName, 'متجر عدن');
});

check('قناة السلة والشعار موصولة في الطبقات الثلاث', () => {
  const main = read('electron/main.js');
  assert.ok(main.includes("'cart:get'"), 'قناة cart:get مفقودة');
  assert.ok(main.includes("'cart:save'"), 'قناة cart:save مفقودة');
  assert.ok(main.includes("'cart:clear'"), 'قناة cart:clear مفقودة');
  assert.ok(main.includes('window.confirmCloseApp'), 'تأكيد الإغلاق غير موصول بواجهة البرنامج');
  assert.ok(main.includes('closePromptOpen'), 'حماية من تكرار نافذة تأكيد الإغلاق مفقودة');
  assert.ok(main.includes('window.flushCartDraft'), 'حفظ السلة قبل الإغلاق غير موصول');
  const app = read('renderer/js/app.js');
  assert.ok(app.includes('await loadLoginBranding();'), 'شعار شاشة الدخول لا يُحمّل قبل الدخول');
  assert.ok(/await restoreCartDraft\(/.test(app), 'استعادة السلة غير موصولة ببدء الجلسة');
  assert.ok(app.includes('window.confirmCloseApp = confirmCloseApp;'), 'نافذة تأكيد الإغلاق غير معرّضة للعملية الرئيسية');
  const pos = read('renderer/js/pos.js');
  assert.ok(pos.includes("api('cart:save'"), 'حفظ السلة غير موصول بالواجهة');
  assert.ok(pos.includes('scheduleCartSave();'), 'لا يوجد حفظ تلقائي عند تغيير السلة');
  assert.ok(pos.includes('window.flushCartDraft = saveCartDraft;'), 'حفظ فوري قبل الإغلاق غير معرّض للعملية الرئيسية');
  assert.ok(pos.includes('window.getCartCount'), 'عدد أصناف السلة غير متاح لتأكيد الإغلاق');
});

check('جداول الأحجام والنكهات وأعمدة الفاتورة موجودة', () => {
  const tables = db.getHandle().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  ['product_variants', 'product_options'].forEach((t) => assert.ok(tables.includes(t), `جدول ${t} مفقود`));
  const cols = db.getHandle().prepare('PRAGMA table_info(invoice_items)').all().map((r) => r.name);
  ['variant_id', 'variant_name', 'options_json'].forEach((c) => assert.ok(cols.includes(c), `عمود ${c} مفقود`));
  const pcols = db.getHandle().prepare('PRAGMA table_info(products)').all().map((r) => r.name);
  ['has_variants', 'has_options'].forEach((c) => assert.ok(pcols.includes(c), `عمود ${c} مفقود`));
});

let varianted = null;
let bigVariant = null;
let paidOption = null;

check('حفظ صنف بأحجام: مخزون مجمّع وسعر يبدأ من الأصغر', () => {
  varianted = db.productsSave({
    name: 'برجر تجريبي', category: 'وجبات', barcode: '9001',
    hasVariants: true, hasOptions: false,
    variants: [
      { name: 'كبير', costPrice: 100, sellingPrice: 300, stock: 5 },
      { name: 'وسط', costPrice: 80, sellingPrice: 220, stock: 7 },
      { name: 'صغير', costPrice: 60, sellingPrice: 150, stock: 10 }
    ],
    options: []
  }, 'admin');
  assert.strictEqual(varianted.hasVariants, true);
  assert.strictEqual(varianted.variants.length, 3);
  assert.strictEqual(varianted.stock, 22, 'المخزون يجب أن يكون مجموع الأحجام');
  assert.strictEqual(varianted.sellingPrice, 150, 'السعر المعروض يبدأ من أقل حجم');
  assert.strictEqual(varianted.costPrice, 75.45, 'التكلفة متوسط مرجّح بالمخزون');
  bigVariant = varianted.variants.find((v) => v.name === 'كبير');
  assert.ok(bigVariant && bigVariant.id > 0);
});

check('إضافة نكهات بلا حد أعلى للعدد', () => {
  const options = Array.from({ length: 25 }, (_, i) => ({
    name: `نكهة ${i + 1}`, price: i === 0 ? 50 : 0
  }));
  varianted = db.productsSave({
    id: varianted.id, name: 'برجر تجريبي', category: 'وجبات', barcode: '9001',
    hasVariants: true, hasOptions: true,
    variants: varianted.variants.map((v) => ({
      id: v.id, name: v.name, costPrice: v.costPrice, sellingPrice: v.sellingPrice, stock: v.stock
    })),
    options
  }, 'admin');
  assert.strictEqual(varianted.options.length, 25);
  paidOption = varianted.options.find((o) => Number(o.price) > 0);
  assert.ok(paidOption && paidOption.id > 0);
});

check('رفض الأحجام المكررة أو بلا سعر', () => {
  assert.throws(() => db.productsSave({
    name: 'خطأ', category: 'وجبات', hasVariants: true,
    variants: [
      { name: 'كبير', sellingPrice: 100, stock: 1 },
      { name: 'كبير', sellingPrice: 200, stock: 1 }
    ]
  }, 'admin'), /مكرر/);
  assert.throws(() => db.productsSave({
    name: 'خطأ', category: 'وجبات', hasVariants: true,
    variants: [{ name: 'كبير', sellingPrice: 0, stock: 1 }]
  }, 'admin'), /أكبر من صفر/);
  assert.throws(() => db.productsSave({
    name: 'خطأ', category: 'وجبات', hasOptions: true, options: []
  }, 'admin'), /نكهة/);
});

check('الفاتورة تخصم مخزون الحجم وتثبّت الحجم والنكهة بسعرها', () => {
  const user = db.userGet('admin');
  db.shiftOpen(user, 0);
  const before = db.productGet(varianted.id);
  const bigBefore = before.variants.find((v) => v.id === bigVariant.id).stock;
  const inv = db.invoiceCreate({
    items: [{
      productId: varianted.id, variantId: bigVariant.id,
      optionIds: [paidOption.id], qty: 2, note: ''
    }],
    paymentMethod: 'cash', amountPaid: 1000
  }, user);
  assert.strictEqual(inv.items.length, 1);
  assert.strictEqual(inv.items[0].variantName, 'كبير');
  assert.strictEqual(inv.items[0].options.length, 1);
  assert.strictEqual(inv.items[0].options[0].name, paidOption.name);
  assert.strictEqual(inv.items[0].sellingPrice, 350, 'سعر الحجم + سعر النكهة');
  assert.strictEqual(inv.subtotal, 700);
  const after = db.productGet(varianted.id);
  assert.strictEqual(after.variants.find((v) => v.id === bigVariant.id).stock, bigBefore - 2);
  assert.strictEqual(after.stock, before.stock - 2, 'المخزون العام يُخصم أيضًا');
  // إلغاء الفاتورة يعيد المخزون للحجم وللصنف
  db.invoiceCancel(inv.id, 'اختبار', user);
  const restored = db.productGet(varianted.id);
  assert.strictEqual(restored.variants.find((v) => v.id === bigVariant.id).stock, bigBefore);
  assert.strictEqual(restored.stock, before.stock);
});

check('منع البيع عند نقص مخزون الحجم المحدد', () => {
  const user = db.userGet('admin');
  assert.throws(() => db.invoiceCreate({
    items: [{ productId: varianted.id, variantId: bigVariant.id, qty: 999 }],
    paymentMethod: 'cash', amountPaid: 999999
  }, user), /مخزون الحجم/);
});

check('تعليق الطلب يحفظ الحجم والنكهات', () => {
  const user = db.userGet('admin');
  const hold = db.holdsAdd({
    items: [{
      productId: varianted.id, name: 'برجر تجريبي', qty: 1, sellingPrice: 350, costPrice: 100,
      note: '', variantId: bigVariant.id, variantName: 'كبير',
      options: [{ id: paidOption.id, name: paidOption.name, price: paidOption.price }]
    }],
    paymentMethod: 'cash'
  }, user);
  const saved = db.holdsList('admin').find((h) => h.id === hold.id);
  assert.strictEqual(saved.items[0].variantName, 'كبير');
  assert.strictEqual(saved.items[0].options[0].name, paidOption.name);
  db.holdsDelete(hold.id);
});

check('تقرير المخزون يحسب الأحجام لا الصنف المجمّع فقط', () => {
  const adv = db.reportsAdvanced(0, Date.now() + 60000);
  assert.ok(adv.stock.units >= 22, `وحدات المخزون: ${adv.stock.units}`);
  assert.ok(adv.stock.costValue > 0, `قيمة المخزون: ${adv.stock.costValue}`);
  assert.ok(adv.stock.lowCount >= 0);
});

check('مسودّة السلة تحفظ الحجم والنكهات', () => {
  db.cartDraftSave('cashier3', {
    items: [{ productId: varianted.id, variantId: bigVariant.id, optionIds: [paidOption.id], qty: 1, note: '' }]
  });
  const draft = db.cartDraftGet('cashier3');
  assert.strictEqual(draft.items[0].variantId, bigVariant.id);
  assert.deepStrictEqual(draft.items[0].optionIds, [paidOption.id]);
});

check('واجهة الأحجام والنكهات موصولة بالطبقات', () => {
  const html = read('renderer/index.html');
  ['pHasVariants', 'pHasOptions', 'pVariantsList', 'pOptionsList', 'variantPickModal', 'optionPickModal']
    .forEach((id) => assert.ok(html.includes(`id="${id}"`), `عنصر ${id} مفقود`));
  const pos = read('renderer/js/pos.js');
  ['openProductFlow', 'cartLineKey', 'editCartItem', 'sizeShort', 'commitProductFlow']
    .forEach((fn) => assert.ok(pos.includes(fn), `دالة ${fn} مفقودة`));
  const print = read('renderer/js/print.js');
  assert.ok(print.includes('sizeShort('), 'اختصار الحجم غير مستخدم في الطباعة');
  assert.ok(print.includes('moneyShort('), 'الأسعار الفردية لا تُطبع بلا كسور صفرية');
  const prods = read('renderer/js/products.js');
  assert.ok(prods.includes("hasVariants"), 'إدارة الأصناف لا ترسل خيار الأحجام');
  // إغلاق الوردية: ثلاثة خيارات (تأكيد وطباعة / تأكيد بدون طباعة / إلغاء)، بلا تأكيد منفصل
  assert.ok(html.includes('id="confirmCloseShiftPrint"') && html.includes('id="confirmCloseShiftNoPrint"'));
  assert.ok(html.includes('id="cancelCloseShift"') && html.includes('id="closeShiftX"'));
  assert.ok(!html.includes('id="confirmCloseShift"'), 'زر التأكيد القديم ما زال موجودًا');
  const reports = read('renderer/js/reports.js');
  assert.ok(reports.includes('confirmCloseShift(true)') && reports.includes('confirmCloseShift(false)'));
  // أيقونة البرنامج في «عن البرنامج» تُقرأ من exe وليست شعار المتجر
  const main = read('electron/main.js');
  assert.ok(main.includes("'app:icon'"));
  const settings = read('renderer/js/settings.js');
  assert.ok(settings.includes('loadAboutIcon') && settings.includes("'app:icon'"));
  assert.ok(!settings.includes("['aboutLogo', 'aboutIcon']"), 'شعار المتجر ما زال يطغى على أيقونة البرنامج');
  assert.ok(/id="aboutLogo"[^>]*class="h-32 w-32 md:h-40 md:w-40/.test(html), 'أيقونة «عن البرنامج» ليست بالحجم الأكبر');
  // أيقونة البرنامج المرفقة: مصدر + ملفات بناء + أيقونة النافذة
  assert.ok(fs.existsSync(path.join(ROOT, 'assets', 'app-icon.ico')), 'ملف أيقونة البرنامج المصدر مفقود');
  assert.ok(fs.existsSync(path.join(ROOT, 'build', 'icon.ico')), 'build/icon.ico غير مُجهّز (شغّل npm run icon)');
  assert.ok(fs.existsSync(path.join(ROOT, 'renderer', 'img', 'app-icon.png')), 'PNG أيقونة البرنامج غير مُجهّز');
  assert.ok(/icon: fs\.existsSync\(APP_ICON_ICO\)/.test(main), 'أيقونة النافذة غير مضبوطة في main.js');
  assert.ok(/SOURCE_ICO/.test(read('scripts/make-icon.js')), 'سكربت الأيقونة لا يستخدم الملف المرفق');
});

/* ---------- الخامات والوصفات (Bill of Materials) ---------- */
let iceMix = null;
let plasticCup = null;
let iceCream = null;

check('إضافة خامات بوحدات قياس مختلفة', () => {
  const list = db.materialSave({ name: 'خليط أيسكريم', unit: 'لتر', stock: 10, costPrice: 5, minStock: 1 }, 'admin');
  iceMix = list.find((m) => m.name === 'خليط أيسكريم');
  assert.ok(iceMix && iceMix.id > 0);
  const list2 = db.materialSave({ name: 'كوب بلاستيك', unit: 'قطعة', stock: 100, costPrice: 0.5, minStock: 10 }, 'admin');
  plasticCup = list2.find((m) => m.name === 'كوب بلاستيك');
  assert.ok(plasticCup && plasticCup.unit === 'قطعة');
});

check('ربط صنف بوصفة خامات (200 مل + قطعة لكل وحدة)', () => {
  iceCream = db.productsSave({
    name: 'كوب أيسكريم', category: 'وجبات', barcode: '9500',
    sellingPrice: 10, costPrice: 3, stock: 50, minStock: 5,
    hasRecipe: true,
    recipe: [
      { materialId: iceMix.id, qty: 200, unit: 'مل' },
      { materialId: plasticCup.id, qty: 1, unit: 'قطعة' }
    ]
  }, 'admin');
  assert.strictEqual(iceCream.hasRecipe, true);
  assert.strictEqual(iceCream.recipe.length, 2);
  const line = iceCream.recipe.find((r) => r.materialId === iceMix.id);
  assert.strictEqual(line.unit, 'مل');
  assert.strictEqual(line.qty, 200);
});

check('رفض وصفة بوحدة غير متوافقة أو كمية صفرية', () => {
  assert.throws(() => db.productsSave({
    name: 'خطأ وصفة', category: 'وجبات', sellingPrice: 5, stock: 1,
    hasRecipe: true, recipe: [{ materialId: iceMix.id, qty: 1, unit: 'قطعة' }]
  }, 'admin'), /تحويل/);
  assert.throws(() => db.productsSave({
    name: 'خطأ وصفة', category: 'وجبات', sellingPrice: 5, stock: 1,
    hasRecipe: true, recipe: [{ materialId: iceMix.id, qty: 0, unit: 'مل' }]
  }, 'admin'), /أكبر من صفر/);
  assert.throws(() => db.productsSave({
    name: 'خطأ وصفة', category: 'وجبات', sellingPrice: 5, stock: 1, hasRecipe: true, recipe: []
  }, 'admin'), /خامة/);
});

let recipeInvoice = null;
check('البيع يخصم الخامات لحظيًا ويحفظ لقطة الاستهلاك', () => {
  const user = db.userGet('admin');
  db.shiftOpen(user, 0);
  recipeInvoice = db.invoiceCreate({
    items: [{ productId: iceCream.id, qty: 3 }],
    paymentMethod: 'cash', amountPaid: 100
  }, user);
  const mix = db.materialsList().find((m) => m.id === iceMix.id);
  const cup = db.materialsList().find((m) => m.id === plasticCup.id);
  assert.strictEqual(mix.stock, 9.4, '0.6 لتر من 200 مل × 3');
  assert.strictEqual(cup.stock, 97);
  const item = db.invoiceGet(recipeInvoice.id).items[0];
  assert.strictEqual(item.materials.length, 2);
  const mixLine = item.materials.find((m) => m.materialId === iceMix.id);
  assert.strictEqual(mixLine.qty, 0.6);
  assert.strictEqual(mixLine.unit, 'لتر');
});

check('منع البيع عند نقص مخزون الخامة', () => {
  const user = db.userGet('admin');
  // نرفع مخزون الصنف كي يصل الفحص إلى كفاية الخامة لا إلى مخزون الصنف
  db.productsSave({
    id: iceCream.id, name: iceCream.name, category: iceCream.category, barcode: iceCream.barcode,
    sellingPrice: iceCream.sellingPrice, costPrice: iceCream.costPrice, stock: 1000, minStock: 5,
    hasRecipe: true,
    recipe: [
      { materialId: iceMix.id, qty: 200, unit: 'مل' },
      { materialId: plasticCup.id, qty: 1, unit: 'قطعة' }
    ]
  }, 'admin');
  assert.throws(() => db.invoiceCreate({
    items: [{ productId: iceCream.id, qty: 60 }], paymentMethod: 'cash', amountPaid: 99999
  }, user), /مخزون الخامة/);
  assert.strictEqual(db.productGet(iceCream.id).stock, 1000, 'لا يُخصم الصنف عند فشل المعاملة');
});

check('البحث عن الفاتورة بالرقم أو الباركود يجلب الكميات القابلة للإرجاع', () => {
  const bySerial = db.returnsFind(recipeInvoice.serial);
  assert.ok(bySerial && bySerial.invoice.id === recipeInvoice.id);
  assert.strictEqual(bySerial.invoice.items[0].returnableQty, 3);
  const byBarcode = db.returnsFind('9500');
  assert.ok(byBarcode && byBarcode.invoice.id === recipeInvoice.id);
  assert.strictEqual(db.returnsFind('غير-موجود'), null);
});

let firstReturn = null;
check('مرتجع جزئي نقدي: يعيد المخزون والخامات ويكتب قيدًا عكسيًا', () => {
  const user = db.userGet('admin');
  const beforeVault = db.vaultBalance();
  const beforeStock = db.productGet(iceCream.id).stock;
  firstReturn = db.returnsCreate({
    invoiceId: recipeInvoice.id,
    items: [{ invoiceItemId: db.returnsFind(recipeInvoice.serial).invoice.items[0].id, qty: 1, reason: 'تالف / غير صالح' }],
    refundMethod: 'cash', reason: 'تالف / غير صالح'
  }, user);
  assert.ok(firstReturn.serial.startsWith('RET-'));
  assert.strictEqual(firstReturn.total, 10);
  assert.strictEqual(firstReturn.items.length, 1);
  assert.strictEqual(db.productGet(iceCream.id).stock, beforeStock + 1);
  assert.strictEqual(db.materialsList().find((m) => m.id === iceMix.id).stock, 9.6);
  assert.strictEqual(db.materialsList().find((m) => m.id === plasticCup.id).stock, 98);
  assert.strictEqual(db.vaultBalance(), Math.round((beforeVault - 10) * 100) / 100);
  const ledger = db.treasurySummary(0, Date.now()).ledger.find((l) => l.type === 'refund_cash');
  assert.ok(ledger && ledger.amount === -10, 'قيد المرتجع النقدي مفقود');
});

check('منع إرجاع كمية أكبر من المتاح', () => {
  const user = db.userGet('admin');
  const itemId = db.returnsFind(recipeInvoice.serial).invoice.items[0].id;
  assert.throws(() => db.returnsCreate({
    invoiceId: recipeInvoice.id,
    items: [{ invoiceItemId: itemId, qty: 5 }], refundMethod: 'cash'
  }, user), /أكبر من المتاح/);
  // سطران لنفس الصنف في نفس الطلب لا يتجاوزان المتاح مجتمعين
  assert.throws(() => db.returnsCreate({
    invoiceId: recipeInvoice.id,
    items: [
      { invoiceItemId: itemId, qty: 2 },
      { invoiceItemId: itemId, qty: 1 }
    ], refundMethod: 'cash'
  }, user), /أكبر من المتاح/);
});

check('مرتجع آجل يخفّض الذمة ويعيد المخزون', () => {
  const user = db.userGet('admin');
  const creditInv = db.invoiceCreate({
    items: [{ productId: iceCream.id, qty: 2 }],
    paymentMethod: 'credit', customer: { name: 'عميل آجل', phone: '777111222' }
  }, user);
  const recBefore = db.receivablesList().find((r) => r.invoiceId === creditInv.id);
  assert.ok(recBefore && recBefore.amount === 20);
  const itemId = db.returnsFind(creditInv.serial).invoice.items[0].id;
  const ret = db.returnsCreate({
    invoiceId: creditInv.id,
    items: [{ invoiceItemId: itemId, qty: 1, reason: 'خطأ في الطلب' }],
    refundMethod: 'credit'
  }, user);
  assert.strictEqual(ret.refundMethod, 'credit');
  const recAfter = db.receivablesList().find((r) => r.invoiceId === creditInv.id);
  assert.strictEqual(recAfter.amount, 10);
  assert.strictEqual(recAfter.status, 'open');
});

check('تقرير المرتجعات وصافي المبيعات وأداء الكاشير', () => {
  const from = 0;
  const to = Date.now() + 60000;
  const summary = db.returnsSummary(from, to);
  assert.ok(summary.count >= 2);
  assert.ok(summary.total >= 20);
  assert.strictEqual(db.round2(summary.total), db.round2(summary.cost + summary.profitReversal));
  const report = db.reportsSummary(from, to);
  assert.ok(report.returnsTotal > 0);
  assert.strictEqual(report.netSales, db.round2(report.sales - report.returnsTotal));
  const staff = db.reportsStaff(from, to).find((r) => r.userId === 'admin');
  assert.ok(staff.returnsCount >= 2);
  assert.strictEqual(staff.netSales, db.round2(staff.sales - staff.returnsTotal));
  const list = db.returnsList({ from, to });
  assert.ok(list.length >= 2 && list[0].items.length >= 1);
});

check('إلغاء فاتورة ذات وصفة يعيد مخزون الخامات كاملًا', () => {
  const user = db.userGet('admin');
  const mixBefore = db.materialsList().find((m) => m.id === iceMix.id).stock;
  const inv = db.invoiceCreate({
    items: [{ productId: iceCream.id, qty: 2 }], paymentMethod: 'cash', amountPaid: 50
  }, user);
  assert.strictEqual(db.materialsList().find((m) => m.id === iceMix.id).stock, db.round2(mixBefore - 0.4));
  db.invoiceCancel(inv.id, 'اختبار', user);
  assert.strictEqual(db.materialsList().find((m) => m.id === iceMix.id).stock, mixBefore);
});

check('مرتجع صنف بحجم يعيد مخزون الحجم والصنف المجمّع', () => {
  const user = db.userGet('admin');
  const before = db.productGet(varianted.id);
  const variantBefore = before.variants.find((v) => v.id === bigVariant.id).stock;
  const inv = db.invoiceCreate({
    items: [{ productId: varianted.id, variantId: bigVariant.id, qty: 1 }],
    paymentMethod: 'cash', amountPaid: 1000
  }, user);
  const itemId = db.returnsFind(inv.serial).invoice.items[0].id;
  db.returnsCreate({
    invoiceId: inv.id,
    items: [{ invoiceItemId: itemId, qty: 1, reason: 'خطأ في الطلب' }],
    refundMethod: 'cash'
  }, user);
  const after = db.productGet(varianted.id);
  assert.strictEqual(after.variants.find((v) => v.id === bigVariant.id).stock, variantBefore);
  assert.strictEqual(after.stock, before.stock);
});

check('المرتجعات ووصفات الخامات موصولة بالواجهة والقنوات', () => {
  const html = read('renderer/index.html');
  ['view-returns', 'returnsSearchInput', 'returnItemsTbody', 'returnsSubmitBtn', 'returnsTbody', 'returnsCsvBtn',
    'materialsModal', 'materialsTbody', 'pHasRecipe', 'pRecipeList', 'addRecipeBtn']
    .forEach((id) => assert.ok(html.includes(`id="${id}"`), `عنصر ${id} مفقود`));
  assert.ok(html.includes('js/returns.js'), 'ملف المرتجعات غير محمّل');
  assert.ok(html.includes('data-view="returns"'), 'زر المرتجعات غير موجود في التنقل');
  const main = read('electron/main.js');
  ['returns:find', 'returns:create', 'returns:list', 'returns:summary', 'materials:list', 'materials:save', 'export:csv']
    .forEach((channel) => assert.ok(main.includes(`'${channel}'`), `القناة ${channel} مفقودة`));
  const prods = read('renderer/js/products.js');
  ['hasRecipe', 'renderRecipeDraft', 'saveMaterial', 'manageMaterialsBtn']
    .forEach((token) => assert.ok(prods.includes(token), `الجزء ${token} مفقود من إدارة الأصناف`));
  const returns = read('renderer/js/returns.js');
  ['returns:find', 'returns:create', 'returnRefundMethod', 'buildReturnsPdfHtml']
    .forEach((token) => assert.ok(returns.includes(token), `الجزء ${token} مفقود من شاشة المرتجعات`));
  const css = read('renderer/css/tailwind.src.css');
  assert.ok(/user-select: text/.test(css), 'التحديد العام غير مفعّل');
  assert.ok(/input\[type="password"\]/.test(css), 'حظر نسخ كلمات المرور غير موجود');
  const core = read('renderer/js/core.js');
  assert.ok(core.includes('protectSecretFields'), 'حماية حقول كلمات المرور غير مربوطة');
});

check('تصفير البيانات يمسح المرتجعات ويصفّر الخامات مع الإبقاء على الوصفات', () => {
  db.resetData('admin');
  assert.strictEqual(db.getHandle().prepare('SELECT COUNT(*) AS c FROM returns').get().c, 0);
  assert.strictEqual(db.getHandle().prepare('SELECT COUNT(*) AS c FROM product_materials').get().c, 2);
  assert.strictEqual(db.materialsList().find((m) => m.id === iceMix.id).stock, 0);
});

check('ترحيل قاعدة b013 القديمة يضيف الأعمدة دون فقدان بيانات', () => {
  db.close();
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-db-old-'));
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(path.join(oldDir, 'pos.db'));
  old.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT, barcode TEXT,
      cost_price REAL NOT NULL DEFAULT 0, selling_price REAL NOT NULL DEFAULT 0,
      stock REAL NOT NULL DEFAULT 0, min_stock REAL NOT NULL DEFAULT 5, image TEXT,
      active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER, product_id INTEGER,
      name TEXT, qty REAL, selling_price REAL, cost_price REAL, note TEXT
    );
    INSERT INTO products (name, category, cost_price, selling_price, stock, created_at, updated_at)
      VALUES ('صنف قديم', 'عام', 10, 20, 3, 1, 1);
    INSERT INTO invoice_items (invoice_id, product_id, name, qty, selling_price, cost_price)
      VALUES (1, 1, 'صنف قديم', 1, 20, 10);
    PRAGMA user_version = 1;
  `);
  old.close();
  db.init(oldDir);
  const cols = db.getHandle().prepare('PRAGMA table_info(products)').all().map((r) => r.name);
  assert.ok(cols.includes('has_variants') && cols.includes('has_options') && cols.includes('has_recipe'), 'أعمدة التفعيل مفقودة');
  const itemCols = db.getHandle().prepare('PRAGMA table_info(invoice_items)').all().map((r) => r.name);
  assert.ok(itemCols.includes('variant_id') && itemCols.includes('options_json') && itemCols.includes('materials_json'));
  const newTables = db.getHandle().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  ['materials', 'product_materials', 'returns', 'return_items'].forEach((t) => assert.ok(newTables.includes(t), `جدول ${t} مفقود`));
  assert.strictEqual(db.getHandle().prepare('SELECT COUNT(*) AS c FROM products').get().c, 1);
  assert.strictEqual(db.getHandle().prepare('SELECT COUNT(*) AS c FROM invoice_items').get().c, 1);
  assert.strictEqual(db.productGet(1).name, 'صنف قديم');
  db.close();
  fs.rmSync(oldDir, { recursive: true, force: true });
});

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`[unit] ${passed} اختبارًا ناجحًا`);
