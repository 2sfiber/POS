'use strict';
/**
 * ============================================================================
 * الطباعة — مسارَان مع فحص تلقائي
 * ============================================================================
 * 1) ESC/POS مباشر (الافتراضي للطابعات الحرارية):
 *    نرسم الفاتورة كصورة نقاط ونرسلها خامًا إلى منفذ الطابعة، فنتجاوز تعريف
 *    ويندوز تمامًا. هذا المسار هو الحل لمشكلة «المهمة تظهر في قائمة الانتظار
 *    ثم تختفي بلا طباعة» مع الطابعات الحرارية المدمجة في أجهزة الكاشير
 *    (منافذ PLT / USB / COM / LPT / الشبكة)، ويدعم أي مقاس ورق.
 *
 * 2) تعريف ويندوز (Chromium):
 *    احتياطي للطابعات العادية (ليزر/A4) أو الطابعات غير المتوافقة مع ESC/POS.
 *
 * الإعدادات: printMode = 'auto' | 'escpos' | 'driver'
 * ============================================================================
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { BrowserWindow } = require('electron');
const escpos = require('./escpos');

/* الخطوط تُضمَّن داخل الفاتورة (data URI) حتى تظهر بنفس الشكل بلا إنترنت وبلا مسارات. */
const FONT_DIR = path.join(__dirname, '..', 'renderer', 'fonts');
let fontCssCache = null;
function fontCss() {
  if (fontCssCache !== null) return fontCssCache;
  let css = '';
  [400, 600, 700, 800].forEach((weight) => {
    ['arabic', 'latin'].forEach((subset) => {
      const file = path.join(FONT_DIR, `cairo-${subset}-${weight}.woff2`);
      if (!fs.existsSync(file)) return;
      const b64 = fs.readFileSync(file).toString('base64');
      css += `@font-face{font-family:'Cairo';font-style:normal;font-weight:${weight};font-display:block;` +
        `src:url(data:font/woff2;base64,${b64}) format('woff2');}\n`;
    });
  });
  fontCssCache = css;
  return css;
}
function injectFonts(html) {
  const style = `<style>${fontCss()}</style>`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${style}</head>`) : style + html;
}

const tmpDir = () => {
  const dir = path.join(os.tmpdir(), 'pos-pro-print');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

function writeTempHtml(html) {
  const file = path.join(tmpDir(), `receipt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.html`);
  fs.writeFileSync(file, html, 'utf8');
  return file;
}

function cleanup(file) {
  setTimeout(() => {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }, 30000).unref?.();
}

function createPrintWindow(show) {
  return new BrowserWindow({
    show: !!show,
    width: 480,
    height: 900,
    title: 'فاتورة',
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
      paintWhenInitiallyHidden: true,
      // في وضع الاختبار بلا شاشة نحتاج نافذة offscreen وإلا يسقط Chromium
      offscreen: process.env.POS_HEADLESS === '1'
    }
  });
}

async function loadIntoWindow(win, file) {
  await win.loadFile(file);
  try {
    await win.webContents.executeJavaScript(
      'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true', true
    );
  } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 180));
}

async function measure(win) {
  try {
    const size = await win.webContents.executeJavaScript(`(() => {
      const body = document.body;
      const html = document.documentElement;
      const h = Math.max(body.scrollHeight, body.offsetHeight, html.scrollHeight, html.offsetHeight);
      const w = Math.max(body.scrollWidth, html.scrollWidth);
      return { height: h, width: w };
    })()`, true);
    if (size && size.height > 0) return size;
  } catch { /* ignore */ }
  return { height: 800, width: 300 };
}

/* قائمة الطابعات المثبتة في النظام (مع تعريف ومنفذ إن أمكن) */
async function listPrinters() {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  const target = win || createPrintWindow(false);
  let printers = [];
  try {
    printers = await target.webContents.getPrintersAsync();
  } catch {
    printers = [];
  } finally {
    if (!win && !target.isDestroyed()) target.destroy();
  }
  let details = [];
  try { details = await escpos.printerDetails(); } catch { details = []; }
  return printers.map((p) => {
    const detail = details.find((d) => d.name === p.name) || {};
    return {
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: !!p.isDefault,
      status: p.status,
      driverName: detail.driverName || '',
      portName: detail.portName || '',
      thermal: escpos.looksThermal({
        name: p.name,
        driverName: detail.driverName || '',
        portName: detail.portName || ''
      }),
      options: p.options || {}
    };
  });
}

/* ------------------------------ إعدادات الطباعة ------------------------------ */
const PAPER_WIDTHS = [58, 76, 80];

function normalizeOptions(options = {}) {
  const rawWidth = Number(options.paperWidth);
  const widthMm = PAPER_WIDTHS.includes(rawWidth) ? rawWidth : (Number.isFinite(rawWidth) && rawWidth >= 40 ? rawWidth : 80);
  const dpi = escpos.DPI_PRESETS.includes(Number(options.dpi)) ? Number(options.dpi) : 203;
  const dotsOverride = Math.max(0, Math.round(Number(options.dots) || 0));
  const mode = ['auto', 'escpos', 'driver'].includes(options.mode) ? options.mode : 'auto';
  return {
    html: options.html,
    printerName: String(options.printerName || ''),
    widthMm,
    dpi,
    dots: dotsOverride,
    mode,
    copies: Math.max(1, Math.min(5, Number(options.copies) || 1)),
    feedLines: Math.max(0, Math.min(12, Number(options.feedLines != null ? options.feedLines : 4))),
    cutFeedMm: Math.max(0, Math.min(40, Number(options.cutFeedMm != null ? options.cutFeedMm : 20))),
    cut: options.cut !== false,
    silent: options.silent !== false,
    jobName: String(options.jobName || 'فاتورة')
  };
}

/**
 * الطباعة عبر تعريف ويندوز (Chromium). تُستخدم كاحتياطي.
 * ملاحظة: ارتفاع الصفحة = ارتفاع المحتوى الفعلي (بلا سقف) حتى لا تُقص الفواتير الطويلة.
 */
async function printViaDriver(opts) {
  const file = writeTempHtml(injectFonts(opts.html));
  const win = createPrintWindow(false);
  let submitted = false;
  try {
    await loadIntoWindow(win, file);
    const size = await measure(win);
    const pxToMm = 25400 / 96 / 1000;
    const heightMm = Math.max(30, Math.ceil(size.height * pxToMm) + 4);

    const printOpts = {
      silent: opts.silent,
      deviceName: opts.printerName || undefined,
      printBackground: true,
      margins: { marginType: 'none' },
      pageSize: { width: Math.round(opts.widthMm * 1000), height: Math.round(heightMm * 1000) },
      copies: opts.copies,
      header: false,
      footer: false
    };

    const result = await new Promise((resolve) => {
      submitted = true;
      const timer = setTimeout(() => {
        resolve({ ok: false, error: 'انتهت مهلة الطباعة دون استجابة من نظام التشغيل' });
      }, 45000);
      win.webContents.print(printOpts, (success, failureReason) => {
        clearTimeout(timer);
        if (success) resolve({ ok: true, mode: 'driver', widthMm: opts.widthMm, heightMm });
        else resolve({ ok: false, mode: 'driver', error: failureReason || 'رفض نظام التشغيل مهمة الطباعة' });
      });
    });
    return result;
  } catch (err) {
    return { ok: false, mode: 'driver', error: err.message || String(err) };
  } finally {
    if (!win.isDestroyed()) {
      // لا نُغلق النافذة فورًا: يجب أن يبقى مستند الطباعة حيًا حتى ينتهي السولر
      // من قراءته، وإلا اختفت المهمة من قائمة الانتظار بلا طباعة.
      setTimeout(() => {
        try { win.destroy(); } catch { /* ignore */ }
      }, submitted ? 6000 : 0).unref?.();
    }
    cleanup(file);
  }
}

/**
 * الطباعة الحرارية المباشرة: نسأل عن تعريف/منفذ الطابعة (للتشخيص)،
 * نرسم الفاتورة كصورة نقاط ونرسلها RAW.
 */
async function printViaEscPos(opts, printerInfo) {
  let raster;
  try {
    raster = await escpos.htmlToRaster(injectFonts(opts.html), {
      widthMm: opts.widthMm,
      dpi: opts.dpi,
      dots: opts.dots
    });
  } catch (err) {
    return { ok: false, mode: 'escpos', error: 'تعذّر تجهيز صورة الفاتورة: ' + (err.message || err) };
  }
  const res = await escpos.sendRasterRaw(opts.printerName, raster, {
    copies: opts.copies,
    feedLines: opts.feedLines,
    cutFeedMm: opts.cutFeedMm,
    dotsPerMm: escpos.paperMetrics({ widthMm: opts.widthMm, dpi: opts.dpi, dots: opts.dots }).dotsPerMm,
    cut: opts.cut
  });
  if (!res.ok) return { ok: false, mode: 'escpos', error: res.error };
  return {
    ok: true,
    mode: 'escpos',
    printer: res.printer,
    widthMm: opts.widthMm,
    dpi: raster.dpi,
    dots: raster.widthDots,
    rows: raster.heightDots,
    bytes: res.bytes,
    driverName: printerInfo ? printerInfo.driverName : '',
    portName: printerInfo ? printerInfo.portName : ''
  };
}

/**
 * طباعة HTML (فاتورة/تقرير).
 * options: { html, printerName, paperWidth(mm), copies, mode, dpi, dots,
 *            feedLines, cut, silent }
 * الإرجاع: { ok, mode:'escpos'|'driver', error?, fallbackError?, ... }
 */
async function printHtml(options) {
  const opts = normalizeOptions(options);
  if (!opts.html || typeof opts.html !== 'string') return { ok: false, error: 'لا يوجد محتوى للطباعة' };

  // ١) التأكد من وجود طابعة مثبتة (رسالة واضحة بدل فشل غامض)
  let installed = [];
  try {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    installed = win ? await win.webContents.getPrintersAsync() : await listPrinters();
  } catch { installed = []; }
  if (!installed || installed.length === 0) {
    return { ok: false, error: 'لا توجد طابعات مثبتة على هذا الجهاز. ثبّت الطابعة من إعدادات ويندوز ثم أعد المحاولة.' };
  }

  // ٢) معلومات الطابعة المستهدفة (تعريف ومنفذ) لاختيار المسار
  let printerInfo = null;
  try {
    printerInfo = await escpos.queryPrinter(opts.printerName);
  } catch { printerInfo = null; }

  let effectiveName = opts.printerName;
  if (!effectiveName) {
    const def = installed.find((p) => p.isDefault);
    if (def) {
      effectiveName = def.name;
      if (!printerInfo || printerInfo.name !== def.name) {
        printerInfo = printerInfo || { name: def.name, driverName: '', portName: '' };
      }
    }
  }

  // قد يتعذّر الاستعلام عن التعريف (PowerShell محظور مثلًا)، فنكتفي باسم الطابعة
  const thermal = escpos.looksThermal(printerInfo) || escpos.looksThermal({ name: effectiveName });
  const wantsRaw = opts.mode === 'escpos' || (opts.mode === 'auto' && thermal);

  // ٣) المسار المباشر ESC/POS
  let rawError = null;
  if (wantsRaw && escpos.IS_WINDOWS) {
    const target = { ...opts, printerName: effectiveName, jobName: opts.jobName };
    const rawRes = await printViaEscPos(target, printerInfo);
    if (rawRes.ok) {
      return {
        ...rawRes,
        thermal,
        requestedMode: opts.mode
      };
    }
    rawError = rawRes.error;
  }

  // ٤) الاحتياطي: تعريف ويندوز (حتى لو اختار المستخدم ESC/POS، الأولى ألا تضيع الفاتورة)
  const driverRes = await printViaDriver({ ...opts, printerName: effectiveName });
  if (driverRes.ok) return { ...driverRes, fallbackError: rawError || null, thermal };
  return {
    ...driverRes,
    mode: driverRes.mode || 'driver',
    error: rawError ? `${driverRes.error || 'فشلت الطباعة'} — ${rawError}` : driverRes.error,
    fallbackError: rawError || null,
    printer: effectiveName,
    driverName: printerInfo ? printerInfo.driverName : '',
    portName: printerInfo ? printerInfo.portName : '',
    thermal
  };
}

/** معاينة الفاتورة في نافذة مرئية (بدون طباعة). */
async function previewHtml(options) {
  const { html, title = 'معاينة الفاتورة' } = options || {};
  if (!html) return { ok: false, error: 'لا يوجد محتوى' };
  const file = writeTempHtml(injectFonts(html));
  const win = createPrintWindow(true);
  win.setTitle(title);
  win.setSize(480, 900);
  await loadIntoWindow(win, file);
  cleanup(file);
  return { ok: true };
}

/**
 * حفظ PDF من نفس HTML (Chromium هو من يرسم النص العربي بخطوطه المضمّنة).
 *
 * مهم: صفحة `printToPDF` تُقاس بالبوصة — لا بالميكرون ولا بالمليمتر.
 * كان تمرير المليمترات × 1000 يجعل الصفحة ضخمة فيُضغط المحتوى ويظهر النص
 * بلا تنسيق وغير مقروء. هنا نحول بدقة: بوصة = مم ÷ 25.4.
 */
async function savePdf(options) {
  const { html, filePath, widthMm, heightMm } = options || {};
  if (!html) { return { ok: false, error: 'لا يوجد محتوى' }; }
  const MM_PER_INCH = 25.4;
  const marginMm = Math.max(0, Number(options.marginMm) || 0);
  const file = writeTempHtml(injectFonts(html));
  const win = createPrintWindow(false);
  try {
    await loadIntoWindow(win, file);
    const width = (Number(widthMm) || 210) / MM_PER_INCH;
    let height;
    if (heightMm) {
      height = Number(heightMm) / MM_PER_INCH;
    } else {
      // فاتورة حرارية: ارتفاع الصفحة = ارتفاع المحتوى الفعلي حتى لا تُقص
      const measured = await measure(win);
      const contentMm = Math.max(30, Math.ceil(measured.height * (25400 / 96) / 1000) + 4);
      height = contentMm / MM_PER_INCH;
    }
    const margin = marginMm / MM_PER_INCH;
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: false,
      margins: { top: margin, bottom: margin, left: margin, right: margin },
      pageSize: { width, height }
    });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, pdf);
    return { ok: true, filePath, bytes: pdf.length };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
    cleanup(file);
  }
}

/* ------------------------------ صفحة الاختبار ------------------------------ */
function testPageHtml(opts, diag) {
  const width = opts.widthMm;
  const content = Math.max(24, width <= 60 ? width - 10 : width - 8);
  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
  <style>
    @page { size: ${width}mm auto; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; }
    body { width: ${content}mm; margin: 0 auto; padding: 2mm; font-family: 'Cairo', Tahoma, sans-serif;
           font-size: ${width <= 62 ? 10 : 12}px; color: #000; direction: rtl; text-align: right; }
    .c { text-align: center; }
    .b { font-weight: 700; }
    .big { font-size: ${width <= 62 ? 15 : 18}px; font-weight: 800; }
    .hr { border-top: 1px dashed #000; margin: 4px 0; }
    .row { display: flex; justify-content: space-between; gap: 6px; }
    .mono { font-variant-numeric: tabular-nums; }
    .box { border: 2px solid #000; padding: 2px 4px; margin: 4px 0; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; }
    .grid span { border: 1px solid #000; height: 6mm; }
  </style></head><body>
    <div class="c b big">اختبار الطباعة الحرارية</div>
    <div class="c">POS Pro — ${new Date().toLocaleString('en-GB')}</div>
    <div class="hr"></div>
    <div class="row"><span>مقاس الورق</span><span class="b">${width} مم</span></div>
    <div class="row"><span>عرض الطباعة</span><span class="b mono">${diag.dots} نقطة</span></div>
    <div class="row"><span>الدقة</span><span class="mono">${diag.dpi} dpi</span></div>
    <div class="row"><span>المسار</span><span class="b">${diag.mode === 'escpos' ? 'ESC/POS مباشر (RAW)' : 'تعريف ويندوز'}</span></div>
    <div class="row"><span>الطابعة</span><span class="mono">${escapeHtml(diag.printer || 'الافتراضية')}</span></div>
    <div class="row"><span>التعريف</span><span class="mono">${escapeHtml(diag.driverName || '—')}</span></div>
    <div class="row"><span>المنفذ</span><span class="mono b">${escapeHtml(diag.portName || '—')}</span></div>
    <div class="hr"></div>
    <div class="box mono">0123456789 ABCDEFGH</div>
    <div class="box">أبجد هوز حطي كلمن سعفص قرشت</div>
    <div class="hr"></div>
    <table style="width:100%;border-collapse:collapse">
      <tr><td>صنف تجريبي</td><td class="mono" style="text-align:left">2 × 15.00</td></tr>
      <tr><td>صنف آخر</td><td class="mono" style="text-align:left">1 × 7.50</td></tr>
      <tr><td class="b">الإجمالي</td><td class="b mono" style="text-align:left">37.50</td></tr>
    </table>
    <div class="hr"></div>
    <div class="grid"><span></span><span></span><span></span><span></span></div>
    <div class="c b" style="margin-top:4px">إذا ظهرت هذه الورقة فالطباعة سليمة</div>
    <div class="c">— نهاية الاختبار —</div>
  </body></html>`;
}

