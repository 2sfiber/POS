'use strict';
/**
 * ============================================================================
 * التحديث المحلي (Offline local update)
 * ============================================================================
 * ملف التحديث = ملف ZIP يحتوي:
 *   manifest.json  { app, version, build, sha256, size, date, notes }
 *   app.asar       نسخة البرنامج الجديدة
 *   build.json     رقم الإصدار/البناء الجديد لعرضهما داخل البرنامج
 *
 * لماذا لا نستبدل app.asar أثناء عمل البرنامج؟
 *   ويندوز يقفل ملفات التطبيق أثناء تشغيلها، والاستبدال المباشر قد يفشل أو
 *   يُفسد التثبيت. لذلك نُجهّز الملفات في resources/update-pending ثم يُشغّل
 *   سكربت PowerShell صغير ينتظر خروج البرنامج، يأخذ نسخة أمان من app.asar
 *   القديم، ينسخ الجديد، ثم يعيد تشغيل البرنامج. وإن فشل أي خطوة يُرجع النسخة
 *   القديمة ويُشغّل البرنامج حتى لا يبقى معطلًا.
 *
 * فك الضغط:
 *   نقرأ ملف ZIP بأنفسنا داخل Node (بدون PowerShell) ونتحقق من CRC وحجم كل
 *   مدخل قبل كتابته. سبب ذلك: Expand-Archive في Windows PowerShell أحيانًا
 *   تُنتج ملفًا ناقصًا/مختلفًا (خصوصًا مع أسماء مستخدمين غير لاتينية أو عند
 *   تدخّل برامج الحماية)، فيظهر خطأ «الحجم لا يطابق» بلا سبب حقيقي.
 *   تبقى PowerShell احتياطًا فقط إن كان الأرشيف بطريقة ضغط غير مدعومة.
 *
 * التحقق قبل التطبيق:
 *   - أن الملف حزمة تحديث لهذا البرنامج (manifest.app)
 *   - أن رقم الإصدار صالح وأن sha256 مطابق تمامًا لملف app.asar
 *   - أن app.asar ملف asar سليم (رأس صحيح + قائمة ملفات) وليس أي ملف آخر
 * ============================================================================
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');

const IS_WINDOWS = process.platform === 'win32';
const APP_ID = 'pos-pro';
const MAX_ASAR_BYTES = 400 * 1024 * 1024;

/**
 * مهم جدًا داخل Electron:
 *   أَي مسار ينتهي بـ «.asar» يُمرَّر إلى طبقة asar المدمجة، فتُعتبر نهايته
 *   مسارًا داخل أرشيف وتفشل عمليات statSync / readFileSync / copyFileSync
 *   برسالة: ENOENT, not found in C:\...\app.asar
 *   (وهو الخطأ الذي ظهر عند اختيار ملف التحديث يدويًا).
 *   الحل: نُعطّل هذه الطبقة أثناء التعامل مع ملفات حزمة التحديث، فتُقرأ
 *   وتُنسخ كملفات عادية، ثم نُعيد الحالة السابقة كما كانت تمامًا.
 */
function asPlainFile(fn) {
  const previous = process.noAsar;
  process.noAsar = true;
  try {
    return fn();
  } finally {
    process.noAsar = previous;
  }
}

function sha256File(file) {
  return asPlainFile(() => {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(file));
    return hash.digest('hex');
  });
}

/** التحقق من أن الملف ملف asar حقيقي (رأس pickle + JSON فيه files). */
function isAsarFile(file) {
  return asPlainFile(() => {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const head = Buffer.alloc(16);
      if (fs.readSync(fd, head, 0, 16, 0) !== 16) return false;
      // بنية رأس asar: [4 بايت ثابتة][حجم الرأس][حجم الحشو][طول JSON][JSON...]
      if (head.readUInt32LE(0) !== 4) return false;
      const paddedLength = head.readUInt32LE(8);
      const jsonLength = head.readUInt32LE(12) || paddedLength;
      if (jsonLength <= 2 || jsonLength > 32 * 1024 * 1024) return false;
      const jsonBuf = Buffer.alloc(jsonLength);
      if (fs.readSync(fd, jsonBuf, 0, jsonLength, 16) !== jsonLength) return false;
      // نُبقي JSON فقط ونقطع أي حشو/بقايا بعد نهايته
      const text = jsonBuf.toString('utf8').replace(/\u0000[\s\S]*$/, '');
      const json = JSON.parse(text);
      return !!(json && typeof json === 'object' && json.files);
    } catch {
      return false;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
  });
}

