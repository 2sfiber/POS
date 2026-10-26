'use strict';
/**
 * ============================================================================
 * الطباعة الحرارية المباشرة (ESC/POS Raw)
 * ============================================================================
 * لماذا هذا الملف؟
 *   الطباعة عبر تعريف ويندوز (Chromium → EMF → السولر) تفشل كثيرًا مع
 *   الطابعات الحرارية المدمجة في أجهزة الكاشير (منافذ مثل PLT / USB00x /
 *   COM): تظهر المهمة في قائمة الانتظار ثم تختفي بلا طباعة، أو تُطبع بمقاس
 *   خاطئ، لأن التعريف يرفض مقاس الورقة المخصّص الذي يرسله Chromium.
 *
 *   الحل هنا يتجاوز التعريف كليًا:
 *     1) نرسم الفاتورة (HTML) في نافذة Chromium مخفية بعرض = عدد نقاط رأس
 *        الطابعة بالضبط (58 مم = 384 نقطة، 80 مم = 576 نقطة، ... إلخ).
 *     2) نحوّل الصورة إلى نقاط أحادية اللون (1bpp).
 *     3) نبني أوامر ESC/POS (GS v 0) ونرسلها خامًا (RAW) إلى منفذ الطابعة
 *        عبر السولر باستخدام WritePrinter — يعمل مع USB و PLT و COM و LPT
 *        وطابعات الشبكة، بلا أي اعتماد على تعريف الطباعة أو مقاساته.
 *
 *   بهذه الطريقة: كل طابعة حرارية متوافقة مع ESC/POS تعمل، مع أي مقاس ورق،
 *   وبلا نافذة تأكيد من ويندوز، والنص العربي يخرج كما صُمّم تمامًا.
 * ============================================================================
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const IS_WINDOWS = process.platform === 'win32';
const DPI_PRESETS = [180, 203, 300];
const MAX_DOTS = 1024;
const MIN_DOTS = 128;

/* ------------------------------- أدوات عامة ------------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(value, fallback) {
  const v = Number(value);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/*
 * نقاط لكل مليمتر حسب دقة رأس الطابعة:
 *   203 dpi = 8 نقاط/مم بالضبط (المعيار في الطابعات الحرارية)
 *   180 dpi = 7.087 — 300 dpi = 11.811
 */
const DOTS_PER_MM = { 180: 180 / 25.4, 203: 8, 300: 300 / 25.4 };

/**
 * العرض القابل للطباعة من عرض الورق:
 *   58 مم → 48 مم (384 نقطة) — 76/80 مم → 68/72 مم (576 نقطة)
 */
function printableWidthMm(widthMm) {
  return widthMm <= 60 ? widthMm - 10 : widthMm - 8;
}

