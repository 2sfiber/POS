'use strict';
/**
 * العملية الرئيسية: نافذة التطبيق، الجلسة، فرض الصلاحيات، ومنع أي اتصال بالإنترنت.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const db = require('./db');
const printing = require('./printing');
const escpos = require('./escpos');
const exporter = require('./exports');
const legacy = require('./legacy');
const { verifyPassword } = require('./security');
const { readBuildInfo } = require('./buildinfo');
const updater = require('./updater');

const HEADLESS = process.env.POS_HEADLESS === '1';
const isDev = !app.isPackaged;

let mainWindow = null;
let sessionState = { user: null };
let pendingUpdate = null; // تحديث تم التحقق منه وتجهيزه بانتظار تأكيد التثبيت
let backupTimer = null;
let lastBackupAt = 0;
let sessionBackupAt = 0;  // آخر نسخة احتياطية عند إغلاق الوردية/الخروج (منع التكرار)
let auditArchiveTimer = null;
let allowWindowClose = false; // الإغلاق مسموح بعد تأكيد المستخدم أو بعد بدء تحديث
let closePromptOpen = false;  // نافذة تأكيد الإغلاق معروضة الآن (منع تكرارها)
let cleanupDone = false;      // تنظيف ما قبل الخروج يُنفّذ مرة واحدة فقط
let appIconCache = '';        // أيقونة البرنامج (من ملف exe) لصفحة «عن البرنامج»

/**
 * نتيجة آخر تحديث طبّقه سكربت PowerShell (لإظهار نافذة نجاح بعد إعادة التشغيل).
 * بعد قراءتها نُبقي نسخة في last-update.json لتظهر في تشخيص التحديث.
 * نتحقق أيضًا من أن النسخة العاملة الآن هي النسخة التي استُبدلت فعلًا — فلو كان
 * هناك تثبيتان (منفذ + مثبّت) يظهر ذلك بوضوح بدل «نجح التحديث ولا تغيير».
 */
function readUpdateResult() {
  if (!app.isPackaged) return null;
  const file = path.join(process.resourcesPath, 'update-result.json');
  const keep = path.join(process.resourcesPath, 'last-update.json');
  try {
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    try { fs.renameSync(file, keep); } catch { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } }
    if (!data || typeof data !== 'object') return null;
    const verified = verifyAppliedUpdate(data);
    if (!verified.verified) {
      try {
        const logFile = path.join(process.resourcesPath, 'update.log');
        if (fs.existsSync(logFile)) {
          const text = fs.readFileSync(logFile, 'utf8').replace(/^\uFEFF/, '');
          verified.log = text.split(/\r?\n/).filter(Boolean).slice(-12).join('\n');
        }
      } catch { /* ignore */ }
    }
    // نحفظ نسخة مُتحقَّق منها ليعرضها تشخيص التحديث لاحقًا
    try { fs.writeFileSync(keep, JSON.stringify(verified, null, 2), 'utf8'); } catch { /* ignore */ }
    return verified;
  } catch {
    return null;
  }
}

function asarInfo() {
  const file = path.join(process.resourcesPath, 'app.asar');
  try {
    const stat = fs.statSync(file);
    let sha = '';
    try { sha = updater.sha256File(file); } catch { sha = ''; }
    return { path: file, exists: true, bytes: stat.size, sha256: sha };
  } catch {
    return { path: file, exists: false, bytes: 0, sha256: '' };
  }
}

function verifyAppliedUpdate(data) {
  const out = { ...data };
  try {
    const build = readBuildInfo(process.resourcesPath, app.getVersion());
    const asar = asarInfo();
    out.expectBuild = String(data.build || '');
    out.actualBuild = build.build || '';
    out.expectSha = String(data.sha256 || '');
    out.actualSha = asar.sha256;
    out.actualBytes = asar.bytes;
    out.resourcesPath = process.resourcesPath;
    out.exePath = app.getPath('exe');
    if (data.ok) {
      const buildOk = !out.expectBuild || out.actualBuild === out.expectBuild;
      const shaOk = !out.expectSha || (out.actualSha && out.actualSha.toLowerCase() === out.expectSha.toLowerCase());
      out.verified = !!(buildOk && shaOk);
      if (!out.verified) {
        out.reason = !buildOk
          ? `النسخة العاملة الآن تحمل بناء ${out.actualBuild || 'غير معروف'} بدل ${out.expectBuild}`
          : 'ملف البرنامج العامّل لا يطابق بصمة التحديث المطبّق';
      }
    } else {
      out.verified = false;
    }
  } catch (err) {
    out.verified = false;
    out.reason = String((err && err.message) || err);
  }
  return out;
}

/** تشخيص التحديث: المسارات الحقيقية، بصمة الملف العامل، وسجل آخر تطبيق. */
function updateDiagnostics() {
  const build = readBuildInfo(process.resourcesPath, app.getVersion());
  const asar = asarInfo();
  let last = null;
  try {
    const f = path.join(process.resourcesPath, 'last-update.json');
    if (fs.existsSync(f)) last = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  } catch { last = null; }
  let log = '';
  try {
    const f = path.join(process.resourcesPath, 'update.log');
    if (fs.existsSync(f)) {
      const text = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
      log = text.split(/\r?\n/).filter(Boolean).slice(-25).join('\n');
    }
  } catch { log = ''; }
  return {
    packaged: app.isPackaged,
    version: build.version || app.getVersion(),
    build: build.build || '',
    exePath: app.getPath('exe'),
    resourcesPath: process.resourcesPath,
    appDir: path.dirname(process.resourcesPath),
    asar,
    pending: fs.existsSync(path.join(process.resourcesPath, 'update-pending')),
    backup: fs.existsSync(path.join(process.resourcesPath, 'app.asar.backup')),
    last,
    log
  };
}

