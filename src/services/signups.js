// دورة حياة طلب تسجيل ذاتي قبل ما يصير عميل فعلي: pending_email_verification → verified → completed.
// ملف JSON واحد لكل طلب بـ data/signups/<pendingId>.json — نفس فلسفة appointments.js/customers.js.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const apiKeys = require("./apiKeys"); // hashKey — نفس منطق التشفير المُستخدم لمفاتيح API

const SIGNUPS_DIR = path.join(__dirname, "..", "..", "data", "signups");
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const SIGNUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_KNOWLEDGE_ATTEMPTS = 5;

function ensureDir() {
  fs.mkdirSync(SIGNUPS_DIR, { recursive: true });
}

function recordPath(pendingId) {
  return path.join(SIGNUPS_DIR, `${pendingId}.json`);
}

function generateToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function saveRecord(record) {
  ensureDir();
  fs.writeFileSync(recordPath(record.pendingId), JSON.stringify(record, null, 2), "utf8");
}

function createPending({ companyName, contactEmail, notifyWhatsapp, escalationPhone, websiteUrl }) {
  const pendingId = crypto.randomBytes(12).toString("hex");
  const verifyToken = generateToken();

  const record = {
    pendingId,
    companyName,
    contactEmail,
    notifyWhatsapp,
    escalationPhone,
    websiteUrl,
    status: "pending_email_verification",
    verifyTokenHash: apiKeys.hashKey(verifyToken),
    verifyTokenExpiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_MS).toISOString(),
    signupTokenHash: null,
    signupTokenExpiresAt: null,
    clientId: null, // بينحط بعد أول استيراد معرفة ناجح (POST /signup/knowledge)
    publicKey: null,
    knowledgeAttempts: 0,
    createdAt: new Date().toISOString(),
  };

  saveRecord(record);
  return { pendingId, verifyToken };
}

function getPending(pendingId) {
  const file = recordPath(pendingId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function verifyEmail(pendingId, rawToken) {
  const record = getPending(pendingId);
  if (!record) throw new Error("طلب تسجيل غير موجود");
  if (record.status !== "pending_email_verification") throw new Error("هالطلب اتأكد مسبقًا أو خلص");
  if (new Date(record.verifyTokenExpiresAt).getTime() < Date.now()) throw new Error("رابط التحقق منتهي الصلاحية");
  if (apiKeys.hashKey(rawToken) !== record.verifyTokenHash) throw new Error("رابط تحقق غير صحيح");

  const signupToken = generateToken();
  record.status = "verified";
  record.signupTokenHash = apiKeys.hashKey(signupToken);
  record.signupTokenExpiresAt = new Date(Date.now() + SIGNUP_TOKEN_TTL_MS).toISOString();
  saveRecord(record);

  return { pendingId, signupToken };
}

// مسح مباشر لملفات data/signups — مقبول بحجم الاستخدام المتوقع (تسجيل ذاتي، معدل منخفض)،
// وأبسط بكتير من فهرسة إضافية لهاي المرحلة.
function getPendingBySignupToken(rawToken) {
  ensureDir();
  const hash = apiKeys.hashKey(rawToken);

  for (const file of fs.readdirSync(SIGNUPS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const record = JSON.parse(fs.readFileSync(path.join(SIGNUPS_DIR, file), "utf8"));
    if (record.signupTokenHash !== hash) continue;
    if (record.status === "completed") return null;
    if (new Date(record.signupTokenExpiresAt).getTime() < Date.now()) return null;
    return record;
  }
  return null;
}

function incrementKnowledgeAttempts(pendingId) {
  const record = getPending(pendingId);
  record.knowledgeAttempts += 1;
  saveRecord(record);
  return record.knowledgeAttempts;
}

function attachClient(pendingId, clientId, publicKey) {
  const record = getPending(pendingId);
  record.clientId = clientId;
  record.publicKey = publicKey;
  saveRecord(record);
  return record;
}

function markCompleted(pendingId) {
  const record = getPending(pendingId);
  record.status = "completed";
  saveRecord(record);
  return record;
}

// هل إيميل معيّن عنده طلب لسا شغال (مو completed، مو منتهي الصلاحية)؟ يمنع تسجيلات متكررة
// لنفس الإيميل بالتوازي.
function hasActivePendingForEmail(email) {
  ensureDir();
  const normalized = String(email).trim().toLowerCase();

  for (const file of fs.readdirSync(SIGNUPS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const record = JSON.parse(fs.readFileSync(path.join(SIGNUPS_DIR, file), "utf8"));
    if (record.contactEmail?.toLowerCase() !== normalized) continue;
    if (record.status === "completed") continue;

    const expiry = record.signupTokenExpiresAt || record.verifyTokenExpiresAt;
    if (new Date(expiry).getTime() < Date.now()) continue;

    return true;
  }
  return false;
}

module.exports = {
  createPending,
  getPending,
  verifyEmail,
  getPendingBySignupToken,
  incrementKnowledgeAttempts,
  attachClient,
  markCompleted,
  hasActivePendingForEmail,
  MAX_KNOWLEDGE_ATTEMPTS,
};
