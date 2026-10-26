'use strict';
/**
 * بناء مثبّت ويندوز (EXE) من مجلد البناء الحالي:
 *   dist/POS-Pro-Setup-v2.1.0-b007.exe
 *
 * يعتمد على مجلد البناء الذي ينتجه `npm run pack:win` (وفيه resources/build.json)،
 * ويستخدم NSIS على لينكس (makensis) — لا يحتاج wine ولا ويندوز.
 *
 * الاستخدام:
 *   npm run pack:win && npm run installer:win
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const APP_DIR = path.join('dist', 'POS Pro-win32-x64');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '0.0.0');

if (!fs.existsSync(path.join(root, APP_DIR))) {
  console.error(`✗ لم يُعثر على مجلد البناء ${APP_DIR}`);
  console.error('  شغّل أولًا: npm run pack:win');
  process.exit(1);
}
const buildJsonPath = path.join(root, APP_DIR, 'resources', 'build.json');
let build = 'b000';
if (fs.existsSync(buildJsonPath)) {
  try { build = JSON.parse(fs.readFileSync(buildJsonPath, 'utf8')).build || build; } catch { /* ignore */ }
}
if (!fs.existsSync(path.join(root, 'build', 'icon.ico'))) {
  console.log('› إنشاء الأيقونة…');
  spawnSync(process.execPath, [path.join(root, 'scripts', 'make-icon.js')], { stdio: 'inherit' });
}

/* إيجاد makensis: متغير بيئة، ثم نسخة electron-builder، ثم النظام */
function findMakensis() {
  if (process.env.NSIS_MAKENSIS && fs.existsSync(process.env.NSIS_MAKENSIS)) return process.env.NSIS_MAKENSIS;
  const cache = path.join(os.homedir(), '.cache', 'electron-builder');
  if (fs.existsSync(cache)) {
    for (const dir of fs.readdirSync(cache)) {
      if (!dir.startsWith('nsis-')) continue;
      const base = path.join(cache, dir);
      for (const sub of fs.readdirSync(base)) {
        const candidate = path.join(base, sub, 'linux', 'makensis');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  const which = spawnSync('which', ['makensis'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return null;
}

const makensis = findMakensis();
if (!makensis) {
  console.error('✗ لم يُعثر على makensis. ثبّت NSIS أو شغّل electron-builder مرة واحدة لتنزيله.');
  process.exit(1);
}

const outFile = path.join(dist, `POS-Pro-Setup-v${version}-${build}.exe`);
try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }

console.log(`› بناء المثبّت ${version} ${build}…`);
const res = spawnSync(makensis, [
  '-V3',
  `-DVERSION=${version}`,
  `-DBUILD=${build}`,
  `-DAPP_DIR=${path.join(root, APP_DIR)}`,
  `-DOUT_FILE=${outFile}`,
  `-DICON_FILE=${path.join(root, 'build', 'icon.ico')}`,
  path.join('scripts', 'installer.nsi')
], {
  cwd: root,
  stdio: 'inherit',
  timeout: 10 * 60 * 1000,
  // NSIS يحتاج مجلد Stubs/Include/Plugins المجاور لتنفيذ makensis
  env: { ...process.env, NSISDIR: path.dirname(path.dirname(makensis)) }
});

if (res.status !== 0 || !fs.existsSync(outFile)) {
  console.error('✗ فشل بناء المثبّت (رمز الخروج ' + res.status + ')');
  process.exit(res.status || 1);
}

const mb = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(1);
console.log(`✓ المثبّت: dist/${path.basename(outFile)} (${mb} MB)`);
