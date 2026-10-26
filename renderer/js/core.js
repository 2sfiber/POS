'use strict';
/* ============================================================
   أدوات مشتركة: الحالة، التهريب الآمن للنصوص، التنبيهات، النداءات
   ============================================================ */

const $ = (id) => document.getElementById(id);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const PAY_LABELS = { cash: 'كاش', bank: 'تحويل', credit: 'آجل' };

const state = {
  user: null,
  shift: null,
  settings: {},
  products: [],
  categories: [],
  materials: [],
  users: [],
  cart: [],
  discountType: 'fixed',
  discountValue: 0,
  paymentMethod: 'cash',
  customer: null,
  selectedCategory: 'الكل',
  lastInvoice: null,
  printing: false,
  holds: [],
  editingProductId: null,
  editingUserId: null,
  editingProductImage: '',
  selectedInvoiceId: null,
  selectedHoldId: null,
  shiftSummary: null,
  info: {},
  appVersion: '2.0.0',
  delivery: [],
  printers: []
};

/* ---------- أمان النصوص: يمنع أي HTML مُحقون من بيانات المستخدم ---------- */
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"'`]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]
  ));
}

/* ---------- أرقام وتواريخ ---------- */
function money(n) {
  const v = Number(n);
  return (Number.isFinite(v) ? v : 0).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}
/**
 * رقم مختصر لتفاصيل الأصناف والأسعار الفردية: يُخفي الكسور الصفرية (.00)
 * ويُبقي القروش عند وجودها. الإجماليات والخصومات والتقارير تستخدم money().
 */
function moneyShort(n) {
  const v = Number(n);
  return (Number.isFinite(v) ? v : 0).toLocaleString('en-US', {
    minimumFractionDigits: 0, maximumFractionDigits: 2
  });
}
function round2(n) {
  const v = Number(n) || 0;
  return Math.round((v + Number.EPSILON) * 100) / 100;
}
function currency() {
  return state.settings.currency || 'ر.ي';
}

/* رقم الإصدار مع رقم البناء: "2.0.0 — بناء b002" */
function appVersionLabel() {
  const info = state.info || {};
  const version = info.version || state.appVersion || '';
  return info.build ? `${version} — بناء ${info.build}` : String(version);
}

/* عرض ورق الطابعة الحرارية بالمليمتر (يدعم 58/76/80 وأي مقاس مخصص) */
function paperWidthMm() {
  const w = Number(state.settings.printerWidth);
  return Number.isFinite(w) && w >= 40 && w <= 112 ? w : 80;
}
function moneyCur(n) {
  return `${money(n)} ${currency()}`;
}
function fmtDate(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleDateString('en-GB');
}
function fmtTime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function fmtDateTime(ts) {
  if (!ts) return '-';
  return `${fmtDate(ts)} ${fmtTime(ts)}`;
}
function todayStr(d) {
  const date = d ? new Date(d) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function dayRange(fromStr, toStr) {
  const from = fromStr ? new Date(`${fromStr}T00:00:00`).getTime() : 0;
  const to = toStr ? new Date(`${toStr}T23:59:59.999`).getTime() : Date.now();
  return { from, to };
}

/* ---------- التنبيهات ---------- */
function toast(message, type = 'success') {
  const el = $('toast');
  if (!el) return;
  el.textContent = String(message == null ? '' : message);
  el.className = 'fixed bottom-5 left-1/2 z-[100] px-4 py-2 rounded-xl shadow-2xl font-bold text-white toast-anim text-sm max-w-[90vw] text-center ' +
    (type === 'error' ? 'bg-red-600' : type === 'warn' ? 'bg-amber-500' : 'bg-emerald-600');
  el.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.add('hidden'), type === 'error' ? 5000 : 3000);
}

/* ---------- إشعارات منبثقة (بطاقة علوية) — للنسخ التلقائي وغيره ---------- */
function notify(title, message, opts = {}) {
  const stack = $('noticeStack');
  if (!stack) return;
  const card = document.createElement('div');
  const tone = opts.type === 'error' ? 'border-red-200 bg-red-50'
    : opts.type === 'warn' ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50';
  card.className = `pointer-events-auto w-[320px] max-w-[92vw] flex items-start gap-2 rounded-xl border-2 ${tone} bg-white shadow-2xl p-2.5 notice-anim`;
  card.innerHTML = `
    <div class="w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center text-sm shrink-0">${esc(opts.icon || '🔔')}</div>
    <div class="flex-1 min-w-0 text-right">
      <div class="font-extrabold text-xs text-slate-800">${esc(title)}</div>
      <div class="text-[11px] text-slate-600 leading-snug break-words">${esc(message)}</div>
    </div>
    <button class="text-slate-400 hover:text-slate-700 text-lg leading-none px-1" aria-label="إغلاق">&times;</button>`;
  const close = () => { card.remove(); };
  card.querySelector('button').addEventListener('click', close);
  stack.appendChild(card);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  setTimeout(close, Number(opts.duration) || 6000);
}

