'use strict';
/**
 * ضغط حزمة ويندوز باسم مرقّم حتى يسهل التمييز بين النسخ.
 *
 *   dist/POS-Pro-Windows-v2.0.0-b001.zip
 *   dist/POS-Pro-Windows-v2.0.0-b002.zip
 *
 * الرقم يتزايد تلقائيًا مع كل بناء (يُقرأ من أسماء الملفات الموجودة في dist)،
 * ورقم الإصدار يُقرأ من package.json.
 *
 * قبل الضغط يُكتب `resources/build.json` داخل مجلد الحزمة، فيعرض البرنامج
 * رقم الإصدار ورقم البناء في عنوان النافذة وفي شاشة الإعدادات.
 *
 * الاستخدام:
 *   npm run zip:win     (بعد npm run pack:win)
 *   npm run dist:win    (يجمعهما معًا)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const APP_DIR = 'POS Pro-win32-x64';

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '0.0.0');

if (!fs.existsSync(path.join(dist, APP_DIR))) {
  console.error(`✗ لم يُعثر على مجلد البناء: dist/${APP_DIR}`);
  console.error('  شغّل أولًا: npm run pack:win');
  process.exit(1);
}

/* أكبر رقم بناء موجود + 1 (٣ خانات ليبقى الترتيب الأبجدي صحيحًا) */
function nextBuildNumber() {
  let max = 0;
  for (const name of fs.readdirSync(dist)) {
    const match = name.match(new RegExp(`^POS-Pro-Windows-v[^-]+-b(\\d+)\\.zip$`));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

// يمكن تثبيت رقم البناء صراحة عند البناء على جهاز جديد بلا أرشيفات سابقة:
//   POS_BUILD_NUMBER=12 npm run zip:win
const explicitBuild = Number(process.env.POS_BUILD_NUMBER);
const build = Number.isFinite(explicitBuild) && explicitBuild > 0 ? explicitBuild : nextBuildNumber();
const padded = String(build).padStart(3, '0');
const zipName = `POS-Pro-Windows-v${version}-b${padded}.zip`;
const zipPath = path.join(dist, zipName);

console.log(`› ضغط النسخة v${version} — بناء رقم ${padded}`);

/* رقم البناء داخل البرنامج — يُقرأ من resources/build.json عند التشغيل */
const resourcesDir = path.join(dist, APP_DIR, 'resources');
fs.mkdirSync(resourcesDir, { recursive: true });
fs.writeFileSync(
  path.join(resourcesDir, 'build.json'),
  JSON.stringify({ version, build: `b${padded}`, number: build, date: new Date().toISOString().slice(0, 10) }, null, 2),
  'utf8'
);

let res;
if (process.platform === 'win32') {
  res = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path '${path.join(dist, APP_DIR)}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`
  ], { stdio: 'inherit' });
} else {
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  res = spawnSync('zip', ['-rq', zipName, APP_DIR], { cwd: dist, stdio: 'inherit' });
  if (res.error) {
    console.error('✗ تعذّر تشغيل أداة zip. ثبّتها أو استخدم ويندوز (Compress-Archive).');
    process.exit(1);
  }
}

if (res.status !== 0 || !fs.existsSync(zipPath)) {
  console.error('✗ فشل الضغط (رمز الخروج ' + res.status + ')');
  process.exit(res.status || 1);
}

const sizeMb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
console.log(`✓ الملف الجاهز: dist/${zipName} (${sizeMb} MB)`);
if (!process.env.POS_BUILD_NO_HINT) {
  console.log(`  نسخة v${version} — بناء ${padded} على ${os.type()}`);
}
