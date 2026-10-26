'use strict';
/**
 * معلومات البناء (رقم الإصدار + رقم البناء).
 *
 * رقم البناء يُكتب في ملف `resources/build.json` داخل مجلد الحزمة عند كل
 * عملية ضغط (scripts/pack-zip.js)، لذلك يُظهر البرنامج رقم النسخة الفعلي
 * الذي يعمل عليه المستخدم — حتى مع تشابه أسماء الملفات.
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * readBuildInfo(resourcesPath, fallbackVersion)
 * → { version, build, number, date }
 * في وضع التطوير (بدون build.json) يُرجع رقم الإصدار فقط وبلا رقم بناء.
 */
function readBuildInfo(resourcesPath, fallbackVersion = '') {
  const info = { version: String(fallbackVersion || ''), build: '', number: 0, date: '' };
  if (!resourcesPath) return info;
  try {
    const file = path.join(String(resourcesPath), 'build.json');
    if (!fs.existsSync(file)) return info;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data.version) info.version = String(data.version);
    if (data && data.build) info.build = String(data.build);
    if (data && Number.isFinite(Number(data.number))) info.number = Number(data.number);
    if (data && data.date) info.date = String(data.date);
  } catch {
    /* ملف مفقود أو تالف: نكتفي برقم الإصدار من package.json */
  }
  return info;
}

module.exports = { readBuildInfo };
