'use strict';
/**
 * تشفير كلمات المرور - PBKDF2-SHA256
 * لا تُخزَّن أي كلمة مرور كنص صريح في قاعدة البيانات أو النسخ الاحتياطية.
 */
const crypto = require('node:crypto');

const ITERATIONS = 210000;
const KEYLEN = 32;
const DIGEST = 'sha256';

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(String(plain), salt, ITERATIONS, KEYLEN, DIGEST);
  return `pbkdf2$${ITERATIONS}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;
  const salt = Buffer.from(parts[2], 'base64');
  const expected = Buffer.from(parts[3], 'base64');
  const actual = crypto.pbkdf2Sync(String(plain), salt, iterations, expected.length, DIGEST);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function randomPassword(length = 8) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

module.exports = { hashPassword, verifyPassword, randomPassword };
