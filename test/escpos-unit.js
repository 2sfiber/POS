'use strict';
/* اختبار وحدات ترميز ESC/POS (لا يحتاج Electron ولا طابعة) — يُشغَّل بـ node */
const assert = require('node:assert');
const escpos = require('../electron/escpos');

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

console.log('[unit] escpos');

check('قياس 58 مم على 203 dpi = 384 نقطة', () => {
  const m = escpos.paperMetrics({ widthMm: 58, dpi: 203 });
  assert.strictEqual(m.dots, 384);
  assert.strictEqual(m.printableMm, 48);
});

check('قياس 80 مم على 203 dpi = 576 نقطة', () => {
  const m = escpos.paperMetrics({ widthMm: 80, dpi: 203 });
  assert.strictEqual(m.printableMm, 72);
  assert.strictEqual(m.dots, 576);
});

check('قياس مخصص 76 مم = 544 نقطة', () => {
  const m = escpos.paperMetrics({ widthMm: 76, dpi: 203 });
  assert.strictEqual(m.printableMm, 68);
  assert.strictEqual(m.dots, 544);
});

check('قياس 58 مم على 180 dpi', () => {
  const m = escpos.paperMetrics({ widthMm: 58, dpi: 180 });
  assert.strictEqual(m.dots, Math.round(48 * (180 / 25.4)));
});

check('تجاوز عدد النقاط يدويًا', () => {
  assert.strictEqual(escpos.paperMetrics({ widthMm: 80, dpi: 203, dots: 512 }).dots, 512);
  assert.strictEqual(escpos.paperMetrics({ widthMm: 80, dpi: 203, dots: 5000 }).dots, 1024);
});

check('تحويل البكسلات إلى نقاط أحادية اللون', () => {
  // 16 بكسل عرضًا، صفّان: الأول أسود كامل، الثاني أبيض كامل
  const width = 16;
  const height = 2;
  const bgra = Buffer.alloc(width * height * 4, 255);
  for (let x = 0; x < width; x++) {
    const i = x * 4;
    bgra[i] = 0; bgra[i + 1] = 0; bgra[i + 2] = 0; bgra[i + 3] = 255;
  }
  const raster = escpos.packRasterBitmap(bgra, width, height, 168);
  assert.strictEqual(raster.bytesPerRow, 2);
  assert.strictEqual(raster.data[0], 0xff);
  assert.strictEqual(raster.data[1], 0xff);
  assert.strictEqual(raster.data[2], 0x00);
  assert.strictEqual(raster.data[3], 0x00);
});

check('حذف الصفوف الفارغة في النهاية', () => {
  const width = 8;
  const height = 10;
  const bgra = Buffer.alloc(width * height * 4, 255);
  for (let x = 0; x < width; x++) {
    const i = x * 4;
    bgra[i] = 0; bgra[i + 1] = 0; bgra[i + 2] = 0;
  }
  const raster = escpos.trimRaster(escpos.packRasterBitmap(bgra, width, height, 168), 4);
  assert.strictEqual(raster.height, 4);
});

check('بناء أمر الصورة GS v 0 بالرأس الصحيح', () => {
  const raster = { data: Buffer.from([0xff, 0x00, 0x0f]), bytesPerRow: 1, height: 3, width: 8 };
  const block = escpos.buildRasterBlock(raster);
  assert.deepStrictEqual([...block.subarray(0, 8)], [0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x03, 0x00]);
  assert.strictEqual(block.length, 11);
});

check('مهمة كاملة: تهيئة + صورة + تغذية + قص', () => {
  const raster = { data: Buffer.alloc(48, 0xff), bytesPerRow: 48, height: 1, width: 384 };
  const job = escpos.buildEscPosJob(raster, { copies: 1, feedLines: 4, cut: true });
  assert.deepStrictEqual([...job.subarray(0, 2)], [0x1b, 0x40]);
  const headerAt = job.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
  assert.strictEqual(headerAt, 2);
  assert.deepStrictEqual([...job.subarray(headerAt + 4, headerAt + 8)], [48, 0, 1, 0]);
  // قص بعد تغذية 20 مم افتراضيًا (20 × 8 = 160 نقطة) لإخراج التذييل من شفرة القص
  assert.deepStrictEqual([...job.subarray(job.length - 4)], [0x1d, 0x56, 0x42, 160]);
  assert.ok(job.includes(Buffer.from([0x1b, 0x64, 4])));
});

check('تغذية القص تُحسب من المليمترات', () => {
  assert.deepStrictEqual([...escpos.cutCommand(20, 8)], [0x1d, 0x56, 0x42, 160]);
  assert.deepStrictEqual([...escpos.cutCommand(0, 8)], [0x1d, 0x56, 0x42, 0]);
  const hiRes = escpos.cutCommand(10, escpos.DOTS_PER_MM[300]);
  assert.strictEqual(hiRes[3], Math.round(10 * (300 / 25.4)));
});

