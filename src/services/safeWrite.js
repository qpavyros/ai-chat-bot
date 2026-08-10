// طبقة كتابة آمنة وحيدة تُستخدم من كل endpoints لوحة تحكم المشغّل (/admin) — قرار مجلس LLM
// (2026-08-09، راجع council-transcript-20260809-140000.md): أي كتابة على ملفات عميل من الداشبورد
// لازم تمر من هون، ولا مكان تاني يستخدم fs.writeFileSync مباشرة على ملفات عميل. أربع حمايات
// بمكان واحد: منع path traversal، قفل بالميموري لكل عميل (يمنع تصادم كتابة الداشبورد مع كتابة
// البوت الحيّة لنفس اللحظة)، نسخة احتياطية قبل كل كتابة، وكتابة ذرّية (temp ثم rename).

const fs = require("fs");
const path = require("path");

const CLIENTS_DIR = path.join(__dirname, "..", "clients");
const CLIENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

const locks = new Map(); // clientId -> Promise (سلسلة الكتابات المعلّقة لهالعميل)

function listClientIds() {
  return fs
    .readdirSync(CLIENTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);
}

// أسماء عميل لازم تطابق هالنمط بس (بدون /, .., مسافات) — نفس شرط provisioning.js للـslug،
// مطبّق هون كمان لأنه أي endpoint إداري بيقبل clientId من الطلب لازم يتحقق منه بشكل مستقل.
function assertValidClientId(clientId) {
  if (typeof clientId !== "string" || !CLIENT_ID_PATTERN.test(clientId)) {
    throw new Error(`معرّف عميل غير صالح: "${clientId}"`);
  }
}

// يرجّع مسار مجلد العميل، بعد ما يتأكد إنه فعليًا جوا CLIENTS_DIR (حماية إضافية بعد
// assertValidClientId — دفاع بطبقتين بدل الاعتماد على regex وحده).
function clientDir(clientId) {
  assertValidClientId(clientId);
  const resolved = path.resolve(CLIENTS_DIR, clientId);
  const base = path.resolve(CLIENTS_DIR) + path.sep;
  if (!resolved.startsWith(base)) {
    throw new Error("مسار غير مسموح");
  }
  return resolved;
}

function withLock(clientId, fn) {
  const previous = locks.get(clientId) || Promise.resolve();
  const next = previous.then(fn, fn);
  // نخزّن نسخة ما بترمي استثناء حتى ما توقف سلسلة القفل لعملية لاحقة لو هاي فشلت —
  // الاستثناء الحقيقي لسا بيرجع لنداء withLock نفسه عبر `next`.
  locks.set(clientId, next.catch(() => {}));
  return next;
}

function backupFile(filePath) {
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, `${filePath}.bak`);
  }
}

function atomicWriteSync(filePath, content) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.tmp-${path.basename(filePath)}-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, filePath);
}

// clientId + fileName ("config.json", "knowledge.md"...) + محتوى نصي جاهز.
// لو validate معرّفة وبترجع نص خطأ (مش null)، الكتابة بتترفض قبل ما توصل للقرص.
async function safeWriteFile(clientId, fileName, content, { validate } = {}) {
  const dir = clientDir(clientId);
  if (!fs.existsSync(dir)) throw new Error(`عميل غير موجود: ${clientId}`);
  if (validate) {
    const error = validate(content);
    if (error) throw new Error(`فشل التحقق: ${error}`);
  }

  const filePath = path.join(dir, fileName);
  return withLock(clientId, () => {
    backupFile(filePath);
    atomicWriteSync(filePath, content);
  });
}

// اختصار لكتابة كائن كـJSON منسّق — validate هون بياخد الكائن نفسه (قبل التحويل لنص)، مو النص.
async function safeWriteJSON(clientId, fileName, dataObject, { validate } = {}) {
  return safeWriteFile(clientId, fileName, JSON.stringify(dataObject, null, 2), {
    validate: validate ? () => validate(dataObject) : undefined,
  });
}

// إنشاء مجلد عميل جديد بالكامل بشكل ذرّي (مجلد مؤقت ثم rename) — نفس نمط provisioning.js،
// معاد استخدامه هون لعملاء يُضافون يدويًا من الداشبورد (بعكس عملاء التسجيل الذاتي).
function createClientDirAtomic(clientId, files) {
  assertValidClientId(clientId);
  const finalDir = path.join(CLIENTS_DIR, clientId);
  if (fs.existsSync(finalDir)) throw new Error(`عميل موجود أصلاً: ${clientId}`);

  const tempDir = path.join(CLIENTS_DIR, `.tmp-new-${clientId}-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    for (const [fileName, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(tempDir, fileName), content, "utf8");
    }
    fs.renameSync(tempDir, finalDir);
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

module.exports = {
  listClientIds,
  assertValidClientId,
  clientDir,
  safeWriteFile,
  safeWriteJSON,
  createClientDirAtomic,
};
