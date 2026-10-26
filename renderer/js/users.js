'use strict';
/* ============================================================
   المستخدمون والصلاحيات
   ============================================================ */

const PERM_FIELDS = [
  'pos', 'products', 'reports', 'treasury', 'invoices',
  'users', 'settings', 'apply_discount', 'cancel_invoice'
];

async function loadUsers() {
  try {
    state.users = await api('users:list');
    renderUsers();
  } catch (err) { showError(err); }
}

function renderUsers() {
  const list = $('usersList');
  if (!list) return;
  if (!state.users.length) {
    list.innerHTML = '<div class="text-center text-slate-500 py-4 font-bold">لا يوجد مستخدمون</div>';
    return;
  }
  list.innerHTML = state.users.map((u) => `
    <div class="flex justify-between items-center bg-slate-50 p-3 rounded-lg border text-sm">
      <div class="min-w-0">
        <span class="font-bold text-base">${esc(u.name)}</span>
        <span class="text-slate-500 text-xs">(${esc(u.username)})</span>
        <span class="text-[10px] ${u.role === 'admin' ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'} px-2 py-0.5 rounded mr-2 font-bold">
          ${u.role === 'admin' ? 'مدير' : 'كاشير'}</span>
        ${u.mustChangePassword ? '<span class="text-[10px] bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-bold mr-1">لم يغيّر كلمة المرور</span>' : ''}
      </div>
      <div class="flex gap-2 shrink-0">
        <button data-edituser="${esc(u.username)}" class="bg-blue-100 text-blue-700 hover:bg-blue-200 px-3 py-1.5 rounded font-bold text-xs">تعديل</button>
        <button data-deluser="${esc(u.username)}" class="bg-red-100 text-red-700 hover:bg-red-200 px-3 py-1.5 rounded font-bold text-xs ${u.username === 'admin' ? 'opacity-40 cursor-not-allowed' : ''}"
          ${u.username === 'admin' ? 'disabled' : ''}>حذف</button>
      </div>
    </div>`).join('');
}

function openUserModal(user) {
  state.editingUserId = user ? user.username : null;
  $('userModalTitle').textContent = user ? 'تعديل بيانات المستخدم' : 'إضافة مستخدم جديد';
  $('uUsername').value = user ? user.username : '';
  $('uUsername').disabled = !!user;
  $('uPassword').value = '';
  $('uName').value = user ? user.name : '';
  $('uRole').value = user ? user.role : 'cashier';
  const perms = user ? (user.permissions || {}) : {};
  PERM_FIELDS.forEach((field) => {
    const el = $('perm_' + field);
    if (!el) return;
    el.checked = user ? !!perms[field] : field === 'pos';
  });
  openModal('userModal');
}

async function saveUser() {
  const username = $('uUsername').value.trim().toLowerCase();
  const password = $('uPassword').value;
  const name = $('uName').value.trim();
  if (!username || !name) return toast('أكمل الحقول المطلوبة', 'warn');
  if (!state.editingUserId && !password) return toast('كلمة المرور مطلوبة للمستخدم الجديد', 'warn');
  if (password && password.length < 6) return toast('كلمة المرور يجب أن تكون 6 أحرف على الأقل', 'warn');
  const permissions = {};
  PERM_FIELDS.forEach((field) => { permissions[field] = !!$('perm_' + field).checked; });
  try {
    await api('users:save', {
      username: state.editingUserId || username,
      password: password || undefined,
      name,
      role: $('uRole').value,
      permissions
    });
    closeModal('userModal');
    state.editingUserId = null;
    await loadUsers();
    toast('تم حفظ المستخدم');
  } catch (err) { showError(err); }
}

async function deleteUser(username) {
  if (username === 'admin') return;
  if (!(await askConfirm('حذف مستخدم', `حذف المستخدم "${username}"؟`))) return;
  try {
    await api('users:delete', { username });
    await loadUsers();
    toast('تم حذف المستخدم');
  } catch (err) { showError(err); }
}

function bindUserEvents() {
  bind('addUserBtn', 'click', () => openUserModal(null));
  bind('cancelUser', 'click', () => closeModal('userModal'));
  bind('saveUser', 'click', saveUser);
  bind('usersList', 'click', (e) => {
    const edit = e.target.closest('[data-edituser]');
    if (edit) {
      const user = state.users.find((u) => u.username === edit.dataset.edituser);
      if (user) openUserModal(user);
      return;
    }
    const del = e.target.closest('[data-deluser]');
    if (del) deleteUser(del.dataset.deluser);
  });
}
