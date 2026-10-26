'use strict';
/**
 * تجهيز أيقونة التطبيق داخل مجلد build:
 *   build/icon.ico  → أيقونة البرنامج الافتراضية (النافذة، ملف exe، المثبّت)
 *   build/icon.png  → نسخة PNG كبيرة لعرضها في صفحة «عن البرنامج» وأيقونة الصفحة
 *
 * المصدر المعتمد هو assets/app-icon.ico (الأيقونة المرفقة من صاحب البرنامج).
 * إن لم يوجد المصدر نرسم أيقونة بديلة برمجيًا حتى لا يفشل البناء.
 *
 * الاستخدام: node scripts/make-icon.js
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build');
const RENDERER_IMG = path.join(ROOT, 'renderer', 'img');
const SOURCE_ICO = path.join(ROOT, 'assets', 'app-icon.ico');
const SIZE = 256;

/* ------------------------------ PNG ------------------------------ */
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function pngFromRgba(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* --------------------- قراءة إطارات ملف ICO --------------------- */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (buf) => buf.length > 8 && buf.slice(0, 8).equals(PNG_SIG);

function icoFrames(buf) {
  if (buf.length < 6 || buf.readUInt16LE(2) !== 1) return [];
  const count = buf.readUInt16LE(4);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    if (entry + 16 > buf.length) break;
    const width = buf[entry] || 256;
    const height = buf[entry + 1] || 256;
    const size = buf.readUInt32LE(entry + 8);
    const offset = buf.readUInt32LE(entry + 12);
    if (!size || offset + size > buf.length) continue;
    frames.push({ width, height, data: buf.slice(offset, offset + size) });
  }
  return frames;
}

/** تحويل إطار DIB (BMP) داخل ICO إلى RGBA (الصفوف بالأسفل أولًا + قناع الشفافية). */
function dibToRgba(frame) {
  const data = frame.data;
  if (data.length < 40) return null;
  const headerSize = data.readUInt32LE(0);
  const width = data.readInt32LE(4);
  const height = Math.abs(data.readInt32LE(8)) / 2;
  const bitCount = data.readUInt16LE(14);
  const compression = data.readUInt32LE(16);
  if (compression !== 0 || width <= 0 || height <= 0) return null;
  if (bitCount !== 32 && bitCount !== 24 && bitCount !== 8) return null;

  const paletteCount = bitCount === 8 ? (data.readUInt32LE(32) || 256) : 0;
  const pixelOffset = headerSize + paletteCount * 4;
  const stride = (((width * bitCount) + 31) >> 5) * 4;
  if (pixelOffset + stride * height > data.length) return null;

  const rgba = Buffer.alloc(width * height * 4);
  let rawAlpha = false;
  for (let y = 0; y < height; y++) {
    const src = pixelOffset + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (bitCount === 8) {
        const idx = data[src + x];
        const p = headerSize + idx * 4;
        rgba[i] = data[p + 2] || 0;
        rgba[i + 1] = data[p + 1] || 0;
        rgba[i + 2] = data[p] || 0;
        rgba[i + 3] = 255;
      } else {
        const s = src + x * (bitCount / 8);
        rgba[i] = data[s + 2];       // R
        rgba[i + 1] = data[s + 1];   // G
        rgba[i + 2] = data[s];       // B
        const a = bitCount === 32 ? data[s + 3] : 255;
        if (a) rawAlpha = true;
        rgba[i + 3] = a;
      }
    }
  }

  // بعض أيقونات 32-bit تترك قناة الشفافية صفرية: نأخذ الشفافية من قناع AND
  if (bitCount === 32 && !rawAlpha) {
    const maskStride = ((width + 31) >> 5) * 4;
    const maskStart = pixelOffset + stride * height;
    if (maskStart + maskStride * height <= data.length) {
      for (let y = 0; y < height; y++) {
        const row = maskStart + (height - 1 - y) * maskStride;
        for (let x = 0; x < width; x++) {
          const bit = (data[row + (x >> 3)] >> (7 - (x & 7))) & 1;
          rgba[(y * width + x) * 4 + 3] = bit ? 0 : 255;
        }
      }
    }
  }
  return { rgba, width, height };
}

/** أكبر إطار في الملف → PNG (يُفضّل 256×256). */
function bestPngFromIco(buf) {
  const frames = icoFrames(buf);
  if (!frames.length) return null;
  const exact = frames.filter((f) => f.width === SIZE && f.height === SIZE);
  const pool = exact.length ? exact : frames.slice();
  pool.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  for (const frame of pool) {
    if (isPng(frame.data)) return frame.data;
    const decoded = dibToRgba(frame);
    if (decoded) return pngFromRgba(decoded.rgba, decoded.width, decoded.height);
  }
  return null;
}

function toIco(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = size === 256 ? 0 : size;
  entry[1] = size === 256 ? 0 : size;
  entry[2] = 0; entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuffer]);
}

/* ------------------ أيقونة بديلة (احتياطية فقط) ------------------ */
function drawFallback() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    const i = (y * SIZE + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const radius = 52;
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, radius), SIZE - 1 - radius);
    const cy = Math.min(Math.max(y, radius), SIZE - 1 - radius);
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!inRounded(x, y)) { set(x, y, 0, 0, 0, 0); continue; }
      const t = (x + y) / (2 * SIZE);
      set(x, y, Math.round(16 + t * 10), Math.round(185 - t * 50), Math.round(129 - t * 30), 255);
    }
  }
  const rx = 68, ry = 46, rw = 120, rh = 150, zig = 14, teeth = 6;
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      let skip = false;
      if (y >= ry + rh - zig) {
        const phase = ((x - rx) / rw * teeth) % 1;
        skip = phase < 0.5;
      }
      if (!skip) set(x, y, 255, 255, 255, 255);
    }
  }
  for (let i = 0; i < 4; i++) {
    const ly = ry + 30 + i * 28;
    const lw = i === 3 ? 60 : 84;
    for (let y = ly; y < ly + 10; y++) {
      for (let x = rx + 20; x < rx + 20 + lw; x++) set(x, y, 16, 185, 129, 255);
    }
  }
  for (let y = ry + 132; y < ry + 144; y++) {
    for (let x = rx + 20; x < rx + 100; x++) set(x, y, 15, 23, 42, 255);
  }
  return pngFromRgba(px, SIZE, SIZE);
}

/* ------------------------------ التنفيذ ------------------------------ */
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(RENDERER_IMG, { recursive: true });

let png = null;
let ico = null;

if (fs.existsSync(SOURCE_ICO)) {
  const source = fs.readFileSync(SOURCE_ICO);
  ico = source;
  png = bestPngFromIco(source);
  if (!png) console.warn('⚠ تعذّر استخراج PNG من assets/app-icon.ico — سيُستخدم PNG بديل');
}

if (!png) png = drawFallback();
if (!ico) ico = toIco(png, SIZE);

fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
fs.writeFileSync(path.join(RENDERER_IMG, 'app-icon.png'), png);

console.log('تم تجهيز build/icon.ico و build/icon.png و renderer/img/app-icon.png'
  + ' (' + png.length + ' بايت PNG)');
