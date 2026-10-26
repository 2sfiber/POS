'use strict';
/**
 * اختبار شامل يعمل داخل Electron الحقيقي:
 * تسجيل دخول، إجبار تغيير كلمة المرور، فتح وردية، بيع نقدي، طباعة PDF، إلغاء،
 * بيع آجل وتحصيل، اختبار XSS، نسخ احتياطي، Excel، وصلاحيات الكاشير.
 */
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

module.exports = async function smoke({ win, db, printing, exporter, legacy: legacyModule }) {
  const OUT = path.join(process.cwd(), 'artifacts');
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function check(name, condition, detail) {
    results.push({ name, ok: !!condition });
    if (!condition) throw new Error(`فشل الاختبار: ${name} ${detail ? JSON.stringify(detail) : ''}`);
    console.log('  ✓', name);
  }
  async function js(code) {
    return win.webContents.executeJavaScript(`(async () => { ${code} })()`, true);
  }
  async function waitFor(expression, label, timeout = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = await win.webContents.executeJavaScript(`Boolean(${expression})`, true).catch(() => false);
      if (value) return true;
      await sleep(80);
    }
    throw new Error(`انتهت المهلة في انتظار: ${label || expression}`);
  }
  async function shot(name, w) {
    const target = w || win;
    const image = await target.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name), image.toPNG());
  }
  async function renderScreenshot(html, name, width = 340) {
    const { BrowserWindow } = require('electron');
    const w = new BrowserWindow({
      show: false, offscreen: true, width, height: 1200,
      webPreferences: { offscreen: true, sandbox: true }
    });
    const file = path.join(OUT, `render-${Date.now()}.html`);
    fs.writeFileSync(file, printing.injectFonts(html), 'utf8');
    await w.loadFile(file);
    await sleep(500);
    const image = await w.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name), image.toPNG());
    w.destroy();
    fs.unlinkSync(file);
  }

  /* ---------- 1) تسجيل الدخول وإجبار تغيير كلمة المرور ---------- */
  await waitFor("document.getElementById('loginScreen') && !document.getElementById('loginScreen').classList.contains('hidden')", 'شاشة الدخول');
  await shot('01-login.png');
  check('شاشة الدخول ظاهرة', true);

  const firstRun = await js("return !document.getElementById('firstRunHint').classList.contains('hidden');");
  check('تنبيه أول تشغيل ظاهر', firstRun);

  await js(`
    document.getElementById('loginUser').value = 'admin';
    document.getElementById('loginPass').value = 'admin123';
    document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return true;`);
  await waitFor("!document.getElementById('forcePasswordModal').classList.contains('hidden')", 'نافذة تغيير كلمة المرور');
  check('يُطلب تغيير كلمة المرور الافتراضية', true);

  await js(`
    document.getElementById('fpOld').value = 'admin123';
    document.getElementById('fpNew').value = 'admin12345';
    document.getElementById('fpNew2').value = 'admin12345';
    document.getElementById('fpSubmit').click();
    return true;`);
  await waitFor("!document.getElementById('appScreen').classList.contains('hidden')", 'الدخول للتطبيق');
  await waitFor("!document.getElementById('shiftModal').classList.contains('hidden')", 'نافذة فتح الوردية');
  check('تغيير كلمة المرور يفتح التطبيق', true);

  /* ---------- 1.5) رقم الإصدار ورقم البناء ---------- */
  const buildFile = path.join(process.resourcesPath, 'build.json');
  let wroteBuild = false;
  try {
    fs.writeFileSync(buildFile, JSON.stringify({ version: '2.0.0', build: 'b999', number: 999, date: '2026-10-23' }), 'utf8');
    wroteBuild = true;
  } catch { /* مجلد غير قابل للكتابة */ }
  const versionState = await js(`
    const info = await api('app:info');
    applyAppVersion(info);
    return { build: info.build, version: info.version, title: document.title, label: appVersionLabel() };`);
  check('معلومات التطبيق تتضمن رقم البناء',
    wroteBuild ? versionState.build === 'b999' : versionState.build === '', versionState);
  check('عنوان النافذة يعرض الإصدار ورقم البناء',
    versionState.title.includes(versionState.version) && (!wroteBuild || versionState.title.includes('بناء b999')),
    versionState.title);
  check('نص الإصدار في الإعدادات يتضمن رقم البناء',
    !wroteBuild || versionState.label === '2.0.0 — بناء b999', versionState.label);
  // شاشة الإعدادات فعليًا (بطاقة "عن البرنامج" أسفل الصفحة)
  await js("showView('settings'); return true;");
  await sleep(600);
  const aboutText = await js("const el = document.getElementById('aboutVersion'); return el ? el.textContent : '';");
  check('شاشة «عن البرنامج» تعرض رقم الإصدار',
    !wroteBuild || aboutText === '2.0.0', aboutText);
  const aboutBuild = await js("const el = document.getElementById('aboutBuild'); return el ? el.textContent : '';");
  check('شاشة «عن البرنامج» تعرض التحديث المثبّت',
    !wroteBuild || aboutBuild === 'b999', aboutBuild);
  const aboutUi = await js(`return (() => {
    const save = document.getElementById('saveSettingsWrap');
    showSettingsTab('about');
    const hiddenOnAbout = save.classList.contains('hidden');
    showSettingsTab('print');
    const visibleOnPrint = !save.classList.contains('hidden');
    const wa = document.querySelector('#aboutWhatsappBtn[data-url="https://wa.me/967774465817"]');
    const call = document.querySelector('#aboutCallBtn[data-url="tel:+967774465817"]');
    const noTech = !document.getElementById('aboutTech');
    return { hiddenOnAbout, visibleOnPrint, wa: !!wa, call: !!call, noTech };
  })()`);
  check('زر «حفظ جميع الإعدادات» يختفي في تبويب «عن البرنامج»',
    aboutUi.hiddenOnAbout && aboutUi.visibleOnPrint, aboutUi);
  check('«عن البرنامج» يعرض أرقام الواتساب والاتصال', aboutUi.wa && aboutUi.call, aboutUi);
  check('«عن البرنامج» لا يعرض تفاصيل تقنية إضافية', aboutUi.noTech, aboutUi);
  const loginUi = await js(`return await (async () => {
    const users = await loadLoginUsers();
    const sel = document.getElementById('loginUser');
    return { tag: sel.tagName, options: sel.options.length, users: users.length };
  })()`);
  check('شاشة الدخول تعرض المستخدمين في قائمة اختيار',
    loginUi.tag === 'SELECT' && loginUi.options >= 1 && loginUi.options === loginUi.users, loginUi);
  if (wroteBuild) {
    // لقطة لبطاقة الإصدار (نُخفي نافذة الوردية مؤقتًا لتظهر البطاقة)
    await js(`
      showSettingsTab('about');
      document.getElementById('shiftModal').classList.add('hidden');
      document.getElementById('aboutVersion').scrollIntoView({ block: 'center' });
      return true;`);
    await sleep(350);
    await shot('01b-settings-version.png');
    await js("document.getElementById('shiftModal').classList.remove('hidden'); return true;");
  }
  await js("showView('pos'); return true;");
  if (wroteBuild) {
    fs.unlinkSync(buildFile);
    await js("applyAppVersion(await api('app:info')); return true;");
  }

  /* ---------- 2) فتح وردية ---------- */
  await js(`
    document.getElementById('openingFloat').value = '100';
    document.getElementById('confirmOpenShift').click();
    return true;`);
  await waitFor("document.getElementById('shiftBadge') && !document.getElementById('shiftBadge').classList.contains('hidden')", 'شارة الوردية');
  const shift = await js('return state.shift;');
  check('الوردية مفتوحة بعهدة 100', shift && shift.openingFloat === 100, shift);
  const productsCount = await js('return state.products.length;');
  check('تحميل الأصناف من SQLite', productsCount >= 10, productsCount);
  await shot('02-pos.png');

  /* ---------- 3) اختبار XSS ---------- */
  const xssProduct = await js(`
    return await api('products:save', {
      name: '<img src=x onerror="window.__xss=1">',
      category: 'برجر', costPrice: 1, sellingPrice: 2, stock: 5, minStock: 1
    });`);
  await js('await reloadProducts(); return true;');
  await sleep(200);
  const xss = await js(`
    return {
      fired: !!window.__xss,
      injected: document.querySelectorAll('#productGrid img[onerror]').length,
      shownAsText: document.getElementById('productGrid').textContent.includes('<img src=x'),
      hasTextNode: Array.from(document.querySelectorAll('#productGrid .product-name')).some(el => el.textContent.includes('onerror'))
    };`);
  check('لا تنفيذ سكربت من اسم الصنف', !xss.fired && xss.injected === 0, xss);
  check('اسم الصنف يُعرض كنص لا كـ HTML', xss.shownAsText && xss.hasTextNode, xss);
  await db.productsDelete(xssProduct.id, 'admin');

  /* ---------- 4) بيع نقدي ---------- */
  const beforeStock = await js(`
    const p = state.products.find(x => x.name === 'برجر لحم');
    document.querySelector('[data-pid="' + p.id + '"]').click();
    return p;`);
  const cart = await js('return { count: state.cart.length, total: totals().total, subtotal: totals().subtotal };');
  check('إضافة صنف للسلة', cart.count === 1 && cart.subtotal > 0, cart);
  await sleep(300);
  await shot('02b-cart-totals.png');

  await js("document.getElementById('payBtn').click(); return true;");
  await waitFor("!document.getElementById('paymentModal').classList.contains('hidden')", 'نافذة الدفع');
  await js(`
    document.getElementById('amountPaidInput').value = '1000';
    document.getElementById('amountPaidInput').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('confirmPaymentBtn').click();
    return true;`);
  await waitFor("!document.getElementById('printPreviewModal').classList.contains('hidden')", 'معاينة الفاتورة');
  const preview = await js(`
    await new Promise(r => setTimeout(r, 300));
    const sheet = document.getElementById('previewSheet');
    const root = sheet ? sheet.shadowRoot : null;
    const rect = sheet ? sheet.getBoundingClientRect() : null;
    return {
      visible: !document.getElementById('printPreviewModal').classList.contains('hidden'),
      hasRoot: !!root,
      text: root ? root.textContent.replace(/\\s+/g, ' ').trim() : '',
      width: rect ? Math.round(rect.width) : 0,
      height: rect ? Math.round(rect.height) : 0,
      footer: state.settings.footerText || ''
    };`);
  check('معاينة الفاتورة تعرض المحتوى وليست بيضاء',
    preview.visible && preview.hasRoot && preview.text.length > 80 && preview.width > 100 && preview.height > 150,
    { w: preview.width, h: preview.height, len: preview.text.length });
  check('معاينة الفاتورة تُظهر نص التذييل',
    !preview.footer || preview.text.includes(preview.footer),
    preview.text.slice(-90));
  await shot('03a-print-preview.png');
  const invoice = await js("return await api('invoices:last');");
  check('تم إنشاء فاتورة نقدية', invoice && invoice.status === 'completed' && invoice.total > 0, invoice && invoice.serial);
  check('الإجمالي مطابق للسعر في قاعدة البيانات', invoice.total === cart.total, { invoice: invoice.total, cart: cart.total });
  const afterProduct = await js(`return (await api('products:list')).find(p => p.id === ${beforeStock.id});`);
  check('خصم المخزون بعد البيع', afterProduct.stock === beforeStock.stock - 1, { before: beforeStock.stock, after: afterProduct.stock });
  await js("document.getElementById('closePreviewBtn').click(); return true;");
  await sleep(150);
  await shot('03-pos-after-sale.png');

  /* ---------- 5) طباعة PDF للفاتورة + لقطة الفاتورة ---------- */
  const receiptHtml = await js("const inv = await api('invoices:get', { id: " + invoice.id + " }); return buildReceiptHtml(inv, 'customer');");
  const receiptPdf = path.join(OUT, 'receipt.pdf');
  const pdfRes = await printing.savePdf({ html: receiptHtml, filePath: receiptPdf, widthMm: 80 });
  check('توليد PDF للفاتورة', pdfRes.ok && fs.statSync(receiptPdf).size > 1000, pdfRes.error || fs.statSync(receiptPdf).size);
  // مقاس الصفحة الحقيقي داخل PDF: يجب أن يطابق 80 مم (226.8 نقطة) — لا أن يكون عملاًاقًا
  const pdfBox = (file) => {
    const text = fs.readFileSync(file).toString('latin1');
    const m = text.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
    return m ? { w: Number(m[3]), h: Number(m[4]) } : null;
  };
  const box80 = pdfBox(receiptPdf);
  check('مقاس صفحة PDF = عرض الفاتورة (80 مم ≈ 226.8 نقطة)',
    box80 && Math.abs(box80.w - 226.77) < 3 && box80.h > 80, box80);

  /* ---------- 5.1) مسار الطباعة الحرارية المباشرة ESC/POS ---------- */
  const escpos = require('../electron/escpos');
  const raster58 = await escpos.htmlToRaster(printing.injectFonts(receiptHtml), { widthMm: 58, dpi: 203 });
  let ink58 = 0;
  for (const byte of raster58.data) if (byte !== 0) ink58++;
  check('تحويل فاتورة 58 مم إلى 384 نقطة',
    raster58.widthDots === 384 && raster58.heightDots > 200, { w: raster58.widthDots, h: raster58.heightDots });
  check('الصورة النقطية تحتوي على محتوى (ليست فارغة)', ink58 > 200, ink58);
  const escposJob = escpos.buildEscPosJob(raster58, { copies: 1, feedLines: 4, cut: true });
  check('بناء أوامر ESC/POS كاملة', escposJob[0] === 0x1b && escposJob.length > 2000, { bytes: escposJob.length });
  check('القص يسبقه تغذية 20 مم (160 نقطة) لإخراج التذييل من الشفرة',
    escposJob.includes(Buffer.from([0x1d, 0x56, 0x42, 160])), [...escposJob.subarray(escposJob.length - 4)]);
  const raster80 = await escpos.htmlToRaster(printing.injectFonts(receiptHtml), { widthMm: 80, dpi: 203 });
  check('تحويل فاتورة 80 مم إلى 576 نقطة', raster80.widthDots === 576, raster80.widthDots);
  const kitchenHtml = await js("const inv = await api('invoices:get', { id: " + invoice.id + " }); return buildReceiptHtml(inv, 'kitchen');");
  await renderScreenshot(kitchenHtml, '04-kitchen-receipt.png', 320);
  await renderScreenshot(receiptHtml, '05-customer-receipt.png', 320);

  /* ---------- 6) إلغاء الفاتورة وإرجاع المخزون ---------- */
  const cancelled = await js(`return await api('invoices:cancel', { id: ${invoice.id}, reason: 'اختبار آلي', adminPassword: 'admin12345' });`);
  check('إلغاء الفاتورة', cancelled.status === 'cancelled', cancelled.status);
  const restored = await js(`return (await api('products:list')).find(p => p.id === ${beforeStock.id});`);
  check('إرجاع المخزون بعد الإلغاء', restored.stock === beforeStock.stock, { stock: restored.stock });
  const balanceAfterCancel = await js("const s = await api('treasury:summary', {}); return s.balance;");
  check('رصيد الخزنة بعد الإلغاء = العهدة فقط', Math.abs(balanceAfterCancel - 100) < 0.01, balanceAfterCancel);

  /* ---------- 7) بيع آجل وتحصيل الذمة ---------- */
  await js(`
    const p = state.products.find(x => x.name === 'كولا');
    document.querySelector('[data-pid="' + p.id + '"]').click();
    document.getElementById('custName').value = 'عميل اختبار';
    document.getElementById('custPhone').value = '777000111';
    document.querySelector('[data-pay="credit"]').click();
    document.getElementById('payBtn').click();
    return true;`);
  await waitFor("!document.getElementById('paymentModal').classList.contains('hidden')", 'دفع آجل');
  await js("document.getElementById('confirmPaymentBtn').click(); return true;");
  await waitFor("document.getElementById('printPreviewModal') && !document.getElementById('printPreviewModal').classList.contains('hidden')", 'معاينة الآجل');
  await js("document.getElementById('closePreviewBtn').click(); return true;");
  const creditInvoice = await js("return await api('invoices:last');");
  check('فاتورة آجلة', creditInvoice.paymentMethod === 'credit', creditInvoice.paymentMethod);
  const receivables = await js("return await api('receivables:list', {});");
  const rec = receivables.find((r) => r.invoiceId === creditInvoice.id);
  check('تسجيل الذمة الآجلة', rec && rec.status === 'open' && rec.remaining === creditInvoice.total, rec);
  const settled = await js(`return await api('receivables:settle', { id: ${rec.id}, amount: ${rec.remaining} });`);
  check('تحصيل الذمة بالكامل', settled.status === 'paid' && settled.remaining === 0, settled);



  /* ---------- 8) تقرير Excel و PDF ---------- */
  const xlsxPath = path.join(OUT, 'report.xlsx');
  const wb = await exporter.buildWorkbook('invoices', { from: 0, to: Date.now() });
  await wb.xlsx.writeFile(xlsxPath);
  const readBack = new ExcelJS.Workbook();
  await readBack.xlsx.readFile(xlsxPath);
  const sheetNames = readBack.worksheets.map((s) => s.name);
  check('ملف Excel سليم', fs.statSync(xlsxPath).size > 2000 && sheetNames.includes('الفواتير'), sheetNames);

  const summary = await js('return await api("reports:summary", { from: 0, to: Date.now() });');
  const invoicesList = await js('return await api("invoices:list", { limit: 100 });');
  const reportHtml = await js(`return buildInvoicesPdfHtml(${JSON.stringify(invoicesList)}, ${JSON.stringify(summary)}, 'اختبار');`);
  const reportPdf = path.join(OUT, 'invoices-report.pdf');
  const reportPdfRes = await printing.savePdf({ html: reportHtml, filePath: reportPdf, widthMm: 210, heightMm: 297 });
  check('توليد PDF تقرير A4', reportPdfRes.ok && fs.statSync(reportPdf).size > 2000, reportPdfRes.error);
  const reportBox = (() => {
    const text = fs.readFileSync(reportPdf).toString('latin1');
    const m = text.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
    return m ? { w: Number(m[3]), h: Number(m[4]) } : null;
  })();
  check('مقاس صفحة تقرير PDF = A4 (595×842 نقطة)',
    reportBox && Math.abs(reportBox.w - 595.28) < 3 && Math.abs(reportBox.h - 841.89) < 3, reportBox);

  // تصدير قائمة الأصناف PDF من نفس المسار الذي تستخدمه الواجهة
  const productsHtml = await js('return buildProductsPdfHtml(state.products);');
  const productsPdf = path.join(OUT, 'products-list.pdf');
  const productsPdfRes = await printing.savePdf({
    html: productsHtml, filePath: productsPdf, widthMm: 210, heightMm: 297, marginMm: 10
  });
  check('تصدير قائمة الأصناف PDF', productsPdfRes.ok && fs.statSync(productsPdf).size > 2000, productsPdfRes.error);
  const productsBox = (() => {
    const text = fs.readFileSync(productsPdf).toString('latin1');
    const m = text.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
    return m ? { w: Number(m[3]), h: Number(m[4]) } : null;
  })();
  check('قائمة الأصناف PDF بمقاس A4', productsBox && Math.abs(productsBox.w - 595.28) < 3, productsBox);

  /* ---------- 9) النسخ الاحتياطي ---------- */
  const backup = db.backupFile(path.join(OUT, 'backup'));
  const backupJson = JSON.parse(fs.readFileSync(backup, 'utf8'));
  check('نسخة احتياطية كاملة', backupJson.products.length > 0 && backupJson.invoices.length >= 1 && backupJson.cash_ledger.length > 0,
    { products: backupJson.products.length, invoices: backupJson.invoices.length });
  check('النسخة لا تحتوي كلمة مرور صريحة', !JSON.stringify(backupJson).includes('admin123'), null);

  /* ---------- 10) لوحة التقارير والإعدادات ---------- */
  await js("showView('reports'); return true;");
  await sleep(500);
  await shot('06-reports.png');
  await js("showView('settings'); return true;");
  await sleep(600);
  await shot('07-settings.png');
  const printerText = await js("return document.getElementById('printersHint').textContent;");
  check('إعدادات الطباعة تُقرأ من النظام', typeof printerText === 'string' && printerText.length > 0, printerText);

  /* تبويبات الإعدادات: كل تبويب يُظهر قسمه فقط ويُخفي الباقي */
  const tabNames = await js("return [...document.querySelectorAll('#settingsTabs .settings-tab')].map(b => b.dataset.tab);");
  check('تبويبات الإعدادات ظاهرة بالكامل',
    ['print', 'store', 'tax', 'ui', 'backup', 'data', 'update', 'about'].every((t) => tabNames.includes(t)), tabNames);
  const auditCard = await js("return !!document.getElementById('auditTbody');");
  check('سجل التدقيق أُزيل من الإعدادات', auditCard === false);
  const tabState = await js(`
    showSettingsTab('backup');
    await new Promise(r => setTimeout(r, 150));
    const visible = [...document.querySelectorAll('#view-settings [data-tab]')]
      .filter(el => !el.classList.contains('settings-tab') && !el.classList.contains('hidden'))
      .map(el => el.dataset.tab);
    const active = document.querySelector('#settingsTabs .settings-tab.bg-emerald-600').dataset.tab;
    return { visible, active };`);
  check('تبديل التبويبات يُظهر قسمًا واحدًا فقط',
    tabState.visible.length === 1 && tabState.visible[0] === 'backup' && tabState.active === 'backup', tabState);
  const retainLabels = await js("return [...document.getElementById('backupKeepSelect').options].map(o => o.textContent);");
  check('خيارات الاحتفاظ بالنسخ واضحة',
    retainLabels.every((t) => t.includes('الاحتفاظ بآخر')), retainLabels);
  const updateText = await js(`
    showSettingsTab('update');
    await new Promise(r => setTimeout(r, 400));
    return document.getElementById('updateCurrentVersion').textContent;`);
  check('تبويب التحديث يعرض النسخة الحالية', /\d+\.\d+\.\d+/.test(updateText), updateText);
  const updateInfo = await js("return await api('update:info');");
  check('معلومات التحديث تُرجع الإصدار وحالة التغليف',
    !!updateInfo.version && typeof updateInfo.packaged === 'boolean', updateInfo);
  const updateBlocked = await js("try { return await api('update:prepare'); } catch (e) { return 'ERR ' + e.message; }");
  check('رفض التحديث في وضع التطوير برسالة واضحة',
    updateBlocked && updateBlocked.ok === false && /المثبتة|تطوير/.test(updateBlocked.error || ''), updateBlocked);
  await js("showSettingsTab('data'); return true;");
  await sleep(300);
  await shot('07a-settings-data.png');
  await js("showSettingsTab('update'); return true;");
  await sleep(500);
  await shot('07b-settings-update.png');
  await js("showSettingsTab('backup'); return true;");
  await sleep(300);
  await shot('07c-settings-backup.png');
  await js("showSettingsTab('print'); return true;");

  const printAttempt = await printing.printTestPage('', '80');
  check('رسالة واضحة عند عدم وجود طابعة',
    printAttempt.ok === false && /طابعات/.test(printAttempt.error || ''), printAttempt);

  for (const [view, file] of [['products', '08-products.png'], ['treasury', '09-treasury.png'],
    ['invoices', '10-invoices.png'], ['users', '11-users.png']]) {
    await js(`showView('${view}'); return true;`);
    await sleep(450);
    await shot(file);
  }
  await js("showView('pos'); return true;");

  /* ---------- 11) إغلاق الوردية ---------- */
  const summaryBeforeClose = await js(`return await api('shift:summary', { shiftId: ${shift.id} });`);
  const ledgerSum = db.vaultBalance();
  check('النقدية المتوقعة = مجموع دفتر النقدية للوردية', Math.abs(summaryBeforeClose.expectedCash - ledgerSum) < 0.01,
    { expected: summaryBeforeClose.expectedCash, ledger: ledgerSum });

  await js(`
    document.getElementById('closeShiftBtn').click();
    return true;`);
  await waitFor("!document.getElementById('closeShiftModal').classList.contains('hidden')", 'نافذة إغلاق الوردية');
  await js(`
    document.getElementById('actualCash').value = String(state.shiftSummary.expectedCash);
    document.getElementById('confirmCloseShiftNoPrint').click();
    return true;`);
  await waitFor("!document.getElementById('loginScreen').classList.contains('hidden')", 'الخروج بعد إغلاق الوردية', 15000);
  check('إغلاق الوردية وتسجيل الخروج', true);

  /* ---------- 12) صلاحيات الكاشير ---------- */
  await js(`
    document.getElementById('loginUser').value = 'cashier';
    document.getElementById('loginPass').value = 'cashier123';
    document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return true;`);
  await waitFor("!document.getElementById('forcePasswordModal').classList.contains('hidden')", 'تغيير كلمة مرور الكاشير');
  await js(`
    document.getElementById('fpOld').value = 'cashier123';
    document.getElementById('fpNew').value = 'cashier12345';
    document.getElementById('fpNew2').value = 'cashier12345';
    document.getElementById('fpSubmit').click();
    return true;`);
  await waitFor("!document.getElementById('shiftModal').classList.contains('hidden')", 'وردية الكاشير');
  await js("document.getElementById('openingFloat').value='0'; document.getElementById('confirmOpenShift').click(); return true;");
  await waitFor("!document.getElementById('shiftBadge').classList.contains('hidden')", 'فتح وردية الكاشير');

  const navHidden = await js("return document.querySelector('[data-view=\"reports\"]').classList.contains('hidden');");
  check('إخفاء شاشة التقارير عن الكاشير', navHidden);
  const deniedList = await js("try { await api('invoices:list', {}); return 'allowed'; } catch (e) { return e.message; }");
  check('منع قراءة الفواتير للكاشير من الخلفية', deniedList.includes('صلاحية'), deniedList);
  const deniedCancel = await js(`try { await api('invoices:cancel', { id: ${invoice.id}, reason: 'x', adminPassword: 'cashier12345' }); return 'allowed'; } catch (e) { return e.message; }`);
  check('منع إلغاء الفواتير بدون صلاحية', deniedCancel.includes('صلاحية'), deniedCancel);
  const deniedDiscount = await js(`
    const p = state.products.find(x => x.name === 'ماء');
    document.querySelector('[data-pid="' + p.id + '"]').click();
    try {
      await api('invoices:create', {
        items: state.cart.map(i => ({ productId: i.productId, qty: i.qty })),
        discountType: 'fixed', discountValue: 5, paymentMethod: 'cash', amountPaid: 1
      });
      return 'allowed';
    } catch (e) { return e.message; }`);
  check('منع الخصم بدون صلاحية', deniedDiscount.includes('صلاحية'), deniedDiscount);
  await shot('12-cashier.png');

  /* ---------- 13) استيراد نسخة المتصفح القديمة ---------- */
  // نستخدم نفس وحدة الاستيراد التي يعمل بها التطبيق (مهم في النسخة المغلَّفة)
  const legacy = legacyModule || require(path.join(process.cwd(), 'electron', 'legacy.js'));
  const { verifyPassword } = require(path.join(process.cwd(), 'electron', 'security.js'));
  const ts = Date.now() - 3600000;
  const legacyData = {
    products: [{ id: 1, name: 'شاي', category: 'مشروبات', costPrice: 1, sellingPrice: 2, stock: 10, minStock: 2, barcode: '999', image: {} }],
    categories: [{ name: 'مشروبات' }],
    users: [{ username: 'admin', password: 'oldpass', role: 'admin', name: 'مدير قديم' }],
    settings: [{ key: 'main', storeName: 'متجر قديم', printerWidth: '58' }],
    shifts: [{ id: 1, cashier: 'مدير قديم', userId: 'admin', openingFloat: 50, status: 'active', openedAt: ts }],
    invoices: [
      {
        id: 1, serial: 'INV-000001', shiftId: 1, cashier: 'مدير قديم', paymentMethod: 'cash', status: 'completed',
        items: [{ productId: 1, name: 'شاي', qty: 2, sellingPrice: 2, costPrice: 1 }],
        subtotal: 4, discount: 0, tax: 0, total: 4, amountPaid: 4, change: 0, totalCost: 2, profit: 2, timestamp: ts
      },
      {
        id: 2, serial: 'INV-000002', shiftId: 1, cashier: 'مدير قديم', paymentMethod: 'credit', status: 'completed',
        customer: { name: 'زبون', phone: '700111222' },
        items: [{ productId: 1, name: 'شاي', qty: 3, sellingPrice: 2, costPrice: 1 }],
        subtotal: 6, discount: 0, tax: 0, total: 6, amountPaid: 6, change: 0, totalCost: 3, profit: 3, timestamp: ts
      },
      {
        id: 3, serial: 'INV-000003', shiftId: 1, cashier: 'مدير قديم', paymentMethod: 'cash', status: 'cancelled',
        items: [{ productId: 1, name: 'شاي', qty: 1, sellingPrice: 2, costPrice: 1 }],
        subtotal: 2, discount: 0, tax: 0, total: 2, amountPaid: 2, change: 0, totalCost: 1, profit: 1, timestamp: ts
      }
    ],
    customers: [{ phone: '700111222', name: 'زبون', points: 12 }],
    expenses: [{ id: 1, description: 'كهرباء', amount: 10, cashier: 'مدير قديم', timestamp: ts }],
    treasury: [{ id: 1, type: 'in', amount: 20, reason: 'إيداع', cashier: 'مدير قديم', timestamp: ts }]
  };
  const imported = legacy.importLegacy(legacyData, 'admin');
  check('استيراد الأصناف والفواتير القديمة', imported.products === 1 && imported.invoices === 3, imported);
  check('تحويل كلمة مرور المستخدم القديم إلى تجزئة', verifyPassword('oldpass', db.userRow('admin').password_hash));
  check('إعادة بناء رصيد الخزنة من النسخة القديمة', Math.abs(imported.balance - 62) < 0.01, imported.balance);
  const openReceivables = db.receivablesList('open');
  check('إنشاء ذمم للفواتير الآجلة القديمة', openReceivables.length === 1 && openReceivables[0].amount === 6, openReceivables);
  check('تطبيق إعدادات المتجر القديمة', db.settingsGet().storeName === 'متجر قديم' && db.settingsGet().printerWidth === '58');
  const nextNumber = db.getHandle().prepare('SELECT next_number FROM invoice_sequence WHERE id = 1').get().next_number;
  check('متابعة تسلسل الفواتير بعد الاستيراد', nextNumber === 4, nextNumber);

  /* ---------- 14) تصفير البيانات مع الإبقاء على الإعدادات ---------- */
  const deniedReset = await js("try { await api('data:reset', { password: 'cashier12345' }); return 'allowed'; } catch (e) { return e.message; }");
  check('تصفير البيانات مقصور على المدير', /(المدير|صلاحية)/.test(deniedReset), deniedReset);
  const deniedWipe = await js("try { await api('data:wipe', { password: 'cashier12345' }); return 'allowed'; } catch (e) { return e.message; }");
  check('الحذف الكامل مقصور على المدير', /(المدير|صلاحية)/.test(deniedWipe), deniedWipe);

  const beforeReset = {
    invoices: db.invoicesList({ limit: 500 }).length,
    products: db.productsList(true).length,
    storeName: db.settingsGet().storeName,
    users: db.usersList().length
  };
  const resetOut = db.resetData('admin');
  check('التصفير يحذف الفواتير والورديات',
    db.invoicesList({ limit: 500 }).length === 0 && resetOut.removed.invoices === beforeReset.invoices, resetOut.removed);
  check('التصفير يُبقي الإعدادات والأصناف والمستخدمين',
    db.settingsGet().storeName === beforeReset.storeName &&
    db.productsList(true).length === beforeReset.products &&
    db.usersList().length === beforeReset.users,
    { ...beforeReset, afterStore: db.settingsGet().storeName });
  check('التصفير يعيد ترقيم الفواتير من البداية',
    db.getHandle().prepare('SELECT next_number FROM invoice_sequence WHERE id = 1').get().next_number === 1);

  console.log(`\n[test] ${results.length} اختبارًا ناجحًا`);
  return results;
};