// نافذة واحدة فقط: يمنع تعارض كتابة الفواتير من تبويبين.
if (!HEADLESS && !app.requestSingleInstanceLock()) {
  app.quit();
}

/**
 * نافذة تأكيد الإغلاق من داخل الواجهة نفسها (تصميم البرنامج) بدل نافذة ويندوز الافتراضية.
 * تُعرض دائمًا — حتى لو كانت السلة فارغة — وتوضح حالة السلة والوردية.
 * → true إذا وافق المستخدم على الإغلاق.
 */
async function confirmCloseApp(win) {
  if (!win || win.isDestroyed()) return true;
  try {
    const answer = await win.webContents.executeJavaScript(
      'window.confirmCloseApp ? window.confirmCloseApp() : true', true
    );
    return answer !== false;
  } catch {
    // الواجهة غير متاحة (فشل تحميل أو إغلاق قسري): لا نحبس المستخدم
    return true;
  }
}

/** حفظ السلة فورًا ثم تنفيذ callback (مع حد زمني حتى لا يُعلّق الإغلاق). */
function flushCartThen(win, callback) {
  let done = false;
  const finish = () => { if (done) return; done = true; clearTimeout(guard); callback(); };
  const guard = setTimeout(finish, 1500);
  try {
    Promise.resolve(win.webContents.executeJavaScript('window.flushCartDraft && window.flushCartDraft()', true))
      .then(finish, finish);
  } catch { finish(); }
}

/* مسار أيقونة التطبيق (build/icon.ico) — تُستخدم للنافذة ولصفحة «عن البرنامج» */
const APP_ICON_ICO = path.join(__dirname, '..', 'build', 'icon.ico');
const APP_ICON_PNG = path.join(__dirname, '..', 'build', 'icon.png');

