'use strict';
/**
 * جسر آمن: لا يوجد أي وصول لـ Node أو الملفات من الواجهة.
 * كل القنوات تمر عبر قائمة بيضاء في العملية الرئيسية (pos:invoke).
 * الطباعة كلها تُنفَّذ في العملية الرئيسية عبر قناة print:receipt
 * (ESC/POS مباشر أو تعريف ويندوز) — لا نافذة تأكيد من ويندوز.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pos', {
  call(channel, payload) {
    return ipcRenderer.invoke('pos:invoke', String(channel), payload);
  },
  /* أحداث دفع من العملية الرئيسية (مثل إشعار النسخة الاحتياطية التلقائية) */
  onEvent(handler) {
    if (typeof handler !== 'function') return;
    ipcRenderer.on('pos:event', (_event, payload) => handler(payload));
  },
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome
  }
});