function tmpSubdir() {
  const dir = path.join(os.tmpdir(), 'pos-pro-print');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTempBin(buffer) {
  const file = path.join(tmpSubdir(), `escpos-${Date.now()}-${process.pid}.bin`);
  fs.writeFileSync(file, buffer);
  return file;
}

function removeLater(file, delay = 60000) {
  setTimeout(() => {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }, delay).unref?.();
}

/**
 * مقاييس الورقة → عدد نقاط الرأس.
 * عرض الورق (مم) − 10 مم هو العرض القابل للطباعة (هامش 5 مم من كل جهة):
 *   58 مم → 48 مم → 384 نقطة على 203 dpi
 *   80 مم → 72 مم → 576 نقطة على 203 dpi
 * يمكن تجاوز النقاط يدويًا (dots) لأي طابعة غير قياسية.
 */
function paperMetrics(options = {}) {
  const widthMm = clamp(num(options.widthMm, 80), 40, 112);
  const dpi = DPI_PRESETS.includes(Number(options.dpi)) ? Number(options.dpi) : 203;
  const dotsPerMm = DOTS_PER_MM[dpi];
  const printableMm = clamp(num(options.printableMm, printableWidthMm(widthMm)), 16, widthMm);
  const override = Math.round(num(options.dots, 0));
  const dots = override > 0
    ? clamp(override, MIN_DOTS, MAX_DOTS)
    : clamp(Math.round(printableMm * dotsPerMm), MIN_DOTS, MAX_DOTS);
  return { widthMm, printableMm, dpi, dots, dotsPerMm };
}

/* --------------------- تحويل الصورة إلى نقاط أحادية اللون --------------------- */
/**
 * BGRA (ناتج nativeImage.toBitmap) → صفوف نقاط 1bpp (1 = طباعة النقطة).
 * نركّب الصورة على خلفية بيضاء (في حال وجود شفافية) ثم نستخدم سطوعًا مرجّحًا.
 */
function packRasterBitmap(bgra, width, height, threshold = 168) {
  const bytesPerRow = Math.ceil(width / 8);
  const data = Buffer.alloc(bytesPerRow * height);
  const limit = threshold;
  for (let y = 0; y < height; y++) {
    const src = y * width * 4;
    const dst = y * bytesPerRow;
    for (let x = 0; x < width; x++) {
      const i = src + x * 4;
      const b = bgra[i];
      const g = bgra[i + 1];
      const r = bgra[i + 2];
      const a = bgra[i + 3];
      let lum;
      if (a === 255) lum = 0.299 * r + 0.587 * g + 0.114 * b;
      else lum = (0.299 * r + 0.587 * g + 0.114 * b) * (a / 255) + 255 * (1 - a / 255);
      if (lum < limit) data[dst + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { data, bytesPerRow, height, width };
}

/** حذف الصفوف الفارغة في نهاية الصورة حتى لا تخرج ورقًا زائدًا. */
function trimRaster(raster, minRows = 8) {
  if (!raster || raster.height <= 0) return { ...raster, height: Math.max(1, minRows) };
  const { data, bytesPerRow } = raster;
  let last = raster.height - 1;
  while (last >= 0) {
    const start = last * bytesPerRow;
    let blank = true;
    for (let i = 0; i < bytesPerRow; i++) {
      if (data[start + i] !== 0) { blank = false; break; }
    }
    if (!blank) break;
    last--;
  }
  const height = Math.max(minRows, last + 1);
  return {
    data: data.subarray(0, bytesPerRow * height),
    bytesPerRow,
    height,
    width: raster.width
  };
}

function chunkRaster(raster, maxRows = 256) {
  const blocks = [];
  for (let start = 0; start < raster.height; start += maxRows) {
    const rows = Math.min(maxRows, raster.height - start);
    blocks.push({
      data: raster.data.subarray(start * raster.bytesPerRow, (start + rows) * raster.bytesPerRow),
      bytesPerRow: raster.bytesPerRow,
      height: rows,
      width: raster.width
    });
  }
  return blocks;
}

/* ------------------------------ أوامر ESC/POS ------------------------------ */
const CMD = {
  init: Buffer.from([0x1b, 0x40]) // ESC @ — تهيئة الطابعة
};

function buildRasterBlock(block) {
  const xL = block.bytesPerRow & 0xff;
  const xH = (block.bytesPerRow >> 8) & 0xff;
  const yL = block.height & 0xff;
  const yH = (block.height >> 8) & 0xff;
  // GS v 0 m xL xH yL yH ثم بيانات النقاط
  const header = Buffer.from([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
  return Buffer.concat([header, block.data]);
}

function feedCommand(lines) {
  return Buffer.from([0x1b, 0x64, clamp(Math.round(lines), 0, 255)]);
}

/**
 * قص الورق بعد تغذية مسبقة: GS V 66 n (تغذية n نقطة ثم قص جزئي).
 *
 * لماذا التغذية قبل القص؟
 *   في الطابعات الحرارية المدمجة في أجهزة الكاشير تقع شفرة القص أعلى رأس
 *   الطباعة بمسافة (10–25 مم). القص الفوري يترك آخر ما طُبع — وهو عادة نص
 *   التذييل — في الجزء الذي لم يتجاوز الشفرة بعد، فيظهر في أعلى الفاتورة
 *   التالية. لذلك نُخرج الورق بمقدار مسافة الشفرة قبل القص.
 *
 * feedMm: المسافة بالمليمتر (إعداد المستخدم، الافتراضي 20 مم).
 * dotsPerMm: نقاط رأس الطابعة في المليمتر (203dpi = 8).
 */
function cutCommand(feedMm, dotsPerMm) {
  let dots = clamp(Math.round(num(feedMm, 20) * (num(dotsPerMm, 8) || 8)), 0, 2040);
  const parts = [];
  // الأمر n لا يتجاوز 255 نقطة: نُغذّي الباقي بأسطر (ESC d) ثم نُكمل بالنقاط.
  if (dots > 255) {
    const lines = Math.min(255, Math.floor(dots / 30)); // ارتفاع السطر الافتراضي ≈ 30 نقطة
    if (lines > 0) {
      parts.push(feedCommand(lines));
      dots -= lines * 30;
    }
  }
  parts.push(Buffer.from([0x1d, 0x56, 0x42, clamp(dots, 0, 255)]));
  return Buffer.concat(parts);
}

/**
 * بناء مهمة ESC/POS كاملة: تهيئة ← صورة ← تغذية ← (تغذية القص) ← قص، لكل نسخة.
 * cutFeedMm: تغذية الورق قبل القص لإخراج آخر سطر (التذييل) من شفرة القص.
 */
function buildEscPosJob(raster, options = {}) {
  const copies = clamp(Math.round(num(options.copies, 1)), 1, 5);
  const feedLines = clamp(Math.round(num(options.feedLines, 4)), 0, 12);
  const cutFeedMm = clamp(num(options.cutFeedMm, 20), 0, 40);
  const dotsPerMm = num(options.dotsPerMm, 8) || 8;
  const cut = options.cut !== false;
  const parts = [CMD.init];
  const blocks = chunkRaster(raster, 256);
  for (let c = 0; c < copies; c++) {
    for (const block of blocks) parts.push(buildRasterBlock(block));
    if (feedLines > 0) parts.push(feedCommand(feedLines));
    if (cut) {
      parts.push(cutCommand(cutFeedMm, dotsPerMm));
    } else if (cutFeedMm > 0) {
      // بلا قص: نُخرج الورق فقط حتى يتمكن الكاشير من تمزيقه
      parts.push(feedCommand(Math.round((cutFeedMm * dotsPerMm) / 30)));
    }
  }
  return Buffer.concat(parts);
}

/* ------------------------- التشخيص: تعريف/منفذ الطابعة ------------------------- */
const DRIVER_HINTS = /(pos[\s\-_]?\d|\bpos\b|thermal|receipt|esc[\s\-_]?pos|xprinter|gprinter|rongta|snbc|sunmi|imin|black\s*copper|bixolon|sewoo|citizen|star\s*(tsp|mc|sm)|epson\s*tm|\btm[-\s_]?[tum]\b|rp\s*(80|58)|gp[-\s_]?(80|58)|generic\s*[\/\s]?\s*text|label|barcode)/i;
const LASER_HINTS = /(hp\b|hewlett|canon|brother|kyocera|ricoh|lexmark|xerox|samsung|pcl|postscript|\bpdf\b|\bxps\b|deskjet|officejet|laserjet|photosmart|inkjet)/i;
const PORT_HINTS = /^(plt|com\d+|lpt\d+)$/i;

/**
 * هل الطابعة حرارية (ESC/POS)؟ يعتمد على اسم التعريف والمنفذ.
 * عند الشك نُعيد false حتى نستخدم تعريف ويندوز (أكثر أمانًا لطابعات A4).
 */
function looksThermal(info) {
  if (!info) return false;
  const text = `${info.driverName || ''} ${info.name || ''}`.trim();
  if (DRIVER_HINTS.test(text)) return true;
  if (LASER_HINTS.test(text)) return false;
  return PORT_HINTS.test(String(info.portName || '').trim());
}

function encodePwsh(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/** تشغيل سكربت PowerShell لمرة واحدة (للاستعلامات). */
function runPwsh(script, timeout = 12000) {
  if (!IS_WINDOWS) return { ok: false, out: '', err: 'PowerShell متاح على ويندوز فقط' };
  try {
    const res = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodePwsh(script)
    ], { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    if (res.error) return { ok: false, out: '', err: res.error.message };
    const out = (res.stdout || '').trim();
    const err = (res.stderr || '').trim();
    return { ok: res.status === 0, out, err: err || (res.status === 0 ? '' : `رمز الخروج ${res.status}`) };
  } catch (err) {
    return { ok: false, out: '', err: err.message || String(err) };
  }
}

const infoCache = new Map();
const INFO_TTL = 60 * 1000;

function psQuote(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

const PRINTER_INFO_SCRIPT = (name) => {
  const code = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$name = '${psQuote(name)}'
$p = $null
if ($name -ne '') {
  $p = Get-Printer -Name $name | Select-Object Name, DriverName, PortName, PrinterStatus
}
if ($null -eq $p -and $name -ne '') {
  $p = Get-CimInstance -ClassName Win32_Printer | Where-Object { $_.Name -eq $name } |
       Select-Object Name, DriverName, PortName, PrinterStatus
}
if ($null -eq $p -and $name -eq '') {
  $p = Get-CimInstance -ClassName Win32_Printer | Where-Object { $_.Default -eq $true } |
       Select-Object -First 1 Name, DriverName, PortName, PrinterStatus
}
if ($null -eq $p) { Write-Output 'NOTFOUND' } else { $p | ConvertTo-Json -Compress }
`;
  return code;
};

/**
 * معلومات طابعة واحدة (أو الافتراضية عند تمرير اسم فارغ):
 * { name, driverName, portName, status }
 */
async function queryPrinter(name = '') {
  const key = String(name || '');
  const cached = infoCache.get(key);
  if (cached && Date.now() - cached.at < INFO_TTL) return cached.value;
  const res = runPwsh(PRINTER_INFO_SCRIPT(key));
  let value = null;
  if (res.ok && res.out && res.out !== 'NOTFOUND') {
    try {
      const raw = JSON.parse(res.out);
      const row = Array.isArray(raw) ? raw[0] : raw;
      if (row && row.Name) {
        value = {
          name: String(row.Name),
          driverName: String(row.DriverName || ''),
          portName: String(row.PortName || ''),
          status: String(row.PrinterStatus || '')
        };
      }
    } catch { /* ignore */ }
  }
  infoCache.set(key, { at: Date.now(), value });
  return value;
}

/** قائمة تعريفات/منافذ كل الطابعات (للتشخيص فقط). */
async function printerDetails() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$list = Get-CimInstance -ClassName Win32_Printer |
        Select-Object Name, DriverName, PortName, Default, PrinterStatus
if ($null -eq $list) { Write-Output '[]' } else { $list | ConvertTo-Json -Compress }
`;
  const res = runPwsh(script, 15000);
  if (!res.ok || !res.out) return [];
  try {
    const list = JSON.parse(res.out);
    return (Array.isArray(list) ? list : [list]).filter(Boolean).map((p) => ({
      name: String(p.Name || ''),
      driverName: String(p.DriverName || ''),
      portName: String(p.PortName || ''),
      isDefault: !!p.Default,
      status: String(p.PrinterStatus || '')
    }));
  } catch {
    return [];
  }
}

function clearCache() {
  infoCache.clear();
}

/* --------------------- إرسال البيانات الخام عبر السولر (RAW) --------------------- */
/**
 * سكربت PowerShell دائم: يقرأ طلبات JSON من stdin (سطر لكل مهمة) ويرسل
 * بايتات RAW إلى الطابعة عبر winspool.WritePrinter. يبقى حيًا حتى يُغلق
 * التطبيق، لذا لا يُعاد تصريف C# لكل فاتورة (سرعة عالية بعد أول نداء).
 */
function helperScript() {
  const lines = [
    "$ErrorActionPreference = 'Continue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.IO;',
    'using System.Runtime.InteropServices;',
    'public class PosRawPrint {',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '  public class DOCINFOA {',
    '    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;',
    '    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;',
    '    [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;',
    '  }',
    '  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]',
    '  public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);',
    '  [DllImport("winspool.drv", SetLastError = true)]',
    '  public static extern bool ClosePrinter(IntPtr hPrinter);',
    '  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]',
    '  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);',
    '  [DllImport("winspool.drv", SetLastError = true)]',
    '  public static extern bool EndDocPrinter(IntPtr hPrinter);',
    '  [DllImport("winspool.drv", SetLastError = true)]',
    '  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);',
    '  public static string Send(string printer, string file) {',
    '    IntPtr hPrinter;',
    '    if (!OpenPrinter(printer, out hPrinter, IntPtr.Zero)) return "ERR:OPENPRINTER " + Marshal.GetLastWin32Error();',
    '    try {',
    '      DOCINFOA di = new DOCINFOA();',
    '      di.pDocName = "POS Pro Receipt";',
    '      di.pDatatype = "RAW";',
    '      if (!StartDocPrinter(hPrinter, 1, di)) return "ERR:STARTDOC " + Marshal.GetLastWin32Error();',
    '      try {',
    '        byte[] bytes = File.ReadAllBytes(file);',
    '        IntPtr ptr = Marshal.AllocHGlobal(bytes.Length);',
    '        try {',
    '          Marshal.Copy(bytes, 0, ptr, bytes.Length);',
    '          int written;',
    '          if (!WritePrinter(hPrinter, ptr, bytes.Length, out written)) return "ERR:WRITE " + Marshal.GetLastWin32Error();',
    '          return "OK:" + written.ToString();',
    '        } finally { Marshal.FreeHGlobal(ptr); }',
    '      } finally { EndDocPrinter(hPrinter); }',
    '    } finally { ClosePrinter(hPrinter); }',
    '  }',
    '}',
    "'@",
    "[Console]::Out.WriteLine('READY')",
    '[Console]::Out.Flush()',
    'while ($true) {',
    '  $line = [Console]::In.ReadLine()',
    '  if ($null -eq $line) { break }',
    '  $line = $line.Trim()',
    '  if ($line.Length -eq 0) { continue }',
    "  $result = ''",
    '  try {',
    '    # الطلب يُرسل Base64 لتفادي أي مشكلة في ترميز أسماء الطابعات العربية',
    '    $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($line))',
    '    $req = $json | ConvertFrom-Json',
    '    $result = [PosRawPrint]::Send([string]$req.printer, [string]$req.file)',
    '  } catch {',
    "    $result = 'ERR:EXCEPTION ' + $_.Exception.Message",
    '  }',
    '  [Console]::Out.WriteLine([string]$result)',
    '  [Console]::Out.Flush()',
    '}'
  ];
  return lines.join('\r\n');
}

class RawSpooler {
  constructor() {
    this.child = null;
    this.buffer = '';
    this.waiter = null;
    this.chain = Promise.resolve();
  }

  running() {
    return !!this.child;
  }

  start() {
    if (!IS_WINDOWS || this.child) return;
    const script = encodePwsh(helperScript());
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', script
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, '').trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        if (line === 'READY') continue;
        if (this.waiter) {
          const resolve = this.waiter;
          this.waiter = null;
          resolve(line);
        }
      }
    });
    child.stderr.on('data', () => { /* نقرأ الأخطاء فقط عند فشل الإرسال */ });
    child.on('exit', () => {
      if (this.child === child) this.child = null;
      if (this.waiter) {
        const resolve = this.waiter;
        this.waiter = null;
        resolve('ERR:EXITED');
      }
    });
    child.stdin.on('error', () => { /* يظهر لاحقًا كخروج العملية */ });
    this.child = child;
    this.buffer = '';
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.stdin.write('__EXIT__\n'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 500).unref?.();
    }
  }

  request(payload, timeout = 25000) {
    this.chain = this.chain.then(() => this._request(payload, timeout)).catch(() => 'ERR:CHAIN');
    return this.chain;
  }

  _request(payload, timeout) {
    this.start();
    const child = this.child;
    if (!child) return Promise.resolve('ERR:NOPWSH');
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.waiter === finish) this.waiter = null;
        resolve(value);
      };
      const timer = setTimeout(() => {
        // لا نترك العملية معلّقة: نقتلها حتى تُعاد في المرة القادمة.
        this.stop();
        finish('ERR:TIMEOUT');
      }, timeout);
      this.waiter = finish;
      try {
        const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
        child.stdin.write(`${encoded}\n`);
      } catch (err) {
        this.stop();
        finish(`ERR:STDIN ${err.message}`);
      }
    });
  }
}