let confirmResolver = null;
function askConfirm(title, message, type = 'danger', labels = {}) {
  $('confirmModalTitle').textContent = title;
  $('confirmModalMessage').textContent = message;
  $('confirmModalIcon').textContent = type === 'danger' ? '⚠️' : '❓';
  $('confirmModalOk').className = type === 'danger'
    ? 'bg-red-600 text-white py-2 rounded-lg font-bold text-sm'
    : 'bg-emerald-600 text-white py-2 rounded-lg font-bold text-sm';
  // نصوص الأزرار تُخصّص عند الحاجة (مثل «إغلاق البرنامج») وتعود للافتراضي في بقية التأكيدات
  $('confirmModalOk').textContent = labels.ok || 'تأكيد';
  $('confirmModalCancel').textContent = labels.cancel || 'إلغاء';
  $('customConfirmModal').classList.remove('hidden');
  return new Promise((resolve) => { confirmResolver = resolve; });
}
function closeConfirm(value) {
  $('customConfirmModal').classList.add('hidden');
  if (confirmResolver) { const r = confirmResolver; confirmResolver = null; r(value); }
}

/* ---------- تأكيد الإجراءات الخطيرة (تصفير/حذف) ---------- */
let dangerResolver = null;
let dangerAction = null;

function dangerError(message) {
  const el = $('dangerError');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

/**
 * askDanger({ title, lines, phrase, confirmText, action })
 * action: async ({ password, typed }) => value — تُنفّذ داخل النافذة، وأي خطأ يظهر فيها.
 */
function askDanger(opts = {}) {
  const modal = $('dangerModal');
  if (!modal) return Promise.resolve(null);
  $('dangerTitle').textContent = opts.title || 'تأكيد';
  $('dangerLines').innerHTML = (opts.lines || []).map((line) => `<div>${line}</div>`).join('');
  const needPhrase = !!opts.phrase;
  $('dangerPhraseBox').classList.toggle('hidden', !needPhrase);
  $('dangerPhraseLabel').textContent = needPhrase ? `اكتب «${opts.phrase}» للتأكيد` : '';
  $('dangerPhrase').value = '';
  $('dangerPassword').value = '';
  dangerError('');
  $('dangerConfirm').textContent = opts.confirmText || 'تأكيد';
  dangerAction = opts.action || null;
  modal.classList.remove('hidden');
  setTimeout(() => $('dangerPassword').focus(), 60);
  return new Promise((resolve) => { dangerResolver = resolve; });
}

function closeDanger(value) {
  const modal = $('dangerModal');
  if (modal) modal.classList.add('hidden');
  dangerAction = null;
  const resolve = dangerResolver;
  dangerResolver = null;
  if (resolve) resolve(value || null);
}

async function submitDanger() {
  const password = $('dangerPassword').value;
  const typed = $('dangerPhrase').value.trim();
  const phraseLabel = $('dangerPhraseLabel').textContent;
  const expected = phraseLabel.replace(/^اكتب «|» للتأكيد$/g, '');
  if (!$('dangerPhraseBox').classList.contains('hidden') && typed !== expected) {
    return dangerError(`اكتب «${expected}» بالضبط للتأكيد`);
  }
  if (!password) return dangerError('أدخل كلمة مرور المدير');
  if (!dangerAction) return dangerError('لا يوجد إجراء');
  const button = $('dangerConfirm');
  button.disabled = true;
  dangerError('');
  try {
    const out = await dangerAction({ password, typed });
    closeDanger(out || true);
  } catch (err) {
    dangerError(err && err.message ? err.message : 'فشل الإجراء');
  } finally {
    button.disabled = false;
  }
}

let promptResolver = null;
function askPrompt(title, message, defaultValue = '') {
  $('promptModalTitle').textContent = title;
  $('promptModalMessage').textContent = message;
  $('promptModalInput').value = defaultValue;
  $('customPromptModal').classList.remove('hidden');
  setTimeout(() => $('promptModalInput').focus(), 30);
  return new Promise((resolve) => { promptResolver = resolve; });
}
function closePrompt(value) {
  $('customPromptModal').classList.add('hidden');
  if (promptResolver) { const r = promptResolver; promptResolver = null; r(value); }
}

/* ---------- الاتصال بالعملية الرئيسية ---------- */
async function api(channel, payload) {
  if (!window.pos || typeof window.pos.call !== 'function') {
    throw new Error('جسر التطبيق غير متاح. شغّل البرنامج من ملف التشغيل وليس من المتصفح.');
  }
  const res = await window.pos.call(channel, payload || {});
  if (!res || res.ok !== true) throw new Error((res && res.error) || 'حدث خطأ غير معروف');
  return res.data;
}
function showError(err) {
  console.error(err);
  toast(err && err.message ? err.message : 'حدث خطأ', 'error');
}
async function guard(fn, options = {}) {
  try {
    return await fn();
  } catch (err) {
    if (!options.silent) showError(err);
    return undefined;
  }
}

/* ---------- الصلاحيات (تُفرض أيضًا في العملية الرئيسية) ---------- */
function hasPerm(perm) {
  if (!state.user) return false;
  if (state.user.role === 'admin') return true;
  return !!(state.user.permissions && state.user.permissions[perm]);
}
function applyPermissions() {
  $$('[data-perm]').forEach((el) => {
    const perm = el.dataset.perm;
    if (perm && !hasPerm(perm)) el.classList.add('hidden');
    else el.classList.remove('hidden');
  });

  const discountFields = [$('cartDiscountType'), $('cartDiscount')];
  discountFields.forEach((el) => {
    if (!el) return;
    const allowed = hasPerm('apply_discount');
    el.disabled = !allowed;
    el.classList.toggle('bg-slate-200', !allowed);
    el.title = allowed ? '' : 'لا تملك صلاحية الخصم';
  });
  if (!hasPerm('apply_discount')) {
    state.discountValue = 0;
    if ($('cartDiscount')) $('cartDiscount').value = 0;
  }
  $$('.perm-staff').forEach((el) => el.classList.toggle('hidden', !hasPerm('treasury')));
}

/* ---------- أدوات واجهة ---------- */
function bind(id, event, fn) {
  const el = $(id);
  if (el) el.addEventListener(event, fn);
}
function onClick(id, fn) { bind(id, 'click', fn); }
function openModal(id) {
  const el = $(id);
  if (el) el.classList.remove('hidden');
}
function closeModal(id) {
  const el = $(id);
  if (el) el.classList.add('hidden');
}
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
function showView(name) {
  $$('[id^="view-"]').forEach((el) => el.classList.add('hidden'));
  const target = $('view-' + name);
  if (target) {
    target.classList.remove('hidden');
    if (name === 'pos') target.classList.add('flex');
  }
  $$('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));

  if (name === 'products') renderProductsTable();
  if (name === 'reports') initReports();
  if (name === 'treasury') renderTreasury();
  if (name === 'invoices') renderInvoices();
  if (name === 'returns') renderReturnsView();
  if (name === 'settings') renderSettings();
  if (name === 'users') loadUsers();
}

/* ---------- حماية حقول كلمات المرور من النسخ أو التحديد ---------- */
function protectSecretFields() {
  // نضع علامة دائمة (data-secret) حتى لو كشف المستخدم كلمة المرور مؤقتًا بزر العين
  const mark = (el) => { if (el && el.matches && el.matches('input[type="password"]')) el.dataset.secret = '1'; };
  $$('input[type="password"]').forEach(mark);
  const isSecret = (el) => !!(el && el.closest && (el.type === 'password' || el.dataset.secret === '1'));
  ['copy', 'cut'].forEach((eventName) => {
    document.addEventListener(eventName, (event) => {
      if (!isSecret(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      toast('لا يمكن نسخ كلمة المرور', 'warn');
    }, true);
  });
  document.addEventListener('contextmenu', (event) => {
    if (isSecret(event.target)) event.preventDefault();
  }, true);
  document.addEventListener('dragstart', (event) => {
    if (isSecret(event.target)) event.preventDefault();
  }, true);
}
document.addEventListener('DOMContentLoaded', () => {
  protectSecretFields();
  // أي حقل كلمة مرور يُضاف لاحقًا (نوافذ ديناميكية) يُعلَّم تلقائيًا
  document.addEventListener('focusin', (event) => {
    if (event.target && event.target.matches && event.target.matches('input[type="password"]')) {
      event.target.dataset.secret = '1';
    }
  }, true);
});

/* ---------- مساعدة الصور: تصغير وتحويل إلى data URL (بدل Blob) ---------- */
function resizeImageFile(file, maxSize = 600, quality = 0.85, square = false) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error('الملف ليس صورة'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('تعذّر قراءة الملف'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('صورة غير صالحة'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (square) {
          // قصّ مربّع من منتصف الصورة ثم تصغيرها إلى مقاس موحّد: تظهر كل صور
          // الأصناف بنفس النسبة في شاشة الكاشير بلا تمدّد أو تشويه.
          const side = Math.min(img.width, img.height);
          const sx = (img.width - side) / 2;
          const sy = (img.height - side) / 2;
          const out = Math.min(maxSize, Math.max(120, side));
          canvas.width = out;
          canvas.height = out;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, out, out);
          ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out);
        } else {
          const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          canvas.width = w;
          canvas.height = h;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
        }
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