async function printTestPage(printerName, paperWidth, extra = {}) {
  const opts = normalizeOptions({ ...extra, paperWidth, printerName });
  const metrics = escpos.paperMetrics({ widthMm: opts.widthMm, dpi: opts.dpi, dots: opts.dots });
  let info = null;
  try { info = await escpos.queryPrinter(opts.printerName); } catch { info = null; }
  const html = testPageHtml(opts, {
    dots: metrics.dots,
    dpi: metrics.dpi,
    mode: opts.mode === 'escpos' ? 'escpos' : (opts.mode === 'auto' ? (escpos.looksThermal(info) ? 'escpos' : 'driver') : 'driver'),
    printer: opts.printerName || (info && info.name) || '',
    driverName: info ? info.driverName : '',
    portName: info ? info.portName : ''
  });
  return printHtml({ ...opts, html, copies: 1, jobName: 'صفحة اختبار' });
}

/* ------------------------ طباعة التقارير على ورق A4 ------------------------ */
function ensureA4Page(html) {
  const styled = injectFonts(html);
  if (/@page/i.test(styled)) return styled;
  return /<\/head>/i.test(styled)
    ? styled.replace(/<\/head>/i, '<style>@page{size:A4;margin:10mm}</style></head>')
    : `<style>@page{size:A4;margin:10mm}</style>${styled}`;
}

