// مصادقة بسيطة لمشغّل وحيد — كلمة سر وحدة (ADMIN_PASSWORD بـ.env) + جلسات بالميموري
// (كافي لأنه سيرفر وحيد بدون تعدد instances). rate limiting على تسجيل الدخول قرار مجلس LLM
// صريح (2026-08-09): بدون هيك، صفحة /admin نفسها — المدخل الوحيد لكل بيانات كل العملاء —
// بتصير هدف brute-force سهل.

const crypto = require("crypto");
const config = require("../config");

const sessions = new Map(); // token -> expiresAt
const failedAttempts = new Map(); // ip -> { count, lockedUntil }

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function isLocked(ip) {
  const entry = failedAttempts.get(ip);
  if (!entry?.lockedUntil) return false;
  if (entry.lockedUntil <= Date.now()) {
    failedAttempts.delete(ip);
    return false;
  }
  return true;
}

function recordFailure(ip) {
  const entry = failedAttempts.get(ip) || { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  failedAttempts.set(ip, entry);
}

function recordSuccess(ip) {
  failedAttempts.delete(ip);
}

// مقارنة بزمن ثابت (timingSafeEqual) حتى ما يصير سطح هجوم توقيت على كلمة السر —
// نفس المبدأ المطبّق أصلاً بـapiKeys.js لمقارنة الـhash.
function checkPassword(rawPassword) {
  if (!config.admin.password || typeof rawPassword !== "string") return false;
  const a = Buffer.from(rawPassword);
  const b = Buffer.from(config.admin.password);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + config.admin.sessionTtlHours * 60 * 60 * 1000);
  return token;
}

function validateSession(token) {
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function destroySession(token) {
  sessions.delete(token);
}

module.exports = {
  isLocked,
  recordFailure,
  recordSuccess,
  checkPassword,
  createSession,
  validateSession,
  destroySession,
};