const spooler = new RawSpooler();

function stopSpooler() {
  spooler.stop();
}

function parseSpoolResult(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'استجابة غير معروفة من نظام الطباعة' };
  if (raw.startsWith('OK')) return { ok: true, sent: Number(raw.slice(3)) || null };
  const code = raw.replace(/^ERR:/, '').trim();
  const hints = {
    OPENPRINTER: 'تعذّر فتح الطابعة (تحقق من اسمها في إعدادات ويندوز)',
    STARTDOC: 'رفض نظام الطباعة إنشاء المهمة (تحقق من المنفذ/التعريف)',
    WRITE: 'فشل إرسال البيانات إلى منفذ الطابعة',
    TIMEOUT: 'انتهت مهلة الإرسال إلى الطابعة',
    NOPWSH: 'PowerShell غير متاح على هذا الجهاز',
    EXITED: 'أُغلقت أداة الطباعة الخام بشكل مفاجئ',
    EXCEPTION: 'خطأ في أداة الطباعة الخام'
  };
  const key = Object.keys(hints).find((k) => code.startsWith(k));
  return { ok: false, error: key ? `${hints[key]} (${code})` : code };
}

/**
 * إرسال صورة نقاط إلى الطابعة عبر السولر بصيغة RAW.
 */
async function sendRasterRaw(printerName, raster, options = {}) {
  if (!IS_WINDOWS) {
    return { ok: false, error: 'الطباعة المباشرة ESC/POS تعمل على ويندوز فقط' };
  }
  let target = String(printerName || '').trim();
  if (!target) {
    const def = await queryPrinter('');
    if (!def || !def.name) return { ok: false, error: 'لا توجد طابعة افتراضية محددة في ويندوز' };
    target = def.name;
  }
  const job = buildEscPosJob(raster, options);
  const file = writeTempBin(job);
  try {
    const raw = await spooler.request({ printer: target, file });
    const parsed = parseSpoolResult(raw);
    if (!parsed.ok) return { ok: false, error: parsed.error, printer: target };
    return { ok: true, printer: target, bytes: job.length, dots: raster.width, rows: raster.height };
  } finally {
    removeLater(file, 30000);
  }
}