check('تغذية القص الكبيرة تُقسم إلى أسطر + نقاط (حد الأمر 255)', () => {
  const cmd = escpos.cutCommand(40, 8); // 320 نقطة
  assert.deepStrictEqual([...cmd.subarray(0, 3)], [0x1b, 0x64, 10]);
  assert.deepStrictEqual([...cmd.subarray(cmd.length - 4)], [0x1d, 0x56, 0x42, 20]);
});

check('بدون قص: لا يُرسل أمر قص لكن الورق يتقدم', () => {
  const raster = { data: Buffer.alloc(48, 0xff), bytesPerRow: 48, height: 1, width: 384 };
  const job = escpos.buildEscPosJob(raster, { copies: 1, feedLines: 0, cut: false, cutFeedMm: 20 });
  assert.strictEqual(job.indexOf(Buffer.from([0x1d, 0x56, 0x42])), -1);
  assert.deepStrictEqual([...job.subarray(job.length - 3)], [0x1b, 0x64, 5]);
});

check('نسختان = صورتان + قصّان', () => {
  const raster = { data: Buffer.alloc(48, 0xff), bytesPerRow: 48, height: 1, width: 384 };
  const job = escpos.buildEscPosJob(raster, { copies: 2, feedLines: 4, cut: true });
  const count = (buf, seq) => {
    let n = 0, i = -1;
    while ((i = buf.indexOf(seq, i + 1)) >= 0) n++;
    return n;
  };
  assert.strictEqual(count(job, Buffer.from([0x1d, 0x76, 0x30, 0x00])), 2);
  assert.strictEqual(count(job, Buffer.from([0x1d, 0x56, 0x42])), 2);
});

check('تقسيم الصور الطويلة إلى كتل', () => {
  const raster = { data: Buffer.alloc(48 * 600, 0xff), bytesPerRow: 48, height: 600, width: 384 };
  const blocks = escpos.chunkRaster(raster, 256);
  assert.strictEqual(blocks.length, 3);
  assert.strictEqual(blocks[0].height, 256);
  assert.strictEqual(blocks[2].height, 88);
});

check('كشف الطابعات الحرارية من التعريف والمنفذ', () => {
  assert.strictEqual(escpos.looksThermal({ driverName: 'POS58 Printer', portName: 'PLT' }), true);
  assert.strictEqual(escpos.looksThermal({ driverName: 'XPrinter XP-80C', portName: 'USB001' }), true);
  assert.strictEqual(escpos.looksThermal({ driverName: '', portName: 'PLT' }), true);
  assert.strictEqual(escpos.looksThermal({ driverName: 'Generic / Text Only', portName: 'COM3' }), true);
  assert.strictEqual(escpos.looksThermal({ driverName: 'HP LaserJet Pro M404', portName: 'USB001' }), false);
  assert.strictEqual(escpos.looksThermal({ driverName: 'Microsoft Print to PDF', portName: 'PORTPROMPT:' }), false);
  assert.strictEqual(escpos.looksThermal(null), false);
});

check('قراءة نتائج الإرسال الخام برسائل عربية واضحة', () => {
  assert.deepStrictEqual(escpos.parseSpoolResult('OK:1024'), { ok: true, sent: 1024 });
  const openErr = escpos.parseSpoolResult('ERR:OPENPRINTER 1801');
  assert.strictEqual(openErr.ok, false);
  assert.ok(openErr.error.includes('فتح الطابعة') && openErr.error.includes('1801'), openErr.error);
  const writeErr = escpos.parseSpoolResult('ERR:WRITE 1722');
  assert.ok(writeErr.error.includes('منفذ الطابعة'), writeErr.error);
  assert.ok(escpos.parseSpoolResult('ERR:TIMEOUT').error.includes('مهلة'));
});

check('سكربت PowerShell يحتوي استدعاءات السولر الصحيحة ويُشفَّر سليمًا', () => {
  const script = escpos.helperScript();
  ['winspool.drv', 'OpenPrinterW', 'StartDocPrinterW', 'WritePrinter', 'RAW', 'ConvertFrom-Json',
    'FromBase64String', 'InputEncoding'].forEach((token) => {
    assert.ok(script.includes(token), 'ناقص: ' + token);
  });
  const b64 = escpos.encodePwsh(script);
  assert.strictEqual(Buffer.from(b64, 'base64').toString('utf16le'), script);
});

console.log(`[unit] ${passed} اختبارًا ناجحًا`);
