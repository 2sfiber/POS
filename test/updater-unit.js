'use strict';
/* اختبار وحدات التحديث المحلي — لا يحتاج ويندوز ولا شبكة (يُشغَّل بـ node). */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const updater = require('../electron/updater');

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
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✔', name);
  } catch (err) {
    console.error('  ✖', name, '—', err.message);
    process.exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-upd-test-'));
const appDir = path.join(tmp, 'app');
fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(path.join(appDir, 'index.js'), "'use strict';\nconsole.log('hi');\n");
// ملف بحجم واقعي حتى يجتاز فحص الحجم الأدنى في manifest
fs.writeFileSync(path.join(appDir, 'big.bin'), Buffer.alloc(300 * 1024, 7));
const asarPath = path.join(tmp, 'app.asar');

(async () => {
  await asar.createPackage(appDir, asarPath);
  console.log('[unit] updater');

  check('رفض manifest غير متعلق بالبرنامج', () => {
    const res = updater.validateManifest({ app: 'other', version: '1.0.0', sha256: 'a'.repeat(64), size: 200000 });
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.includes('POS Pro'), res.error);
  });

  check('رفض رقم إصدار غير صالح', () => {
    const res = updater.validateManifest({ app: 'pos-pro', version: 'v2', sha256: 'a'.repeat(64), size: 200000 });
    assert.strictEqual(res.ok, false);
  });

  check('رفض بصمة sha256 ناقصة', () => {
    const res = updater.validateManifest({ app: 'pos-pro', version: '2.0.0', sha256: 'xyz', size: 200000 });
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.includes('sha256'), res.error);
  });

  check('رفض حجم غير منطقي', () => {
    const res = updater.validateManifest({ app: 'pos-pro', version: '2.0.0', sha256: 'a'.repeat(64), size: 10 });
    assert.strictEqual(res.ok, false);
  });

  check('قبول manifest سليم', () => {
    const res = updater.validateManifest({ app: 'pos-pro', version: '2.1.0', sha256: 'a'.repeat(64), size: 2000000 });
    assert.strictEqual(res.ok, true, res.error);
  });

  check('تمييز ملف asar الحقيقي عن ملف نصي', () => {
    assert.strictEqual(updater.isAsarFile(asarPath), true);
    const txt = path.join(tmp, 'fake.asar');
    fs.writeFileSync(txt, 'this is not an asar archive at all');
    assert.strictEqual(updater.isAsarFile(txt), false);
  });

  // تجهيز حزمة تحديث وهمية واختبار التثبيت المؤجل على مجلد موارد مؤقت
  const staging = path.join(tmp, 'stage');
  fs.mkdirSync(staging, { recursive: true });
  const sha = updater.sha256File(asarPath);
  const size = fs.statSync(asarPath).size;
  fs.copyFileSync(asarPath, path.join(staging, 'app.asar'));
  fs.writeFileSync(path.join(staging, 'build.json'), JSON.stringify({ version: '2.1.0', build: 'b900', number: 900 }));
  fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({
    app: 'pos-pro', version: '2.1.0', build: 'b900', number: 900, sha256: sha, size, date: '2026-10-23'
  }));
  const zipPath = path.join(tmp, 'update.zip');
  const zipped = spawnSync('zip', ['-rq', zipPath, '.'], { cwd: staging });

  await new Promise((r) => setTimeout(r, 400)); // انتظار إنشاء ملف asar

  const resources = path.join(tmp, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar'), 'old-asar-content');

  if (zipped.status !== 0) {
    console.error('  ✖ تعذّر إنشاء ملف الاختبار zip (تأكد من توفّر أداة zip)');
    process.exitCode = 1;
  } else {
    await checkAsync('تجهيز التحديث ينسخ الملفات ويبني سكربت التطبيق', async () => {
      const res = await updater.installUpdate({
        file: zipPath,
        resourcesDir: resources,
        exePath: 'C:\\POS Pro\\POS Pro.exe',
        pid: 4321
      });
      assert.strictEqual(res.ok, true, res.error);
      const pending = path.join(resources, 'update-pending');
      assert.ok(fs.existsSync(path.join(pending, 'app.asar')));
      assert.ok(fs.existsSync(path.join(pending, 'build.json')));
      const script = fs.readFileSync(path.join(pending, 'apply-update.ps1'), 'utf8');
      assert.ok(script.charCodeAt(0) === 0xfeff, 'سكربت PowerShell يجب أن يبدأ بـ BOM ليقرأ العربية صحيحة');
      assert.ok(script.includes('Wait-Process -Id 4321'), 'يجب أن ينتظر خروج البرنامج');
      assert.ok(script.includes('app.asar.backup'), 'يجب أخذ نسخة أمان قبل الاستبدال');
      assert.ok(script.includes('Start-Process -FilePath $exe'), 'يجب إعادة تشغيل البرنامج');
      assert.ok(script.includes('Wait-Process -Id 4321'), 'يجب أن ينتظر خروج البرنامج');
      assert.ok(script.includes('[System.IO.File]::Open'), 'يجب انتظار تحرير ملف app.asar قبل استبداله');
      assert.ok(script.includes('Get-FileHash'), 'يجب التحقق من بصمة الملف بعد النسخ');
      assert.ok(script.includes(sha), 'البصمة المتوقعة يجب أن تُمرّر إلى سكربت التطبيق');
      assert.ok(script.includes('sha256 = $actualHash'), 'نتيجة التحديث يجب أن تحمل بصمة الملف المطبّق');
      assert.strictEqual(res.manifest.build, 'b900');
    });

    await checkAsync('رفض تحديث معدَّل (بصمة غير مطابقة)', async () => {
      const tampered = path.join(tmp, 'tampered.zip');
      const badStage = path.join(tmp, 'bad');
      fs.mkdirSync(badStage, { recursive: true });
      fs.copyFileSync(asarPath, path.join(badStage, 'app.asar'));
      fs.writeFileSync(path.join(badStage, 'manifest.json'), JSON.stringify({
        app: 'pos-pro', version: '2.1.0', sha256: 'b'.repeat(64), size
      }));
      const z = spawnSync('zip', ['-rq', tampered, '.'], { cwd: badStage });
      assert.strictEqual(z.status, 0);
      const res = await updater.installUpdate({ file: tampered, resourcesDir: resources, exePath: 'x.exe', pid: 1 });
      assert.strictEqual(res.ok, false);
      assert.ok(res.error.includes('sha256'), res.error);
    });

    check('سكربت التطبيق يُبنى بلا اعتماد على ملف .ps1 عند التشغيل (~EncodedCommand)', () => {
      const scriptPath = path.join(resources, 'update-pending', 'apply-update.ps1');
      const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'updater.js'), 'utf8');
      assert.ok(source.includes('-EncodedCommand'), 'يجب تشغيل السكربت عبر -EncodedCommand لتجاوز سياسات التنفيذ');
      assert.ok(fs.existsSync(scriptPath), 'ملف السكربت يبقى للتشخيص');
    });

    // محاكاة سلوك Electron: أي مسار ينتهي بـ .asar يُعامل كأرشيف داخلي فتفشل
    // statSync/readFileSync عليه برسالة «ENOENT, not found in ...app.asar».
    // هذا هو السبب الحقيقي للخطأ الذي ظهر عند اختيار ملف التحديث يدويًا.
    await checkAsync('التحديث يعمل داخل Electron رغم اعتراض مسارات app.asar', async () => {
      const guard = (fn) => function (...args) {
        const target = args[0];
        if (!process.noAsar && typeof target === 'string' && /\.asar$/i.test(target)) {
          const err = new Error(`ENOENT,  not found in ${target}`);
          err.code = 'ENOENT';
          throw err;
        }
        return fn.apply(fs, args);
      };
      const originalStat = fs.statSync;
      const originalRead = fs.readFileSync;
      const originalExists = fs.existsSync;
      fs.statSync = guard(originalStat);
      fs.readFileSync = guard(originalRead);
      // Electron يُرجع false لأي مسار ينتهي بـ .asar حتى لو كان الملف موجودًا
      fs.existsSync = function (target) {
        if (!process.noAsar && typeof target === 'string' && /\.asar$/i.test(target)) return false;
        return originalExists.call(fs, target);
      };
      try {
        const res = await updater.installUpdate({
          file: zipPath,
          resourcesDir: resources,
          exePath: 'C:\\POS Pro\\POS Pro.exe',
          pid: 99
        });
        assert.strictEqual(res.ok, true, res.error);
      } finally {
        fs.statSync = originalStat;
        fs.readFileSync = originalRead;
        fs.existsSync = originalExists;
      }
      assert.ok(fs.existsSync(path.join(resources, 'update-pending', 'app.asar')), 'يجب نسخ الملف المؤجل');
      assert.ok(!process.noAsar, 'يجب إعادة حالة asar كما كانت بعد التحديث');
    });

    await checkAsync('رفض ملف ليس حزمة تحديث', async () => {
      const junk = path.join(tmp, 'junk.zip');
      const junkDir = path.join(tmp, 'junk');
      fs.mkdirSync(junkDir, { recursive: true });
      fs.writeFileSync(path.join(junkDir, 'readme.txt'), 'nothing here');
      const z = spawnSync('zip', ['-rq', junk, '.'], { cwd: junkDir });
      assert.strictEqual(z.status, 0);
      const res = await updater.installUpdate({ file: junk, resourcesDir: resources, exePath: 'x.exe', pid: 1 });
      assert.strictEqual(res.ok, false);
    });
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`[unit] ${passed} اختبارًا ناجحًا`);
})();
