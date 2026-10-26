'use strict';
/* ============================================================
   بدء التطبيق: الدخول، الوردية، التنقل، الخروج
   ============================================================ */

function setLoginError(message) {
  const el = $('loginError');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

/* قائمة المستخدمين المحفوظين في شاشة الدخول (اختيار بدل الكتابة اليدوية) */
async function loadLoginUsers() {
  const sel = $('loginUser');
  if (!sel) return [];
  try {
    const users = await api('auth:users');
    const list = Array.isArray(users) ? users : [];
    if (!list.length) {
      sel.innerHTML = '<option value="admin">admin</option>';
      return [];
    }
    sel.innerHTML = list.map((u) =>
      `<option value="${esc(u.username)}">👤 ${esc(u.name || u.username)}${u.role === 'admin' ? ' — مدير' : ''}${u.name && u.name !== u.username ? ' (' + esc(u.username) + ')' : ''}</option>`
    ).join('');
    const savedUser = localStorage.getItem('pos_saved_user') || '';
    const chosen = list.find((u) => u.username === savedUser) ||
      list.find((u) => u.username === 'admin') || list[0];
    sel.value = chosen.username;
    return list;
  } catch (err) {
    sel.innerHTML = '<option value="admin">admin</option>';
    return [];
  }
}

async function showLogin() {
  $('loginScreen').classList.remove('hidden');
  $('appScreen').classList.add('hidden');
  $('loginPass').value = '';
  setLoginError('');
  const savedUser = localStorage.getItem('pos_saved_user') || '';
  $('rememberUser').checked = !!savedUser;
  await loadLoginUsers();
  setTimeout(() => {
    if (localStorage.getItem('pos_saved_user')) $('loginPass').focus();
    else $('loginUser').focus();
  }, 100);
}

function resetClientState() {
  state.user = null;
  state.shift = null;
  state.cart = [];
  state.discountValue = 0;
  state.customer = null;
  state.selectedInvoice = null;
  state.lastInvoice = null;
  state.reportData = null;
  state.products = [];
  state.categories = [];
  state.holds = [];
  if ($('cartDiscount')) $('cartDiscount').value = 0;
  if ($('cartItems')) $('cartItems').innerHTML = '';
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const username = $('loginUser').value.trim().toLowerCase();
  const password = $('loginPass').value;
  if (!username || !password) return setLoginError('أدخل اسم المستخدم وكلمة المرور');
  const btn = $('loginSubmit');
  btn.disabled = true;
  btn.textContent = 'جاري الدخول...';
  try {
    const data = await api('auth:login', { username, password });
    if ($('rememberUser').checked) localStorage.setItem('pos_saved_user', username);
    else localStorage.removeItem('pos_saved_user');

    state.user = data.user;
    state.settings = data.settings || state.settings;
    state.shift = data.shift;
    setLoginError('');

    if (data.user.mustChangePassword) {
      $('fpOld').value = '';
      $('fpNew').value = '';
      $('fpNew2').value = '';
      $('fpError').classList.add('hidden');
      openModal('forcePasswordModal');
      return;
    }
    await enterApp();
  } catch (err) {
    setLoginError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'دخول';
  }
}

async function submitForcePassword() {
  const oldPassword = $('fpOld').value;
  const newPassword = $('fpNew').value;
  const errEl = $('fpError');
  if (!oldPassword || !newPassword) {
    errEl.textContent = 'أكمل الحقول';
    errEl.classList.remove('hidden');
    return;
  }
  if (newPassword.length < 6) {
    errEl.textContent = 'كلمة المرور الجديدة قصيرة (6 أحرف على الأقل)';
    errEl.classList.remove('hidden');
    return;
  }
  if (newPassword !== $('fpNew2').value) {
    errEl.textContent = 'تأكيد كلمة المرور غير مطابق';
    errEl.classList.remove('hidden');
    return;
  }
  try {
    const res = await api('auth:changePassword', { oldPassword, newPassword });
    state.user = res.user;
    closeModal('forcePasswordModal');
    toast('تم تغيير كلمة المرور');
    await enterApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

/* رقم الإصدار ورقم البناء: في عنوان النافذة وشاشة الدخول */
/* اسم المتجر أعلى النافذة وفي عنوان الصفحة بدل «نقاط البيع» */
function applyBrandName() {
  const name = (state.settings && state.settings.storeName) || 'نقاط البيع';
  const el = $('brandName');
  if (el) el.textContent = name;
  document.title = `POS Pro — ${name} (${appVersionLabel()})`;
}

/* نافذة نتيجة التحديث بعد إعادة التشغيل (يكتبها سكربت التحديث، وتُتحقق من البناء العامل) */
function showUpdateResult(result) {
  if (!result) return;
  const modal = $('updateSuccessModal');
  if (!modal) return;
  const title = $('updateSuccessTitle');
  const detail = $('updateSuccessDetail');
  const extra = $('updateSuccessExtra');
  const icon = $('updateSuccessIcon');
  const setExtra = (text) => {
    if (!extra) return;
    extra.textContent = text || '';
    extra.classList.toggle('hidden', !text);
  };

  if (result.ok && result.verified !== false) {
    icon.textContent = '✅';
    title.className = 'font-extrabold text-lg text-emerald-700 mb-1';
    title.textContent = 'تم التحديث بنجاح';
    detail.textContent = [
      result.version ? `الإصدار: ${result.version}` : '',
      result.build ? `بناء ${result.build}` : '',
      'بياناتك وإعداداتك سليمة كما هي.'
    ].filter(Boolean).join(' — ');
    setExtra('');
  } else if (result.ok && result.verified === false) {
    /* التحديث استُبدل في مجلد، لكن النسخة التي تعمل الآن ليست هي المحدّثة */
    icon.textContent = '⚠️';
    title.className = 'font-extrabold text-lg text-amber-600 mb-1';
    title.textContent = 'التحديث طُبّق على نسخة أخرى';
    detail.textContent = 'لم تتغير هذه النسخة من البرنامج. ' + (result.reason || '');
    setExtra([
      `النسخة العاملة الآن: ${result.actualBuild || '—'} — المتوقع: ${result.expectBuild || '—'}`,
      `مسار البرنامج الذي يعمل: ${result.exePath || '—'}`,
      `مجلد الموارد الذي عُدّل: ${result.resourcesPath || '—'}`,
      '',
      'الحل: افتح POS Pro من نفس الاختصار الذي شغّلت منه التحديث، أو ثبّت ملف Setup الجديد لضمان نسخة واحدة محدّثة.'
    ].join('\n'));
  } else {
    icon.textContent = '❌';
    title.className = 'font-extrabold text-lg text-red-600 mb-1';
    title.textContent = 'تعذّر إكمال التحديث';
    detail.textContent = `تمّت استعادة النسخة السابقة تلقائيًا. السبب: ${result.error || 'غير معروف'}`;
    setExtra(result.log ? 'آخر السطور:\n' + result.log : '');
  }
  openModal('updateSuccessModal');
}

function applyAppVersion(info) {
  if (!info) return;
  state.info = info;
  state.appVersion = info.version || state.appVersion;
  const label = appVersionLabel();
  document.title = `POS Pro — نظام نقاط البيع (الإصدار ${label})`;
  const el = $('appVersion');
  if (el) el.textContent = `الإصدار ${label}`;
}

async function loadInitialData() {
  const [settings, categories, products] = await Promise.all([
    api('settings:get'),
    api('categories:list'),
    api('products:list')
  ]);
  state.settings = settings;
  state.categories = categories;
  state.products = products;
  applyBrandName();
  await renderDeliveryList();
}

function updateShiftBadge() {
  const badge = $('shiftBadge');
  if (!badge) return;
  if (state.shift) {
    badge.textContent = `وردية #${state.shift.id} — ${state.shift.cashier || ''}`;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

/* ------------------ استعادة الجلسة الذكية (اكتشاف الإغلاق القسري) ------------------
 * نضع علامة «الجلسة مفتوحة» عند الدخول ونمحوها عند الإغلاق أو الخروج النظيفين.
 * بقاء العلامة عند الإقلاع يعني انقطاعًا مفاجئًا (كهرباء / إعادة تشغيل قسري)،
 * وعندها نعرض نافذة استعادة السلة بدل الاستعادة الصامتة المعتادة.
 */
const SESSION_OPEN_KEY = 'pos_session_open';

function markSessionOpen() {
  if (!state.user) return;
  try {
    localStorage.setItem(SESSION_OPEN_KEY, JSON.stringify({
      at: Date.now(),
      user: state.user.username || '',
      shiftId: state.shift ? state.shift.id : null
    }));
  } catch { /* تخزين غير متاح — لا نُفشل الدخول */ }
}

function clearSessionOpen() {
  try { localStorage.removeItem(SESSION_OPEN_KEY); } catch { /* ignore */ }
}

function readSessionOpen() {
  try { return JSON.parse(localStorage.getItem(SESSION_OPEN_KEY) || 'null'); } catch { return null; }
}

/* نسخة احتياطية مضغوطة عند الخروج/إغلاق الوردية — مع منع التكرار داخل نافذة قصيرة */
let lastSessionBackupAt = 0;
async function runSessionBackup(reason) {
  if (!state.user) return;
  if (Date.now() - lastSessionBackupAt < 60 * 1000) return;
  try {
    const res = await api('backup:session', { reason });
    if (res && res.skipped) return;
    lastSessionBackupAt = Date.now();
    if (res && res.file) {
      const name = String(res.file).split(/[\\/]/).pop();
      notify('نسخة احتياطية عند الخروج', `تم إنشاء نسخة مضغوطة: ${name || 'pos-db'}`,
        { icon: '💾', type: 'success' });
    }
  } catch (err) {
    // فشل النسخ الاحتياطي لا يمنع الخروج، لكنه يظهر للمستخدم بدل أن يمرّ صامتًا
    console.error('session backup', err);
    notify('تعذّرت النسخة الاحتياطية', err && err.message ? err.message : 'خطأ غير معروف',
      { icon: '⚠️', type: 'error', duration: 9000 });
  }
}

async function enterApp() {
  /* اكتشاف الإغلاق القسري: نقرأ العلامة قبل إعادة تعيينها */
  const uncleanExit = !!readSessionOpen();
  $('loginScreen').classList.add('hidden');
  $('appScreen').classList.remove('hidden');
  $('userName').textContent = state.user.name;
  $('userRole').textContent = state.user.role === 'admin' ? 'مدير النظام' : 'كاشير';

  try {
    await loadInitialData();
  } catch (err) {
    showError(err);
  }

  // استعادة السلة المحفوظة من الجلسة السابقة (إغلاق مفاجئ أو إعادة تشغيل)
  try {
    await restoreCartDraft({ unclean: uncleanExit });
  } catch (err) {
    console.error('restore cart', err);
  }
  // الجلسة تعمل الآن: تبقى العلامة حتى يُغلق البرنامج أو يُسجَّل الخروج بشكل نظيف
  markSessionOpen();

  applyPermissions();
  applyProductSizes();
  applyLogo();
  renderCategories();
  renderProductGrid();
  renderCart();
  loadFavorites();
  await updateHoldsCount();
  updateShiftBadge();

  if (hasPerm('pos')) showView('pos');
  else if (hasPerm('reports')) showView('reports');
  else if (hasPerm('products')) showView('products');
  else showView('pos');

  if (!state.shift) {
    $('openingFloat').value = '0';
    openModal('shiftModal');
    setTimeout(() => $('openingFloat').select(), 100);
  }

  // إظهار تنبيه وجود فواتير معلقة فقط إذا كانت تخص المستخدم المسجل حاليًا
  // (لأن holds:list الآن يصفّر بالـ user_id، فالقائمة فارغة إن لم تكن هناك معلقة لهذا المستخدم)
  if (state.holds.length > 0) {
    setTimeout(() => toast(`لديك ${state.holds.length} فاتورة معلقة`, 'warn'), 1200);
  }
}

async function openShift() {
  const openingFloat = Number($('openingFloat').value) || 0;
  try {
    const shift = await api('shift:open', { openingFloat });
    state.shift = shift;
    closeModal('shiftModal');
    markSessionOpen();
    updateShiftBadge();
    toast(`تم فتح الوردية #${shift.id}`);
    // نافذة استعادة الجلسة كانت مؤجلة حتى تُفتح الوردية — تظهر الآن
    setTimeout(maybePromptRecovery, 300);
  } catch (err) { showError(err); }
}

/** ملاحظات موحّدة عن العمل غير المنتهي — تُستخدم في رسالتي الخروج والإغلاق. */
function pendingSessionNotes() {
  const count = state.cart.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
  const notes = [];
  if (count > 0) notes.push(`لديك ${count} صنف في السلة الحالية (سيتم حفظها تلقائيًا).`);
  if (state.holds.length > 0) notes.push(`لديك ${state.holds.length} فاتورة معلقة.`);
  if (state.user && state.shift) notes.push(`الوردية #${state.shift.id} ستبقى مفتوحة.`);
  return { count, notes };
}

async function handleLogoutClick() {
  const { count, notes } = pendingSessionNotes();
  if (count > 0 || state.holds.length > 0) {
    const ok = await askConfirm('تسجيل الخروج', ['هل تريد تسجيل الخروج؟', ...notes].join('\n'), 'warn', {
      ok: 'تسجيل الخروج', cancel: 'متابعة العمل'
    });
    if (!ok) return;
  }
  openModal('logoutModal');
}

/**
 * نافذة تأكيد إغلاق البرنامج — تصميم البرنامج نفسه (لا نافذة ويندوز الافتراضية).
 * تُعرض دائمًا: حتى لو كانت السلة فارغة، وتوضح حالة السلة/الوردية بنفس صيغة رسالة الخروج.
 * تُستدعى من العملية الرئيسية عبر executeJavaScript وتُعيد true/false.
 */
async function confirmCloseApp() {
  // لا نفتح فوق تأكيد آخر مفتوح: نُغلقه كإلغاء حتى لا يبقى معلّقًا
  if (!$('customConfirmModal').classList.contains('hidden')) closeConfirm(false);
  const { notes } = pendingSessionNotes();
  const lines = ['هل تريد إغلاق البرنامج؟'];
  if (state.user) lines.push(...notes);
  else lines.push('لن يتم فقدان أي بيانات محفوظة.');
  const ok = await askConfirm('إغلاق البرنامج', lines.join('\n'), 'danger', {
    ok: 'إغلاق البرنامج', cancel: 'متابعة العمل'
  });
  // إغلاق نظيف مؤكد: نزيل علامة الجلسة حتى لا يُطلب استعادة السلة عند الإقلاع التالي
  if (ok) clearSessionOpen();
  return ok;
}
window.confirmCloseApp = confirmCloseApp;

async function doLogout(skipRequest) {
  closeModal('logoutModal');
  closeModal('closeShiftModal');
  if (!skipRequest) {
    try { await api('auth:logout'); } catch { /* ignore */ }
  }
  // خروج نظيف: لا داعي لعرض نافذة استعادة الجلسة في الدخول التالي
  clearSessionOpen();
  // نسخة احتياطية مضغوطة في لحظة الخروج (تغطي أيضًا مسار إغلاق الوردية)
  await runSessionBackup('logout');
  // إعادة 상태가 الجلسة المحلي كاملًا — بما فيها الفواتير المعلقة
  resetClientState();
  showLogin();
}

/* ------------------------------ التنقل ------------------------------ */
function bindNavigation() {
  $$('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const perm = btn.dataset.perm;
      if (perm && !hasPerm(perm)) return toast('لا تملك صلاحية هذه الشاشة', 'error');
      showView(btn.dataset.view);
    });
  });
}

/* ------------------------------ الإقلاع ------------------------------ */
function bindGlobalUi() {
  bind('loginForm', 'submit', handleLoginSubmit);
  bind('toggleLoginPass', 'click', () => {
    const field = $('loginPass');
    const btn = $('toggleLoginPass');
    if (field.type === 'password') { field.type = 'text'; btn.textContent = '🔒'; }
    else { field.type = 'password'; btn.textContent = '👁️'; }
  });
  bind('fpSubmit', 'click', submitForcePassword);
  bind('confirmOpenShift', 'click', openShift);
  bind('openingFloat', 'keydown', (e) => { if (e.key === 'Enter') openShift(); });

  // إشعارات العملية الرئيسية (النسخة الاحتياطية التلقائية)
  if (window.pos && typeof window.pos.onEvent === 'function') {
    window.pos.onEvent((event) => {
      if (!event || event.type !== 'backup') return;
      const name = String(event.file || '').split(/[\\/]/).pop();
      notify('نسخة احتياطية تلقائية', `تم إنشاء النسخة: ${name || 'pos-backup'} — ${fmtTime(event.at || Date.now())}`, { icon: '💾' });
    });
  }
  bind('updateSuccessCloseBtn', 'click', () => closeModal('updateSuccessModal'));

  bind('confirmModalOk', 'click', () => closeConfirm(true));
  bind('confirmModalCancel', 'click', () => closeConfirm(false));
  bind('promptModalOk', 'click', () => closePrompt($('promptModalInput').value));
  bind('promptModalCancel', 'click', () => closePrompt(null));
  bind('promptModalInput', 'keydown', (e) => {
    if (e.key === 'Enter') closePrompt($('promptModalInput').value);
    if (e.key === 'Escape') closePrompt(null);
  });

  bind('logoutBtn', 'click', handleLogoutClick);
  bind('btnNormalLogout', 'click', () => doLogout(false));
  bind('btnLogoutAndCloseShift', 'click', () => {
    closeModal('logoutModal');
    openCloseShiftModal();
  });
  bind('btnCancelLogout', 'click', () => closeModal('logoutModal'));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('forcePasswordModal').classList.contains('hidden')) return;
    ['paymentModal', 'productModal', 'categoriesModal', 'holdOrderModal', 'holdsModal',
      'holdDetailsModal', 'invoiceActionModal', 'cancelInvoiceModal', 'expenseModal',
      'treasuryModal', 'userModal', 'calculatorModal', 'printPreviewModal', 'closeShiftModal',
      'materialsModal',
      'variantPickModal', 'optionPickModal',
      'logoutModal', 'customConfirmModal', 'customPromptModal', 'dangerModal'].forEach((id) => {
      // تأكيد الإغلاق/الخروج يجب أن يُحلّ بالرفض حتى لا يبقى البرنامج عالقًا
      if (id === 'customConfirmModal') closeConfirm(false);
      else if (id === 'variantPickModal' || id === 'optionPickModal') cancelProductFlow();
      else closeModal(id);
    });
  });

  window.addEventListener('error', (event) => {
    console.error('Unhandled error:', event.error || event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled rejection:', event.reason);
  });
}

/** إعدادات المتجر (الشعار والاسم) تُقرأ قبل الدخول حتى يظهر الشعار في شاشة الدخول بعد إعادة التشغيل. */
async function loadLoginBranding() {
  try {
    const settings = await api('settings:get');
    if (settings) state.settings = settings;
  } catch (err) {
    console.error('settings load', err);
  }
  applyBrandName();
  applyLogo();
}

async function boot() {
  bindGlobalUi();
  bindNavigation();
  bindPosEvents();
  bindProductEvents();
  bindReportEvents();
  bindTreasuryEvents();
  bindInvoiceEvents();
  bindReturnEvents();
  bindUserEvents();
  bindSettingsEvents();
  bindCalcEvents();

  try {
    const info = await api('app:info');
    applyAppVersion(info);
    $('firstRunHint').classList.toggle('hidden', !info.firstRunAccounts);
    if (info.updateResult) setTimeout(() => showUpdateResult(info.updateResult), 900);
  } catch (err) {
    setLoginError('تعذّر تشغيل الواجهة: ' + err.message);
  }

  await loadLoginBranding();
  showLogin();
}

document.addEventListener('DOMContentLoaded', boot);
