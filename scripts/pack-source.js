'use strict';
/**
 * إنشاء أرشيف السورس الكامل للنسخة الحالية (بلا node_modules ولا dist).
 * الاستخدام: node scripts/pack-source.js
 * الناتج: dist/POS-Pro-Source-v<VERSION>-b<NNN>.zip
 *
 * كاتب ZIP بسيط بلا اعتماديات (تخزين مباشر بدون ضغط) ليعمل على كل الأنظمة.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

let build = 'b001';
const buildJson = path.join(dist, 'POS Pro-win32-x64', 'resources', 'build.json');
if (fs.existsSync(buildJson)) {
  try { build = JSON.parse(fs.readFileSync(buildJson, 'utf8')).build || build; } catch { /* ignore */ }
}

const files = [
  'package.json', 'package-lock.json', 'tailwind.config.js',
  'BUILD.md', 'README.md', 'CHANGELOG.md',
  'build/icon.ico', 'build/icon.png', 'assets/app-icon.ico'
];
for (const dir of ['electron', 'renderer', 'scripts', 'test']) {
  const walk = (rel) => {
    for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const relPath = path.join(rel, ent.name);
      if (ent.isDirectory()) walk(relPath);
      else files.push(relPath.split(path.sep).join('/'));
    }
  };
  walk(dir);
}
const listed = files.filter((f) => fs.existsSync(path.join(root, f)));

/* CRC32 */
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const now = new Date();
const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

const locals = [];
const centrals = [];
let offset = 0;
for (const name of listed) {
  const data = fs.readFileSync(path.join(root, name));
  const nameBuf = Buffer.from(name, 'utf8');
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);              // version needed
  local.writeUInt16LE(0x0800, 6);          // UTF-8 names
  local.writeUInt16LE(useDeflate ? 8 : 0, 8);
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, nameBuf, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);            // version made by
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(useDeflate ? 8 : 0, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, nameBuf);

  offset += local.length + nameBuf.length + body.length;
}

const centralDir = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(listed.length, 8);
end.writeUInt16LE(listed.length, 10);
end.writeUInt32LE(centralDir.length, 12);
end.writeUInt32LE(offset, 16);

fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, `POS-Pro-Source-v${pkg.version}-${build}.zip`);
fs.rmSync(out, { force: true });
fs.writeFileSync(out, Buffer.concat([...locals, centralDir, end]));

const mb = (fs.statSync(out).size / (1024 * 1024)).toFixed(1);
console.log(`✓ أرشيف السورس: dist/${path.basename(out)} (${mb} MB، ${listed.length} ملفًا)`);