/** فحص بيانات manifest قبل أي لمس لملفات البرنامج. */
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, error: 'ملف manifest.json غير موجود أو غير صالح' };
  }
  if (manifest.app !== APP_ID) {
    return { ok: false, error: 'هذا الملف ليس حزمة تحديث لنظام POS Pro' };
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version || ''))) {
    return { ok: false, error: 'رقم إصدار التحديث غير صالح' };
  }
  if (!/^[0-9a-f]{64}$/i.test(String(manifest.sha256 || ''))) {
    return { ok: false, error: 'بصمة الملف (sha256) مفقودة أو غير صالحة' };
  }
  const size = Number(manifest.size);
  if (!Number.isFinite(size) || size < 100 * 1024 || size > MAX_ASAR_BYTES) {
    return { ok: false, error: 'حجم ملف البرنامج في التحديث غير منطقي' };
  }
  return { ok: true };
}

/* ---------------------------------------------------------------------------
 * قراءة ZIP داخل Node (deflate/store) مع التحقق من CRC والحجم
 * ------------------------------------------------------------------------ */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** فهرس الأرشيف (central directory) — يكشف الملفات الناقصة/التالفة مبكرًا. */
function readZipEntries(buf) {
  const damaged = 'ملف التحديث تالف أو ناقص (لم يكتمل تنزيله/نسخه) — أعد نسخ الملف كاملًا';
  let eocd = -1;
  const lowest = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(damaged);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (!count || cdOffset + cdSize > buf.length) throw new Error(damaged);

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(damaged);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    entries.push({
      name: buf.toString('utf8', p + 46, p + 46 + nameLength),
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42)
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** فك ضغط ZIP بالكامل إلى مجلد، مع التحقق من CRC وحجم كل ملف. */
function extractZipNode(zipPath, targetDir) {
  const damaged = 'ملف التحديث تالف أو ناقص (لم يكتمل تنزيله/نسخه) — أعد نسخ الملف كاملًا';
  const buf = fs.readFileSync(zipPath);
  const entries = readZipEntries(buf);
  const base = path.resolve(targetDir);
  fs.mkdirSync(base, { recursive: true });

  for (const entry of entries) {
    const name = String(entry.name).replace(/\\/g, '/');
    if (name.endsWith('/')) continue;
    const parts = name.split('/').filter((part) => part && part !== '.' && part !== '..');
    if (!parts.length) continue;
    const outPath = path.resolve(base, ...parts);
    if (outPath !== base && !outPath.startsWith(base + path.sep)) continue;

    if (buf.readUInt32LE(entry.localOffset) !== SIG_LOCAL) throw new Error(damaged);
    const nameLength = buf.readUInt16LE(entry.localOffset + 26);
    const extraLength = buf.readUInt16LE(entry.localOffset + 28);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const raw = buf.subarray(start, start + entry.compressedSize);
    if (raw.length !== entry.compressedSize) throw new Error(damaged);

    let data;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error('طريقة ضغط غير مدعومة داخل ملف التحديث');
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw new Error(damaged);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, data);
  }
}

/** فك ضغط ZIP (Node أولًا، ثم PowerShell احتياطًا على ويندوز). */
function extractZip(zipPath, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  let primaryError = '';
  try {
    extractZipNode(zipPath, targetDir);
    return { ok: true };
  } catch (err) {
    primaryError = String((err && err.message) || err || '');
  }
  if (!IS_WINDOWS) return { ok: false, error: primaryError || 'تعذّر فك ضغط ملف التحديث' };

  // احتياط: PowerShell (لأرشيفات بطريقة ضغط لا ندعمها) ثم التحقق من المحتوى
  const staging = path.join(targetDir, '__stage');
  fs.mkdirSync(staging, { recursive: true });
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Expand-Archive -LiteralPath '${String(zipPath).replace(/'/g, "''")}' -DestinationPath '${staging.replace(/'/g, "''")}' -Force`
  ].join('\r\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const res = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
  ], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  if (res.status !== 0) {
    return { ok: false, error: primaryError || ('تعذّر فك ضغط ملف التحديث: ' + String(res.stderr || '').trim()) };
  }
  for (const name of fs.readdirSync(staging)) {
    fs.renameSync(path.join(staging, name), path.join(targetDir, name));
  }
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
  return { ok: true };
}

/**
 * سكربت التطبيق: ينتظر خروج البرنامج ثم يبدّل app.asar ويُعيد التشغيل.
 *
 * ملاحظات مهمة:
 *   - كل خطوات التسجيل/كتابة ملف النتيجة داخل try حتى لا يُلغي فشلُ تسجيلٍ
 *     بسيط عمليةَ تحديث نجحت (كان سيؤدي إلى استرجاع نسخة قديمة بلا داعٍ).
 *   - حذف مجلد التحديث المؤجل يأتي في النهاية، بعد تشغيل البرنامج، حتى لا يُحذف
 *     السكربت نفسه وهو يعمل.
 */
function buildApplyScript({ resourcesDir, exePath, pid, version, build, packageId, sha256 }) {
  const q = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const resDir = String(resourcesDir).replace(/[\\/]+$/, '');
  // مسارات ويندوز دائمًا (لا نستخدم path.join كي لا تختلط الفواصل عند البناء من غير ويندوز)
  const winJoin = (base, name) => String(base).replace(/[\\/]+$/, '') + '\\' + name;
  return [
    "$ErrorActionPreference = 'Stop'",
    `$res = ${q(resDir)}`,
    `$exe = ${q(exePath)}`,
    `$log = ${q(winJoin(resDir, 'update.log'))}`,
    `$pending = ${q(winJoin(resDir, 'update-pending'))}`,
    `$resultFile = ${q(winJoin(resDir, 'update-result.json'))}`,
    `$expectedHash = ${q(String(sha256 || '').toLowerCase())}`,
    'function Log($m) { try { Add-Content -Path $log -Value ((Get-Date -Format s) + "  " + $m) -Encoding UTF8 } catch { } }',
    'function SaveResult($json) { try { Set-Content -Path $resultFile -Value $json -Encoding UTF8 } catch { } }',
    'try {',
    `  Wait-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue`,
    '  Log "خروج البرنامج — بدء تطبيق التحديث"',
    "  $current = Join-Path $res 'app.asar'",
    "  $backup = Join-Path $res 'app.asar.backup'",
    "  $incoming = Join-Path $pending 'app.asar'",
    '  if (-not (Test-Path $incoming)) { throw "ملف التحديث المؤجل غير موجود" }',
    '  # ويندوز يبقى ماسكًا لملف app.asar لحظات بعد إغلاق العملية، فننتظر تحرره قبل الاستبدال',
    '  $ready = $false',
    '  for ($i = 1; $i -le 30 -and -not $ready; $i++) {',
    '    try {',
    '      if (Test-Path $current) {',
    '        $handle = [System.IO.File]::Open($current, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)',
    '        $handle.Close(); $handle.Dispose()',
    '      }',
    '      $ready = $true',
    '    } catch {',
    '      Start-Sleep -Milliseconds 700',
    '    }',
    '  }',
    '  if (-not $ready) { throw "ملف البرنامج ما زال مستخدمًا من عملية أخرى — أغلق كل نوافذ POS Pro ثم أعد المحاولة" }',
    '  if (Test-Path $current) { Copy-Item $current $backup -Force }',
    '  $copied = $false',
    '  for ($i = 1; $i -le 10 -and -not $copied; $i++) {',
    '    try {',
    '      Copy-Item $incoming $current -Force',
    '      $copied = $true',
    '    } catch {',
    '      Log ("محاولة النسخ " + $i + " فشلت: " + $_.Exception.Message)',
    '      Start-Sleep -Milliseconds 900',
    '    }',
    '  }',
    '  if (-not $copied) { throw "تعذّر استبدال ملف البرنامج — الملف مقفل أو الصلاحيات غير كافية" }',
    '  $actualHash = (Get-FileHash -Path $current -Algorithm SHA256).Hash.ToLower()',
    '  if ($expectedHash -and ($actualHash -ne $expectedHash)) { throw ("نسخة الملف بعد الاستبدال لا تطابق التحديث (" + $actualHash.Substring(0,12) + " بدل " + $expectedHash.Substring(0,12) + ")") }',
    "  $buildFile = Join-Path $pending 'build.json'",
    "  if (Test-Path $buildFile) { Copy-Item $buildFile (Join-Path $res 'build.json') -Force }",
    '  $bytes = (Get-Item $current).Length',
    '  Log ("تم استبدال app.asar — " + $bytes + " بايت — البصمة " + $actualHash.Substring(0,12))',
    `  SaveResult (@{ ok = $true; version = ${q(version || '')}; build = ${q(build || '')}; package = ${q(packageId || '')}; sha256 = $actualHash; bytes = $bytes; resources = $res; exe = $exe; at = (Get-Date).ToString('s') } | ConvertTo-Json -Compress)`,
    '} catch {',
    '  Log ("فشل التحديث: " + $_.Exception.Message)',
    "  try { if (Test-Path (Join-Path $res 'app.asar.backup')) { Copy-Item (Join-Path $res 'app.asar.backup') (Join-Path $res 'app.asar') -Force }; Log 'تمت استعادة النسخة السابقة' } catch { Log ('تعذّرت الاستعادة: ' + $_.Exception.Message) }",
    `  SaveResult (@{ ok = $false; error = $_.Exception.Message; resources = $res; exe = $exe; at = (Get-Date).ToString('s') } | ConvertTo-Json -Compress)`,
    '}',
    'try { Start-Process -FilePath $exe } catch { Log ("تعذّر تشغيل البرنامج: " + $_.Exception.Message) }',
    'try { Remove-Item $pending -Recurse -Force -ErrorAction SilentlyContinue } catch { }'
  ].join('\r\n');
}

/**
 * تجهيز التحديث وتشغيل سكربت التطبيق.
 * file: مسار zip، resourcesDir: مجلد resources داخل الحزمة، exePath: مسار التشغيل.
 */
function installUpdateInner({ file, resourcesDir, exePath, pid }) {
  if (!file || !fs.existsSync(file)) return { ok: false, error: 'ملف التحديث غير موجود' };
  if (!resourcesDir || !fs.existsSync(resourcesDir)) return { ok: false, error: 'مجلد البرنامج غير موجود' };

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-update-'));
  try {
    const extracted = extractZip(file, work);
    if (!extracted.ok) return extracted;

    // الملفات قد تكون داخل مجلد فرعي داخل الأرشيف
    const findRoot = (dir, depth = 0) => {
      if (fs.existsSync(path.join(dir, 'manifest.json')) && fs.existsSync(path.join(dir, 'app.asar'))) return dir;
      if (depth > 2) return null;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const found = findRoot(path.join(dir, entry.name), depth + 1);
        if (found) return found;
      }
      return null;
    };
    const root = findRoot(work);
    if (!root) return { ok: false, error: 'ملف التحديث لا يحتوي manifest.json و app.asar' };

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    } catch {
      return { ok: false, error: 'manifest.json غير قابل للقراءة' };
    }
    const valid = validateManifest(manifest);
    if (!valid.ok) return valid;

    const asarPath = path.join(root, 'app.asar');
    const expectedSize = Number(manifest.size);
    const actualSize = fs.statSync(asarPath).size;
    const actualSha = sha256File(asarPath);

    // البصمة هي الفيصل الحقيقي: إن طابقت فالمحتوى سليم تمامًا (وبالتالي الحجم).
    if (actualSha.toLowerCase() !== String(manifest.sha256).toLowerCase()) {
      const sizeNote = actualSize === expectedSize
        ? ''
        : ` | الحجم: ${actualSize} بايت داخل الحزمة مقابل ${expectedSize} في بيانات التحديث`;
      const shrink = actualSize < expectedSize
        ? ' — الحزمة أصغر من المتوقع، أي أنها نُقلت/نُسخت بشكل ناقص'
        : '';
      return {
        ok: false,
        error: `بصمة التحقق (sha256) غير مطابقة${shrink}${sizeNote} — أعد نسخ ملف التحديث كاملًا ثم أعد المحاولة`
      };
    }
    if (actualSize !== expectedSize) {
      return {
        ok: false,
        error: `حجم ملف البرنامج داخل الحزمة (${actualSize} بايت) لا يطابق البيانات المذكورة في التحديث (${expectedSize} بايت) — أعد نسخ الملف كاملًا`
      };
    }
    if (!isAsarFile(asarPath)) {
      return { ok: false, error: 'ملف app.asar غير صالح (ليس حزمة برنامج سليمة)' };
    }

    // تجهيز مجلد التطبيق المؤجل
    const pending = path.join(resourcesDir, 'update-pending');
    try {
      fs.rmSync(pending, { recursive: true, force: true });
      fs.mkdirSync(pending, { recursive: true });
    } catch {
      return {
        ok: false,
        error: 'تعذّر تجهيز مجلد التحديث داخل مسار البرنامج — تأكد من صلاحيات الكتابة وأنه لا يوجد تحديث معلّق'
      };
    }

    try {
      fs.copyFileSync(asarPath, path.join(pending, 'app.asar'));
      const copiedSize = fs.statSync(path.join(pending, 'app.asar')).size;
      if (copiedSize !== expectedSize) {
        throw new Error(`حجم الملف المنسوخ ${copiedSize} بايت بدل ${expectedSize} بايت (مساحة القرص أو صلاحيات)`);
      }
      const buildJson = path.join(root, 'build.json');
      if (fs.existsSync(buildJson)) fs.copyFileSync(buildJson, path.join(pending, 'build.json'));

      const scriptPath = path.join(pending, 'apply-update.ps1');
      // BOM مطلوب: PowerShell 5.1 يقرأ ملفات .ps1 بترميز ANSI إذا لم يكن بها BOM،
      // فتتحول النصوص العربية إلى حروف مشوّشة (وقد تفسد السكربت).
      fs.writeFileSync(scriptPath, '\uFEFF' + buildApplyScript({
        resourcesDir, exePath, pid,
        version: manifest.version,
        build: manifest.build,
        packageId: manifest.package || '',
        sha256: manifest.sha256
      }), 'utf8');

      return { ok: true, manifest, pendingDir: pending, scriptPath };
    } catch (err) {
      try { fs.rmSync(pending, { recursive: true, force: true }); } catch { /* ignore */ }
      return { ok: false, error: 'تعذّر تجهيز ملفات التحديث: ' + String((err && err.message) || err) };
    }
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * الغلاف العام: كل عمليات الملفات على app.asar تتم كملف عادي (بلا اعتراض asar).
 * الإبقاء على دالة async يحافظ على نفس الواجهة المستخدمة في main.js والاختبارات.
 */
async function installUpdate(options = {}) {
  return asPlainFile(() => installUpdateInner(options || {}));
}

/**
 * تشغيل سكربت التطبيق في الخلفية بعد إغلاق البرنامج.
 *
 * نُمرّر نص السكربت عبر -EncodedCommand (UTF-16LE/base64) بدل -File:
 *   - يعمل حتى لو كانت سياسة تنفيذ السكربتات (ExecutionPolicy/AppLocker)
 *     تمنع ملفات .ps1، وهي أشهر أسباب «نجح التحديث ولم يتغير شيء».
 *   - لا يتأثر بمسار يحتوي مسافات/حروفًا غير لاتينية ولا بترميز الملف.
 */
function startApplier(scriptPath) {
  if (!IS_WINDOWS) return { ok: false, error: 'تطبيق التحديث التلقائي متاح على ويندوز فقط' };
  let script;
  try {
    script = fs.readFileSync(scriptPath, 'utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    return { ok: false, error: 'تعذّر قراءة سكربت التحديث: ' + String((err && err.message) || err) };
  }
  if (!script.trim()) return { ok: false, error: 'سكربت التحديث فارغ' };
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { ok: true, pid: child.pid };
}

module.exports = {
  APP_ID,
  asPlainFile,
  sha256File,
  isAsarFile,
  validateManifest,
  readZipEntries,
  extractZipNode,
  extractZip,
  buildApplyScript,
  installUpdate,
  startApplier,
  IS_WINDOWS
};
