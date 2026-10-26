'use strict';
/**
 * إنشاء حزمة تحديث محلي من البناء الحالي:
 *   dist/POS-Pro-Update-v2.1.0-b005-20261023T1430.zip
 *
 * التغيير الجديد:
 *   - يُضاف رقم حزمة تزايدية (مستقل عن رقم البناء).
 *   - يُضاف رقم البناء (bNNN) وحقق.
 *   - يُضاف تاريخ ووقت مضغوط 되었으면 في النهاية (YYYYMMDDTHHmm).
 *   - يُمحى أسماء التحديثات القديمة 비정상ة نهائيًا عند الإنشاء.
 *   - يُحذف أي mلف تحديث ذاتيّ يبقى قبل الإنشاء الجديد.
 *   - تُكتب ملفات التحرير القديمة (build.json, manifest) في الـ tmp ثم تُنسخ.
 *   - يبقى التحديث واحدًا فقط لكل نسخة برمجية، تحذف القديمة قبل جعل الجديد.
 *
 * الاستخدام:
 *   npm run update:win         (بعد npm run pack:win && npm run zip:win)
 *   npm run dist:win           (الثلاثة معًا)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const APP_DIR = 'POS Pro-win32-x64';
const resources = path.join(dist, APP_DIR, 'resources');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '0.0.0');

const asarPath = path.join(resources, 'app.asar');
if (!fs.existsSync(asarPath)) {
  console.error(`✗ لم يُعثر على ${path.relative(root, asarPath)}`);
  console.error('  شغّل أولًا: npm run pack:win');
  process.exit(1);
}

/** رقم البناء من build.json، أو أكبر رقم موجود في أسماء الأرشيفات. */
function currentBuild() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(resources, 'build.json'), 'utf8'));
    if (info && info.build) {
      return {
        build: String(info.build),
        number: Number(info.number) || 0,
        version: String(info.version || version)
      };
    }
  } catch { /* لا يوجد build.json */ }
  let max = 0;
  for (const name of fs.readdirSync(dist)) {
    const match = name.match(/-b(\\d+)\\.zip$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  const number = max + 1;
  return { build: `b${String(number).padStart(3, '0')}`, number, version };
}

/** رقم حزمة التحديث المتزايد (مستقل، يبدأ من 001 ويزيد مع كل إنشاء). */
function nextUpdatePackageNumber() {
  let max = 0;
  for (const name of fs.readdirSync(dist)) {
    const match = name.match(/^POS-Pro-Update-v[^-]+-b\d+-(\d{10}T\d{4})\.zip$/);
    if (match) {
      const ts = Number(match[1].replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})$/, '$1$2$3$4$5'));
      if (Number.isFinite(ts)) max = Math.max(max, ts);
    }
  }
  const now = new Date();
  let ts = `${String(now.getFullYear()).padStart(4, '0')}${
    String(now.getMonth() + 1).padStart(2, '0')}${
    String(now.getDate()).padStart(2, '0')}T${
    String(now.getHours()).padStart(2, '0')}${
    String(now.getMinutes()).padStart(2, '0')}`;
  if (Number(ts) <= max) {
    now.setMinutes(now.getMinutes() + 1);
    ts = `${String(now.getFullYear()).padStart(4, '0')}${
      String(now.getMonth() + 1).padStart(2, '0')}${
      String(now.getDate()).padStart(2, '0')}T${
      String(now.getHours()).padStart(2, '0')}${
      String(now.getMinutes()).padStart(2, '0')}`;
  }
  return ts;
}

const info = currentBuild();
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(asarPath)).digest('hex');
const size = fs.statSync(asarPath).size;

const ts = nextUpdatePackageNumber();
const zipName = `POS-Pro-Update-v${info.version}-${info.build}-${ts}.zip`;
const zipPath = path.join(dist, zipName);
fs.rmSync(zipPath, { force: true });

// حذف ملفات التحديث القديمة حتى تبقى أحدث حزمة فقط
const legacyPattern = /^POS-Pro-Update-v/;
for (const name of fs.readdirSync(dist)) {
  if (legacyPattern.test(name) && name !== zipName) {
    try { fs.rmSync(path.join(dist, name), { force: true }); } catch { /* Ignore */ }
  }
}

const staging = path.join(dist, '.update-stage');
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

/** أحدث قسم في CHANGELOG.md — يُعرض داخل نافذة التحديث قبل التثبيت. */
function latestChangelog() {
  try {
    const text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const blocks = text.split(/^##\s+/m).slice(1);
    if (!blocks.length) return [];
    const first = blocks[0].split(/^##\s+/m)[0];
    return first.split('\n').slice(1)
      .map((line) => line.replace(/^[-*]\s*/, '').trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('<!--'))
      .slice(0, 20);
  } catch {
    return [];
  }
}

const dateStr = new Date().toISOString().slice(0, 10);
const manifest = {
  app: 'pos-pro',
  version: info.version,
  build: info.build,
  number: info.number,
  sha256,
  size,
  date: dateStr,
  package: ts,
  changelog: latestChangelog()
};
fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
fs.writeFileSync(path.join(staging, 'build.json'), JSON.stringify({
  version: info.version, build: info.build, number: info.number, date: dateStr, package: ts
}, null, 2), 'utf8');
fs.copyFileSync(asarPath, path.join(staging, 'app.asar'));

console.log(`› إنشاء حزمة التحديث ${info.version} ${info.build} - ${ts}`);
let res;
if (process.platform === 'win32') {
  res = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path '${path.join(staging, '*')}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`
  ], { stdio: 'inherit' });
} else {
  res = spawnSync('zip', ['-rq', zipPath, '.'], { cwd: staging, stdio: 'inherit' });
}
fs.rmSync(staging, { recursive: true, force: true });

if (res.status !== 0 || !fs.existsSync(zipPath)) {
  console.error('✗ فشل إنشاء حزمة التحديث (رمز الخروج ' + res.status + ')');
  process.exit(res.status || 1);
}

const mb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
console.log(`✓ حزمة التحديث: dist/${zipName} (${mb} MB)`);
console.log(`  sha256: ${sha256.slice(0, 16)}…`);
console.log(`  تم حذف ملفات التحديث القديمة تلقائيًا`);
