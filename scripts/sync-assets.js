'use strict';
/**
 * نسخ الأصول المحلية من node_modules إلى renderer (بدل CDN).
 * يعمل مرة واحدة عند التجهيز أو بعد تثبيت الاعتماديات.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const fontDir = path.join(root, 'renderer', 'fonts');
const vendorDir = path.join(root, 'renderer', 'vendor');
fs.mkdirSync(fontDir, { recursive: true });
fs.mkdirSync(vendorDir, { recursive: true });

const fontSrc = path.join(root, 'node_modules', '@fontsource', 'cairo', 'files');
const weights = [400, 600, 700, 800];
const subsets = ['arabic', 'latin'];
let count = 0;
for (const w of weights) {
  for (const sub of subsets) {
    const from = path.join(fontSrc, `cairo-${sub}-${w}-normal.woff2`);
    const to = path.join(fontDir, `cairo-${sub}-${w}.woff2`);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, to);
      count++;
    }
  }
}

const barcode = path.join(root, 'node_modules', 'jsbarcode', 'dist', 'JsBarcode.all.min.js');
if (fs.existsSync(barcode)) {
  fs.copyFileSync(barcode, path.join(vendorDir, 'jsbarcode.min.js'));
  count++;
}

console.log(`تم نسخ ${count} ملفًا إلى renderer/fonts و renderer/vendor`);