/**
 * طباعة تقرير A4 عبر تعريف ويندوز (تقسيم صفحات تلقائي).
 * options: { html, printerName, copies, jobName }
 */
async function printA4(options = {}) {
  if (!options.html || typeof options.html !== 'string') return { ok: false, error: 'لا يوجد محتوى للطباعة' };
  let installed = [];
  try {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    installed = win ? await win.webContents.getPrintersAsync() : await listPrinters();
  } catch { installed = []; }
  if (!installed || installed.length === 0) {
    return { ok: false, error: 'لا توجد طابعات مثبتة على هذا الجهاز. ثبّت الطابعة من إعدادات ويندوز ثم أعد المحاولة.' };
  }
  const printerName = String(options.printerName || '') ||
    ((installed.find((p) => p.isDefault) || installed[0] || {}).name || '');
  const file = writeTempHtml(ensureA4Page(options.html));
  const win = createPrintWindow(false);
  let submitted = false;
  try {
    await loadIntoWindow(win, file);
    const printOpts = {
      silent: true,
      deviceName: printerName || undefined,
      printBackground: true,
      margins: { marginType: 'default' },
      pageSize: 'A4',
      copies: Math.max(1, Math.min(5, Number(options.copies) || 1)),
      header: false,
      footer: false
    };
    return await new Promise((resolve) => {
      submitted = true;
      const timer = setTimeout(() => {
        resolve({ ok: false, mode: 'a4', error: 'انتهت مهلة الطباعة دون استجابة من نظام التشغيل' });
      }, 45000);
      win.webContents.print(printOpts, (success, failureReason) => {
        clearTimeout(timer);
        if (success) resolve({ ok: true, mode: 'a4', printer: printerName, paper: 'A4' });
        else resolve({ ok: false, mode: 'a4', error: failureReason || 'رفض نظام التشغيل مهمة الطباعة' });
      });
    });
  } catch (err) {
    return { ok: false, mode: 'a4', error: err.message || String(err) };
  } finally {
    if (!win.isDestroyed()) {
      setTimeout(() => {
        try { win.destroy(); } catch { /* ignore */ }
      }, submitted ? 6000 : 0).unref?.();
    }
    cleanup(file);
  }
}

/** تشخيص كامل: قائمة الطابعات + تعريفها + منفذها + التوصية. */
async function diagnose(printerName) {
  const printers = await escpos.printerDetails();
  const target = printerName
    ? printers.find((p) => p.name === printerName) || null
    : printers.find((p) => p.isDefault) || printers[0] || null;
  const thermal = target ? escpos.looksThermal(target) : false;
  return {
    ok: true,
    platform: process.platform,
    printers,
    target,
    thermal,
    recommendedMode: thermal ? 'escpos' : 'driver',
    powershell: escpos.IS_WINDOWS
  };
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

module.exports = {
  listPrinters, printHtml, printA4, previewHtml, savePdf, printTestPage, diagnose,
  printWindowDir: tmpDir, injectFonts, normalizeOptions
};