function createWindow() {
  const win = new BrowserWindow({
    width: 1366,
    height: 850,
    minWidth: 1024,
    minHeight: 650,
    show: false,
    backgroundColor: '#0f172a',
    title: 'POS Pro — نظام نقاط البيع',
    icon: fs.existsSync(APP_ICON_ICO) ? APP_ICON_ICO : APP_ICON_PNG,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      offscreen: HEADLESS,
      backgroundThrottling: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // الوضع الافتراضي عند التشغيل: نافذة مكبّرة (Maximize)
  win.once('ready-to-show', () => {
    if (HEADLESS) return;
    win.maximize();
    win.show();
  });

  // تأكيد الإغلاق دائمًا بنافذة من تصميم البرنامج، مع حفظ السلة قبل الخروج.
  win.on('close', (event) => {
    if (allowWindowClose || HEADLESS) return;
    event.preventDefault();
    if (closePromptOpen) return;
    closePromptOpen = true;
    confirmCloseApp(win).then((confirmed) => {
      if (!confirmed) { closePromptOpen = false; return; }
      flushCartThen(win, () => {
        allowWindowClose = true;
        closePromptOpen = false;
        win.close();
      });
    }).catch(() => { closePromptOpen = false; });
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  win.on('closed', () => { mainWindow = null; });
  return win;
}

function hardenOffline() {
  // التطبيق يعمل بلا إنترنت: نلغي أي طلب شبكة (http/https/ws) ولو حاولت مكتبة ذلك.
  const filter = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] };
  session.defaultSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    callback({ cancel: true });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

/* ------------------------------ الصلاحيات ------------------------------ */
const PERM_LABELS = {
  pos: 'شاشة الكاشير', products: 'إدارة المنتجات والمخزون', reports: 'التقارير',
  treasury: 'الخزينة والمصروفات', invoices: 'إدارة الفواتير', users: 'المستخدمين',
  settings: 'الإعدادات', apply_discount: 'تطبيق خصم', cancel_invoice: 'إلغاء الفواتير'
};

function currentUser() {
  return sessionState.user;
}

function requireUser() {
  const user = currentUser();
  if (!user) throw new Error('يجب تسجيل الدخول أولاً');
  if (user.mustChangePassword) throw new Error('يجب تغيير كلمة المرور الافتراضية قبل المتابعة');
  return user;
}

function requirePerm(perm) {
  const user = requireUser();
  if (user.role === 'admin') return user;
  if (user.permissions && user.permissions[perm]) return user;
  throw new Error(`لا تملك صلاحية: ${PERM_LABELS[perm] || perm}`);
}

function requireAny(perms) {
  const user = requireUser();
  if (user.role === 'admin') return user;
  if (perms.some((p) => user.permissions && user.permissions[p])) return user;
  throw new Error('لا تملك الصلاحية لهذا الإجراء');
}

/* ------------------------------ معالجات البيانات ------------------------------ */
const handlers = {
  /* ---- الجلسة ---- */
  'auth:login': async ({ username, password }) => {
    const row = db.userRow(String(username || '').trim().toLowerCase());
    if (!row) throw new Error('اسم المستخدم غير موجود');
    if (!verifyPassword(password, row.password_hash)) throw new Error('كلمة المرور غير صحيحة');
    const user = db.userGet(row.username);
    sessionState.user = user;
    const shift = db.shiftActive(user.username);
    db.audit(user.username, 'login', { shiftId: shift ? shift.id : null });
    scheduleBackup();
    return {
      user,
      shift,
      settings: db.settingsGet(),
      firstRun: user.mustChangePassword
    };
  },
  'auth:logout': async () => {
    const u = currentUser();
    if (u) {
      db.audit(u.username, 'logout', {});
      // محو الفواتير المعلقة التابعة لهذا المستخدم عند تسجيل الخروج
      db.holdsClearForUser(u.username);
    }
    sessionState.user = null;
    // السلة المحفوظة تبقى لهذا المستخدم حتى لا تضيع عند إغلاق البرنامج بعد الخروج
    return { ok: true };
  },
  'auth:changePassword': async ({ oldPassword, newPassword }) => {
    const user = currentUser();
    if (!user) throw new Error('يجب تسجيل الدخول');
    const row = db.userRow(user.username);
    if (!verifyPassword(oldPassword, row.password_hash)) throw new Error('كلمة المرور الحالية غير صحيحة');
    const pass = String(newPassword || '');
    if (pass.length < 6) throw new Error('كلمة المرور الجديدة قصيرة (6 أحرف على الأقل)');
    if (pass === oldPassword) throw new Error('اختر كلمة مرور مختلفة عن الحالية');
    db.userSetPassword(user.username, pass, false);
    sessionState.user = db.userGet(user.username);
    db.audit(user.username, 'change_password', {});
    // عند تغيير كلمة المرور ننزل الفواتير المعلقة التابعة لهذا المستخدم
    db.holdsClearForUser(user.username);
    return { user: sessionState.user };
  },
  'auth:session': async () => ({ user: currentUser(), settings: db.settingsGet() }),
  /* قائمة أسماء المستخدمين لشاشة الدخول (بلا تسجيل دخول): الاسم فقط، بلا أي بيانات حساسة */
  'auth:users': async () => db.usersList().map((u) => ({
    username: u.username,
    name: u.name || u.username,
    role: u.role === 'admin' ? 'admin' : 'cashier'
  })),

  /* ---- مسودّة السلة: حفظ/استعادة بعد إغلاق مفاجئ أو إعادة تشغيل ---- */
  'cart:get': async () => db.cartDraftGet(requireUser().username),
  'cart:save': async (payload) => {
    const user = requireUser();
    return db.cartDraftSave(user.username, payload || {});
  },
  'cart:clear': async () => {
    const user = requireUser();
    return db.cartDraftClear(user.username);
  },

  /* ---- معلومات التطبيق ---- */
  'app:info': async () => {
    // رقم الإصدار + رقم البناء (يُكتب resources/build.json عند ضغط الحزمة)
    const buildInfo = readBuildInfo(process.resourcesPath, app.getVersion());
    return {
      version: buildInfo.version || app.getVersion(),
      build: buildInfo.build,
      buildNumber: buildInfo.number,
      buildDate: buildInfo.date,
      updateResult: readUpdateResult(),
      electron: process.versions.electron,
      platform: process.platform,
      headless: HEADLESS,
      db: db.dbInfo(),
      userData: app.getPath('userData'),
      firstRunAccounts: db.usersList().some((u) => u.mustChangePassword),
      printersSupported: true
    };
  },
  /*
   * أيقونة البرنامج لعرضها في «عن البرنامج» (بدل شعار المتجر):
   * نقرأ build/icon.png المرفقة مع البرنامج أولًا (وضوح 256px في كل الأوضاع)،
   * ثم أيقونة ملف exe كبديل عند تشغيل نسخة قديمة لم تحمل build/icon.png.
   */
  'app:icon': async () => {
    if (!appIconCache) {
      try {
        const png = fs.readFileSync(path.join(app.getAppPath(), 'build', 'icon.png'));
        if (png && png.length) appIconCache = `data:image/png;base64,${png.toString('base64')}`;
      } catch { /* نكمل إلى أيقونة الملف التنفيذي */ }
      if (!appIconCache) {
        try {
          const image = await app.getFileIcon(app.getPath('exe'), { size: 'large' });
          const png = image && !image.isEmpty() ? image.toPNG() : null;
          if (png && png.length) appIconCache = `data:image/png;base64,${png.toString('base64')}`;
        } catch { /* لا توجد أيقونة بديلة */ }
      }
    }
    return { dataUrl: appIconCache };
  },
  'app:openDataFolder': async () => {
    requireAny(['settings', 'users']);
    await shell.openPath(app.getPath('userData'));
    return { ok: true };
  },
  /* فتح رابط خارجي مسموح فقط (واتساب / اتصال) — لا روابط أخرى */
  'app:openExternal': async ({ url }) => {
    const link = String(url || '').trim();
    const allowed = /^https:\/\/wa\.me\/[0-9]{6,20}$/.test(link) || /^tel:\+?[0-9]{6,20}$/.test(link);
    if (!allowed) throw new Error('رابط غير مسموح');
    await shell.openExternal(link);
    return { ok: true };
  },

  /* ---- الإعدادات ---- */
  'settings:get': async () => db.settingsGet(),
  'settings:save': async (patch) => {
    const user = requirePerm('settings');
    const saved = db.settingsSave(patch);
    db.audit(user.username, 'settings_save', { keys: Object.keys(patch || {}) });
    scheduleBackup();
    return saved;
  },

  /* ---- الأصناف ---- */
  'products:list': async () => {
    requireAny(['pos', 'products']);
    return db.productsList();
  },
  /* شريط «الأسرع طلبًا» في شاشة الكاشير: الأصناف الأكثر مبيعًا فعليًّا */
  'products:favorites': async ({ limit } = {}) => {
    requireAny(['pos', 'products']);
    return db.topProducts(limit);
  },
  'products:save': async (payload) => {
    const user = requirePerm('products');
    return db.productsSave(payload, user);
  },
  'products:delete': async ({ id }) => {
    const user = requirePerm('products');
    return db.productsDelete(id, user);
  },

  /* ---- الخامات والوصفات (Bill of Materials) ---- */
  'materials:list': async () => {
    requireAny(['products', 'pos']);
    return db.materialsList();
  },
  'materials:save': async (payload) => {
    const user = requirePerm('products');
    return db.materialSave(payload || {}, user.username);
  },
  'materials:delete': async ({ id }) => {
    const user = requirePerm('products');
    return db.materialDelete(id, user.username);
  },
  'categories:list': async () => {
    requireAny(['pos', 'products']);
    return db.categoriesList();
  },
  'categories:add': async ({ name }) => {
    const user = requirePerm('products');
    return db.categoryAdd(name, user);
  },
  'categories:delete': async ({ name }) => {
    const user = requirePerm('products');
    return db.categoryDelete(name, user);
  },

  /* ---- العملاء ---- */
  'customers:get': async ({ phone }) => {
    requireUser();
    return db.customers.get(phone);
  },
  'customers:save': async ({ phone, name }) => {
    requireUser();
    return db.customers.save(phone, name);
  },

  /* ---- الورديات ---- */
  'shift:active': async () => {
    const user = requireUser();
    return db.shiftActive(user.username);
  },
  'shift:open': async ({ openingFloat }) => {
    const user = requireUser();
    const shift = db.shiftOpen(user, openingFloat);
    return shift;
  },
  'shift:summary': async ({ shiftId }) => {
    requireUser();
    return db.shiftSummary(shiftId);
  },
  'shift:close': async ({ shiftId, actualCash }) => {
    const user = requireUser();
    return db.shiftClose(shiftId, actualCash, user);
  },
  'shift:last': async () => {
    requireUser();
    const list = db.shiftActive(currentUser().username);
    return list;
  },

  /* ---- الفواتير ---- */
  'invoices:create': async (payload) => {
    const user = requireUser();
    if (!(user.permissions && user.permissions.pos)) throw new Error('لا تملك صلاحية شاشة الكاشير');
    const hasDiscount = (Number(payload.discountValue) || 0) > 0;
    if (hasDiscount && !(user.role === 'admin' || user.permissions.apply_discount)) {
      throw new Error('لا تملك صلاحية تطبيق الخصم');
    }
    const invoice = db.invoiceCreate(payload, user);
    return invoice;
  },
  'invoices:cancel': async ({ id, reason, adminPassword }) => {
    const user = requireUser();
    if (!(user.role === 'admin' || user.permissions.cancel_invoice)) {
      throw new Error('لا تملك صلاحية إلغاء الفواتير');
    }
    // تأكيد إضافي بكلمة مرور المستخدم نفسه قبل الإلغاء (إجراء مالي حساس)
    const row = db.userRow(user.username);
    if (!verifyPassword(adminPassword, row.password_hash)) throw new Error('كلمة المرور غير صحيحة');
    return db.invoiceCancel(id, reason, user);
  },
  'invoices:get': async ({ id }) => {
    requireAny(['pos', 'invoices', 'reports']);
    return db.invoiceGet(id);
  },
  'invoices:list': async (filter) => {
    requireAny(['invoices', 'reports']);
    return db.invoicesList(filter || {});
  },
  'invoices:shift': async ({ shiftId }) => {
    requireUser();
    return db.invoicesList({ shiftId, limit: 1000 });
  },
  'invoices:last': async () => {
    requireUser();
    const shift = db.shiftActive(currentUser().username);
    if (!shift) return null;
    const list = db.invoicesList({ shiftId: shift.id, status: 'completed', limit: 1 });
    return list[0] || null;
  },

  /* ---- المرتجعات ---- */
  'returns:find': async ({ term }) => {
    requireAny(['invoices', 'reports', 'pos']);
    return db.returnsFind(term);
  },
  'returns:list': async (filter) => {
    requireAny(['invoices', 'reports']);
    return db.returnsList(filter || {});
  },
  'returns:summary': async (filter) => {
    requireAny(['invoices', 'reports']);
    return db.returnsSummary(Number(filter && filter.from) || 0, Number(filter && filter.to) || Date.now());
  },
  'returns:create': async (payload) => {
    const user = requireAny(['invoices', 'pos']);
    return db.returnsCreate(payload || {}, user);
  },

  /* ---- المعلّقة ---- */
  'holds:list': async (payload) => {
    const user = requireUser();
    return db.holdsList(user ? user.username : null);
  },
  'holds:add': async (payload) => {
    const user = requireUser();
    return db.holdsAdd(payload, user);
  },
  'holds:delete': async ({ id }) => {
    requireUser();
    return db.holdsDelete(id);
  },

  /* ---- المصروفات والخزنة ---- */
  'expenses:list': async (filter) => {
    requireAny(['treasury', 'reports']);
    return db.expensesList(filter && filter.from, filter && filter.to);
  },
  'expenses:add': async (payload) => {
    const user = requirePerm('treasury');
    return db.expenseAdd(payload, user);
  },
  'expenses:delete': async ({ id }) => {
    const user = requirePerm('treasury');
    return db.expenseDelete(id, user);
  },
  'treasury:list': async () => {
    requireAny(['treasury', 'reports']);
    return db.treasuryList();
  },
  'treasury:add': async (payload) => {
    const user = requirePerm('treasury');
    return db.treasuryAdd(payload, user);
  },
  'treasury:summary': async (filter) => {
    requireAny(['treasury', 'reports']);
    return db.treasurySummary(filter && filter.from, filter && filter.to);
  },
  'receivables:list': async (filter) => {
    requireAny(['treasury', 'reports']);
    return db.receivablesList(filter && filter.status);
  },
  'receivables:settle': async ({ id, amount }) => {
    const user = requirePerm('treasury');
    return db.receivableSettle(id, amount, user);
  },

  /* ---- التقارير ---- */
  'reports:summary': async (filter) => {
    requireAny(['reports', 'treasury']);
    const to = Number(filter && filter.to) || Date.now();
    const from = Number(filter && filter.from) || 0;
    return db.reportsSummary(from, to, filter && filter.category);
  },
  'reports:advanced': async (filter) => {
    requireAny(['reports', 'treasury']);
    return db.reportsAdvanced(
      Number(filter && filter.from) || 0,
      Number(filter && filter.to) || Date.now(),
      filter && filter.category
    );
  },
  'reports:staff': async (filter) => {
    requireAny(['reports', 'treasury']);
    return db.reportsStaff(
      Number(filter && filter.from) || 0,
      Number(filter && filter.to) || Date.now(),
      filter && filter.category
    );
  },
  'reports:audit': async () => {
    requireAny(['users', 'settings']);
    return db.auditList(300);
  },

  /* ---- المستخدمون ---- */
  'users:list': async () => {
    requirePerm('users');
    return db.usersList();
  },
  'users:save': async (payload) => {
    const user = requirePerm('users');
    return db.userSave(payload, user.username);
  },
  'users:delete': async ({ username }) => {
    const user = requirePerm('users');
    return db.userDelete(username, user.username);
  },

  /* ---- شركات التوصيل ---- */
  'delivery:list': async () => {
    requireUser();
    return db.deliveryList();
  },
  'delivery:save': async (payload) => {
    const user = requirePerm('settings');
    return db.deliverySave(payload, user);
  },
  'delivery:delete': async ({ id }) => {
    const user = requirePerm('settings');
    return db.deliveryDelete(id, user);
  },

  /* ---- الطباعة ---- */
  'print:list': async () => {
    requireUser();
    return printing.listPrinters();
  },
  'print:receipt': async (payload) => {
    requireUser();
    return printing.printHtml({
      html: payload.html,
      printerName: payload.printerName,
      paperWidth: payload.paperWidth,
      copies: payload.copies,
      mode: payload.mode,
      dpi: payload.dpi,
      dots: payload.dots,
      feedLines: payload.feedLines,
      cutFeedMm: payload.cutFeedMm,
      cut: payload.cut,
      jobName: payload.jobName,
      silent: payload.silent !== false
    });
  },
  'print:preview': async (payload) => {
    requireUser();
    return printing.previewHtml({ html: payload.html, title: payload.title });
  },
  /* طباعة التقارير على ورق A4 عبر تعريف ويندوز (الصفحات تتوزع تلقائيًا) */
  'print:a4': async (payload) => {
    requireAny(['reports', 'treasury', 'settings']);
    return printing.printA4({
      html: payload.html,
      printerName: payload.printerName,
      copies: payload.copies,
      jobName: payload.jobName
    });
  },
  'print:test': async (payload) => {
    requirePerm('settings');
    return printing.printTestPage(payload && payload.printerName, payload && payload.paperWidth, {
      mode: payload && payload.mode,
      dpi: payload && payload.dpi,
      dots: payload && payload.dots,
      feedLines: payload && payload.feedLines,
      cutFeedMm: payload && payload.cutFeedMm,
      cut: payload && payload.cut
    });
  },
  'print:info': async (payload) => {
    requirePerm('settings');
    return printing.diagnose(payload && payload.printerName);
  },
  /* ---- إدارة البيانات: تصفير أو حذف كامل (المدير فقط + كلمة المرور) ---- */
  'data:reset': async ({ password }) => {
    const user = requirePerm('settings');
    if (user.role !== 'admin') throw new Error('تصفير البيانات متاح للمدير فقط');
    const row = db.userRow(user.username);
    if (!row || !verifyPassword(password, row.password_hash)) throw new Error('كلمة المرور غير صحيحة');
    const res = db.resetData(user.username);
    return { ...res, settings: db.settingsGet() };
  },
  'data:wipe': async ({ password }) => {
    const user = requirePerm('settings');
    if (user.role !== 'admin') throw new Error('الحذف الكامل متاح للمدير فقط');
    const row = db.userRow(user.username);
    if (!row || !verifyPassword(password, row.password_hash)) throw new Error('كلمة المرور غير صحيحة');

    const info = db.dbInfo();
    const dir = path.dirname(info.path);
    db.close();
    sessionState = { user: null };
    // حذف قاعدة البيانات وملفات WAL والنسخ الاحتياطية (البيانات والإعدادات معًا)
    ['pos.db', 'pos.db-wal', 'pos.db-shm'].forEach((name) => {
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* ignore */ }
    });
    try { fs.rmSync(path.join(dir, 'backups'), { recursive: true, force: true }); } catch { /* ignore */ }
    // قاعدة جديدة فارغة (تُنشاء حسابات البدء من جديد)
    db.init(dir);
    setTimeout(() => {
      try { app.relaunch(); } catch { /* ignore */ }
      app.exit(0);
    }, 800);
    return { ok: true, restarted: true, dir };
  },
  /* ---- التحديث المحلي ---- */
  'update:info': async () => {
    const info = readBuildInfo(process.resourcesPath, app.getVersion());
    return {
      ...info,
      packaged: app.isPackaged,
      platform: process.platform,
      exePath: app.getPath('exe'),
      resourcesPath: process.resourcesPath,
      pending: fs.existsSync(path.join(process.resourcesPath, 'update-pending'))
    };
  },
  'update:diagnostics': async () => {
    requirePerm('settings');
    return updateDiagnostics();
  },
  'app:copyText': async ({ text }) => {
    requireUser();
    clipboard.writeText(String(text || ''));
    return { ok: true };
  },
  /* المرحلة ١: اختيار الملف والتحقق منه وتجهيزه — بلا أي تغيير على البرنامج */
  'update:prepare': async () => {
    const user = requirePerm('settings');
    if (user.role !== 'admin') throw new Error('التحديث متاح للمدير فقط');
    if (!app.isPackaged) {
      return { ok: false, error: 'التحديث المحلي يعمل على النسخة المثبتة فقط (شغّل POS Pro.exe)' };
    }
    if (!updater.IS_WINDOWS) {
      return { ok: false, error: 'تطبيق التحديث التلقائي متاح على ويندوز فقط' };
    }
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'اختر ملف تحديث POS Pro',
      filters: [{ name: 'حزمة تحديث POS Pro', extensions: ['zip'] }],
      properties: ['openFile']
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };

    let res;
    try {
      res = await updater.installUpdate({
        file: picked.filePaths[0],
        resourcesDir: process.resourcesPath,
        exePath: app.getPath('exe'),
        pid: process.pid
      });
    } catch (err) {
      return { ok: false, error: 'تعذّر تجهيز التحديث: ' + String((err && err.message) || err) };
    }
    if (!res.ok) return res;
    pendingUpdate = res;
    return {
      ok: true,
      prepared: true,
      file: picked.filePaths[0],
      manifest: res.manifest,
      current: readBuildInfo(process.resourcesPath, app.getVersion())
    };
  },
  /* المرحلة ٢: التأكيد — تشغيل سكربت التبديل بعد إغلاق البرنامج */
  'update:commit': async () => {
    const user = requirePerm('settings');
    if (user.role !== 'admin') throw new Error('التحديث متاح للمدير فقط');
    const prepared = pendingUpdate;
    if (!prepared || !prepared.scriptPath) {
      return { ok: false, error: 'لا يوجد تحديث مجهّز — اختر ملف التحديث أولاً' };
    }
    const launched = updater.startApplier(prepared.scriptPath);
    if (!launched.ok) return { ok: false, error: launched.error };
    pendingUpdate = null;
    allowWindowClose = true; // التحديث يغلق البرنامج عمدًا: لا نعرض تأكيد السلة
    setTimeout(() => app.quit(), 2500);
    return { ok: true, manifest: prepared.manifest, willRestart: true };
  },
  /* إن بقي تحديث مجهّز لم يُطبَّق (فشل تشغيل السكربت مثلًا) يمكن تطبيقه من هنا */
  'update:applyPending': async () => {
    const user = requirePerm('settings');
    if (user.role !== 'admin') throw new Error('التحديث متاح للمدير فقط');
    if (!app.isPackaged) return { ok: false, error: 'يعمل على النسخة المثبتة فقط' };
    const scriptPath = path.join(process.resourcesPath, 'update-pending', 'apply-update.ps1');
    if (!fs.existsSync(scriptPath)) return { ok: false, error: 'لا يوجد تحديث معلّق — اختر ملف التحديث من جديد' };
    const launched = updater.startApplier(scriptPath);
    if (!launched.ok) return { ok: false, error: launched.error };
    allowWindowClose = true; // التحديث يغلق البرنامج عمدًا: لا نعرض تأكيد السلة
    setTimeout(() => app.quit(), 2500);
    return { ok: true, willRestart: true };
  },
  'update:cancel': async () => {
    pendingUpdate = null;
    // حذف مجلد يحتوي app.asar: نُعطّل اعتراض asar مؤقتًا وإلا فشل الحذف
    const previousNoAsar = process.noAsar;
    process.noAsar = true;
    try {
      fs.rmSync(path.join(process.resourcesPath, 'update-pending'), { recursive: true, force: true });
    } catch { /* ignore */ } finally {
      process.noAsar = previousNoAsar;
    }
    return { ok: true };
  },
  'print:pdf': async (payload) => {
    requireUser();
    const res = await dialog.showSaveDialog({
      title: 'حفظ الملف بصيغة PDF',
      defaultPath: path.join(app.getPath('documents'), exporter.stampName(payload.defaultName || 'invoice', 'pdf')),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    return printing.savePdf({
      html: payload.html,
      filePath: res.filePath,
      widthMm: payload.widthMm,
      heightMm: payload.heightMm,
      marginMm: payload.marginMm
    });
  },

  /* ---- التصدير والنسخ الاحتياطي ---- */
  'export:excel': async ({ kind, from, to, shiftId, ids }) => {
    const perms = kind === 'products' ? ['products']
      : kind === 'returns' ? ['invoices', 'reports']
        : kind === 'treasury' ? ['treasury', 'reports'] : ['invoices', 'reports'];
    const user = requireAny(perms);
    const result = await exporter.exportExcel(kind, { from, to, shiftId, ids });
    if (result.ok) db.audit(user.username, 'export_excel', { kind, file: result.filePath });
    return result;
  },
  'export:csv': async ({ kind, from, to }) => {
    const perms = kind === 'products' ? ['products']
      : kind === 'returns' ? ['invoices', 'reports']
        : ['invoices', 'reports'];
    const user = requireAny(perms);
    const result = await exporter.exportCsv(kind, { from, to });
    if (result.ok) db.audit(user.username, 'export_csv', { kind, file: result.filePath });
    return result;
  },
  'backup:create': async () => {
    const user = requirePerm('settings');
    const res = exporter.createBackup('manual');
    db.audit(user.username, 'backup_create', { file: res.file });
    lastBackupAt = Date.now();
    return res;
  },
  /* نسخة احتياطية كاملة ومضغوطة من ملف القاعدة عند إغلاق الوردية أو تسجيل الخروج */
  'backup:session': async ({ reason } = {}) => {
    const user = requireUser();
    if (sessionBackupAt && Date.now() - sessionBackupAt < 60 * 1000) return { skipped: true };
    const res = exporter.createDbBackup(reason || 'session');
    sessionBackupAt = Date.now();
    db.audit(user.username, 'db_backup_session', { reason: reason || 'session', file: res.file });
    return res;
  },
  'backup:list': async () => {
    requirePerm('settings');
    return exporter.listBackups();
  },
  'backup:export': async () => {
    requirePerm('settings');
    return exporter.exportBackupAs();
  },
  'backup:import': async () => {
    const user = requirePerm('settings');
    const res = await exporter.importBackupFromFile(user.username);
    if (res.ok) {
      sessionState.user = null; // إعادة الدخول بعد الاستعادة
    }
    return res;
  },
  'backup:openFolder': async () => {
    requirePerm('settings');
    await shell.openPath(exporter.backupDir());
    return { ok: true };
  },
  'backup:importLegacy': async () => {
    const user = requirePerm('settings');
    const res = await dialog.showOpenDialog({
      title: 'استيراد نسخة النسخة القديمة (المتصفح)',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const file = res.filePaths[0];
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('الملف ليس JSON صالحًا'); }
    exporter.createBackup('pre-legacy-import');
    const result = legacy.importLegacy(data, user.username);
    sessionState.user = null;
    return { ...result, file };
  }
};

/* ---------------------------- الموجّه الآمن ---------------------------- */
function registerIpc() {
  ipcMain.handle('pos:invoke', async (event, channel, payload) => {
    try {
      if (!mainWindow || event.sender !== mainWindow.webContents) {
        throw new Error('طلب غير مصرح به');
      }
      const handler = handlers[channel];
      if (!handler) throw new Error('قناة غير معروفة: ' + channel);
      const data = await handler(payload || {}, event);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

/* ------------------------------ النسخ التلقائي ------------------------------ */
function scheduleBackup() {
  if (backupTimer) clearInterval(backupTimer);
  const settings = db.settingsGet();
  const run = () => {
    try {
      if (!db.settingsGet().autoBackupEnabled) return;
      const hours = Math.max(1, Number(db.settingsGet().backupInterval) || 24);
      if (Date.now() - lastBackupAt < hours * 3600 * 1000) return;
      const res = exporter.createBackup('auto');
      lastBackupAt = Date.now();
      db.audit('system', 'backup_auto', { file: res.file });
      // إشعار منبثق في الواجهة بأن النسخة التلقائية تمّت
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pos:event', {
          type: 'backup', reason: 'auto', file: res.file, at: Date.now()
        });
      }
    } catch { /* لا نُزعج المستخدم */ }
  };
  backupTimer = setInterval(run, 30 * 60 * 1000);
  setTimeout(run, 60 * 1000);
  run();
}

/* ---------------- أرشفة سجل التدقيق (أكثر من سنة) ---------------- */
/** يُشغَّل عند بدء البرنامج ثم مرة كل 24 ساعة: أرشفة ثم حذف السجلات الأقدم من سنة. */
function scheduleAuditArchive() {
  if (auditArchiveTimer) clearInterval(auditArchiveTimer);
  const run = () => {
    try {
      const res = db.auditArchive(365);
      if (res && res.removed > 0) {
        console.log(`[audit] تم أرشفة ${res.archived} سجلًا قديمًا وحذفها (${res.file})`);
      }
    } catch (err) {
      // لا نُفشل التشغيل بسبب فشل الأرشفة
      console.error('audit archive', err);
    }
  };
  run();
  auditArchiveTimer = setInterval(run, 24 * 60 * 60 * 1000);
}

/* ------------------------------ القائمة ------------------------------ */
function buildMenu() {
  /* نسخ/قص محميان: لا يُنفّذان أبدًا على حقل كلمة مرور حتى لو كان ظاهرًا */
  const guardedEdit = async (command) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const secret = await mainWindow.webContents.executeJavaScript(
      "(() => { const el = document.activeElement; return !!(el && (el.type === 'password' || el.dataset.secret === '1')); })()"
    ).catch(() => false);
    if (secret) return;
    if (command === 'copy') mainWindow.webContents.copy();
    else mainWindow.webContents.cut();
  };
  const template = [
    {
      label: 'ملف',
      submenu: [
        {
          label: 'نسخة احتياطية الآن',
          accelerator: 'CmdOrCtrl+B',
          click: async () => {
            try {
              requirePerm('settings');
              const res = exporter.createBackup('manual');
              lastBackupAt = Date.now();
              if (!HEADLESS) {
                dialog.showMessageBox(mainWindow, {
                  type: 'info', title: 'نسخة احتياطية',
                  message: 'تم إنشاء النسخة الاحتياطية',
                  detail: res.file
                });
              }
            } catch (err) {
              if (!HEADLESS) dialog.showErrorBox('تعذّر إنشاء النسخة', err.message);
            }
          }
        },
        { type: 'separator' },
        {
          label: 'طباعة صفحة اختبار',
          click: async () => {
            const s = db.settingsGet();
            await printing.printTestPage(s.printerName, s.printerWidth, {
              mode: s.printMode, dpi: s.printerDpi, dots: s.printerDots,
              feedLines: s.feedLines, cutFeedMm: s.cutFeedMm, cut: s.cutPaper
            });
          }
        },
        { type: 'separator' },
        { role: 'quit', label: 'خروج' }
      ]
    },
    {
      label: 'تحرير',
      submenu: [
        { role: 'undo', label: 'تراجع' },
        { role: 'redo', label: 'إعادة' },
        { type: 'separator' },
        { label: 'قص', accelerator: 'CmdOrCtrl+X', click: () => guardedEdit('cut') },
        { label: 'نسخ', accelerator: 'CmdOrCtrl+C', click: () => guardedEdit('copy') },
        { role: 'paste', label: 'لصق' },
        { role: 'selectAll', label: 'تحديد الكل' }
      ]
    },
    {
      label: 'عرض',
      submenu: [
        { role: 'reload', label: 'إعادة تحميل' },
        { role: 'togglefullscreen', label: 'ملء الشاشة' },
        { role: 'zoomIn', label: 'تكبير' },
        { role: 'zoomOut', label: 'تصغير' },
        { role: 'resetZoom', label: 'الحجم الطبيعي' },
        ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools', label: 'أدوات المطور' }] : [])
      ]
    },
    {
      label: 'مساعدة',
      submenu: [
        {
          label: 'عن البرنامج',
          click: () => {
            if (HEADLESS) return;
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'POS Pro',
              message: 'نظام نقاط البيع الاحترافي ' + app.getVersion(),
              detail: `تطوير: عماد عقلان — عدن\nقاعدة البيانات:\n${db.dbInfo().path}\n\nيعمل بدون إنترنت.`
            });
          }
        },
        { label: 'فتح مجلد البيانات', click: () => shell.openPath(app.getPath('userData')) }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------ بدء التطبيق ------------------------------ */
// يجب أن يُستدعى قبل جاهزية التطبيق (وضع الاختبار فقط).
if (HEADLESS) app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let userDataDir = app.getPath('userData');
  if (process.env.POS_DB_DIR) userDataDir = process.env.POS_DB_DIR;

  try {
    const dbPath = db.init(userDataDir);
    const check = db.integrityCheck();
    if (!check.ok && !HEADLESS) {
      const choice = dialog.showMessageBoxSync({
        type: 'error',
        title: 'مشكلة في قاعدة البيانات',
        message: 'فحص سلامة قاعدة البيانات لم ينجح',
        detail: `${check.message}\n\nيمكنك المتابعة أو إغلاق البرنامج واستعادة نسخة احتياطية.\nالمسار: ${dbPath}`,
        buttons: ['متابعة', 'إغلاق'],
        defaultId: 1
      });
      if (choice === 1) { app.quit(); return; }
    }
    lastBackupAt = (exporter.listBackups()[0] || {}).mtime || 0;
  } catch (err) {
    dialog.showErrorBox('تعذّر فتح قاعدة البيانات', err.message);
    app.quit();
    return;
  }

  hardenOffline();
  // أرشفة سجل التدقيق: تُشغَّل عند الإقلاع ثم كل 24 ساعة
  scheduleAuditArchive();
  registerIpc();
  buildMenu();
  mainWindow = createWindow();

  if (HEADLESS) {
    mainWindow.webContents.on('console-message', (event, level, message, line, source) => {
      const text = message || (event && event.message) || '';
      const lvl = typeof level === 'number' ? level : (event && event.level);
      if (lvl === 'error' || lvl === 3 || lvl === 2) console.log(`[renderer:${lvl}] ${text} (${source || ''}:${line || ''})`);
    });
    mainWindow.webContents.once('did-finish-load', async () => {
      if (!process.env.POS_TEST_SCRIPT) return;
      console.log('[test] starting', process.env.POS_TEST_SCRIPT);
      let failed = false;
      try {
        const run = require(path.resolve(process.env.POS_TEST_SCRIPT));
        await run({ app, BrowserWindow, win: mainWindow, db, printing, exporter, legacy });
        console.log('[test] PASSED');
      } catch (err) {
        failed = true;
        console.error('[test] FAILED:', err && err.stack ? err.stack : err);
      } finally {
        if (failed) app.exit(1);
        else app.quit();
      }
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });

  if (!HEADLESS) {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function cleanupBeforeQuit() {
  if (cleanupDone) return;
  cleanupDone = true;
  try {
    if (db.settingsGet().autoBackupEnabled) exporter.createBackup('quit');
  } catch { /* ignore */ }
  if (backupTimer) clearInterval(backupTimer);
  if (auditArchiveTimer) clearInterval(auditArchiveTimer);
  try { escpos.stopSpooler(); } catch { /* ignore */ }
  db.close();
}

app.on('before-quit', (event) => {
  if (cleanupDone) return;
  // إغلاق النافذة تم بعد تأكيد المستخدم: يكفي التنظيف والخروج
  if (allowWindowClose || HEADLESS) {
    cleanupBeforeQuit();
    return;
  }
  event.preventDefault();
  const win = mainWindow;
  const finish = () => { cleanupBeforeQuit(); closePromptOpen = false; app.quit(); };
  if (!win || win.isDestroyed()) { finish(); return; }
  if (closePromptOpen) return;
  closePromptOpen = true;
  confirmCloseApp(win).then((confirmed) => {
    if (!confirmed) { closePromptOpen = false; return; } // ألغى المستخدم الخروج
    allowWindowClose = true;
    flushCartThen(win, finish);
  }).catch(() => { closePromptOpen = false; });
});

process.on('uncaughtException', (err) => {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'error.log'), new Date().toISOString() + ' ' + (err.stack || err.message) + '\n'); } catch { /* ignore */ }
  if (!HEADLESS) dialog.showErrorBox('خطأ غير متوقع', err.message);
});

process.on('unhandledRejection', (reason) => {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'error.log'), new Date().toISOString() + ' REJECTION ' + String(reason) + '\n'); } catch { /* ignore */ }
});

// للاختبار الآلي
if (HEADLESS) {
  module.exports = { getWindow: () => mainWindow };
}