/* ------------------------ تحويل HTML إلى صورة نقاط ------------------------ */
/**
 * رسم HTML في نافذة مخفية بعرض = نقاط رأس الطابعة، ثم التقاطها كصورة.
 * zoomFactor = dpi/96 يجعل وحدات CSS (مم/px) تُرسم بمقاسها الفيزيائي الحقيقي
 * على شبكة نقاط الطابعة، فيخرج النص بمقاسه الصحيح لورق 58 أو 80 مم.
 */
async function htmlToRaster(html, options = {}) {
  const { BrowserWindow } = require('electron');
  const metrics = paperMetrics(options);
  const dots = metrics.dots;
  // زوم يجعل 1 مم في CSS = dotsPerMm نقطة فعلية على الورق
  const zoom = (metrics.dotsPerMm * 25.4) / 96;
  const file = path.join(tmpSubdir(), `raster-${Date.now()}-${process.pid}.html`);
  fs.writeFileSync(file, html, 'utf8');

  const win = new BrowserWindow({
    show: false,
    frame: false,
    width: dots,
    height: 800,
    useContentSize: true,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
      paintWhenInitiallyHidden: true,
      zoomFactor: zoom
    }
  });

  try {
    await win.loadFile(file);
    try {
      await win.webContents.executeJavaScript(
        'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true', true
      );
    } catch { /* ignore */ }
    await sleep(200);

    // إخفاء أشرطة التمرير: شريط التمرير العمودي يقتطع ~15px من عرض الصفحة
    // فينزلق المحتوى أفقياً ويُقتطع طرف الفاتورة على ورق 58 مم.
    await win.webContents.executeJavaScript(`(() => {
      const style = document.createElement('style');
      style.id = 'pos-raster-css';
      style.textContent = 'html,body{overflow:hidden !important;}' +
        '::-webkit-scrollbar{width:0 !important;height:0 !important;display:none !important;}';
      document.head.appendChild(style);
      return true;
    })()`, true).catch(() => {});

    const measurePage = () => win.webContents.executeJavaScript(`(() => {
      const d = document.documentElement;
      const b = document.body;
      const bb = b ? b.getBoundingClientRect() : null;
      return {
        h: Math.ceil(Math.max(d.scrollHeight, b ? b.scrollHeight : 0)),
        w: Math.ceil(Math.max(bb ? bb.width : 0, d.scrollWidth, b ? b.scrollWidth : 0))
      };
    })()`, true).catch(() => ({ h: 600, w: 0 }));

    let zoomFactor = zoom;
    let measured = await measurePage();
    // حماية من القطع: لو كان المستند أوسع من عدد نقاط الطابعة (مقاس ورق مختلف
    // أو عرض نقاط مخصص) نُصغّر الزوم قليلًا حتى تدخل الفاتورة كاملة.
    if (measured && measured.w > 0) {
      const needed = dots / measured.w;
      if (needed < zoomFactor * 0.995) {
        zoomFactor = Math.max(0.4, needed);
        win.webContents.setZoomFactor(zoomFactor);
        await sleep(280);
        measured = await measurePage();
      }
    }

    const cssHeight = Math.max(60, Number(measured && measured.h) || 600);
    const heightDIP = clamp(Math.round(cssHeight * zoomFactor) + 8, 80, 14000);
    win.setContentSize(dots, heightDIP);
    await sleep(260);

    let image = await win.webContents.capturePage();
    if (!image || image.isEmpty() || image.getSize().width < 8) {
      // بعض تعريفات الرسوميات لا ترسم النوافذ المخفية: نُظهرها خارج الشاشة لحظيًا.
      win.setBounds({ x: -20000, y: -20000, width: dots, height: heightDIP });
      win.showInactive();
      await sleep(350);
      image = await win.webContents.capturePage();
      win.hide();
    }
    if (!image || image.isEmpty()) throw new Error('تعذّر تحويل الفاتورة إلى صورة للطباعة');

    const size = image.getSize();
    if (size.width !== dots && size.width > 0) {
      image = image.resize({ width: dots, quality: 'best' });
    }
    const finalSize = image.getSize();
    if (!finalSize.width || !finalSize.height) throw new Error('صورة الفاتورة فارغة');

    const pixels = image.toBitmap();
    const raster = packRasterBitmap(pixels, finalSize.width, finalSize.height, options.threshold || 168);
    const trimmed = trimRaster(raster, 8);
    return {
      ...trimmed,
      widthDots: finalSize.width,
      dpi: metrics.dpi,
      heightDots: trimmed.height
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
    removeLater(file, 30000);
  }
}

module.exports = {
  IS_WINDOWS,
  DPI_PRESETS,
  DOTS_PER_MM,
  printableWidthMm,
  paperMetrics,
  packRasterBitmap,
  trimRaster,
  chunkRaster,
  buildEscPosJob,
  buildRasterBlock,
  cutCommand,
  looksThermal,
  queryPrinter,
  printerDetails,
  htmlToRaster,
  sendRasterRaw,
  parseSpoolResult,
  stopSpooler,
  encodePwsh,
  helperScript
};
