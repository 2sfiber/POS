'use strict';
/**
 * تشغيل الاختبار الشامل داخل Electron الحقيقي.
 * الاستخدام: npm test
 * ملاحظة: على أجهزة Linux التي لا تحتوي خطوط نظام، ينشئ السكربت إعداد fontconfig مؤقتًا
 * لأن Chromium يتعطّل عند رسم حقول الإدخال بدون أي خط مثبّت.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
/**
 * مسار مُنفِّذ Electron بشكل موثوق على كل الأنظمة:
 *  - require('electron') يعيد مسار electron(.exe/.app) مباشرة على ويندوز ولينكس وماك.
 *  - احتياطي: node_modules/.bin/electron(.cmd) لأن الملف بدون امتداد غير قابل للتشغيل على ويندوز.
 */
function resolveElectron() {
  try {
    const direct = require('electron');
    if (typeof direct === 'string' && fs.existsSync(direct)) return direct;
  } catch { /* نكمل إلى الاحتياطي */ }
  const binDir = path.join(root, 'node_modules', '.bin');
  const names = process.platform === 'win32'
    ? ['electron.cmd', 'electron.ps1', 'electron']
    : ['electron'];
  for (const name of names) {
    const candidate = path.join(binDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(binDir, process.platform === 'win32' ? 'electron.cmd' : 'electron');
}
const electron = resolveElectron();
const env = { ...process.env };

// قاعدة بيانات مؤقتة نظيفة لكل تشغيل
const tmpDb = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-test-db-'));
env.POS_HEADLESS = '1';
env.POS_TEST_SCRIPT = './test/smoke.js';
env.POS_DB_DIR = tmpDb;

// إعداد خطوط مؤقت إن لم يكن هناك fontconfig صالح
function hasSystemFonts() {
  try {
    const r = spawnSync('fc-list', { encoding: 'utf8' });
    return r.status === 0 && (r.stdout || '').includes(':');
  } catch { return false; }
}
function dirHasRealFonts(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
      .some((e) => e.isFile() && /\.(ttf|otf|ttc|pcf|pcf\.gz)$/i.test(e.name));
  } catch { return false; }
}
if (!hasSystemFonts() && !env.FONTCONFIG_FILE) {
  const fcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-fc-'));
  const candidates = [
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    path.join(os.homedir(), '.fonts'),
    path.join(os.homedir(), '.local', 'share', 'fonts'),
    path.join(os.homedir(), 'sysroot', 'usr', 'share', 'fonts')
  ];
  const fontDirs = candidates.filter((d) => fs.existsSync(d) && dirHasRealFonts(d));
  if (!fontDirs.length) {
    console.warn('⚠ لا توجد خطوط نظام على هذا الجهاز (تحتاج fonts-dejavu أو ما شابه)');
    console.warn('  Chromium قد يتعطّل عند رسم حقول الإدخال بدون أي خط مثبّت.');
  }
  const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
${fontDirs.map((d) => `  <dir>${d}</dir>`).join('\n')}
  <cachedir>${path.join(fcDir, 'cache')}</cachedir>
  <alias><family>sans-serif</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>serif</family><prefer><family>DejaVu Serif</family></prefer></alias>
</fontconfig>
`;
  fs.writeFileSync(path.join(fcDir, 'fonts.conf'), conf);
  env.FONTCONFIG_FILE = path.join(fcDir, 'fonts.conf');
  env.FONTCONFIG_PATH = fcDir;
  console.log('› تم إنشاء إعداد fontconfig مؤقت في', fcDir);
}

console.log('› تشغيل الاختبار الشامل…');
const res = spawnSync(electron, ['.', '--no-sandbox', '--ozone-platform=headless', '--disable-gpu'], {
  cwd: root,
  env,
  stdio: 'inherit',
  // ملفات .cmd على ويندوز تحتاج غلاف shell
  shell: process.platform === 'win32' && /\.cmd$/i.test(electron),
  timeout: 10 * 60 * 1000
});
fs.rmSync(tmpDb, { recursive: true, force: true });
if (res.error) {
  console.error('✗ تعذّر تشغيل Electron:', res.error.message);
  process.exit(1);
}
if (res.status !== 0) {
  console.error('✗ فشل الاختبار (رمز الخروج ' + res.status + ')');
  process.exit(res.status === null ? 1 : res.status);
}
console.log('✓ اجتاز الاختبار كل الفحوص');
