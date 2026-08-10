// طبقة كتابة آمنة وحيدة — قرار مجلس LLM (2026-08-09) لملفات src/clients/ (config/knowledge)،
// موسّعة (2026-08-10، طبقة 1 من development-plan-20260809.md) لتغطي data/ كمان
// (appointments.json, orders.json, customers/*.json) — الملفات يلي بتتكتب مع كل رسالة واردة،
// وكانت بلا أي حماية (اكتشاف حرج بمراجعة Opus: القفل الأول كان مغطّي بس "المسار البارد").
//
// أربع حمايات بمكان واحد: منع path traversal، قفل بالميموري لكل عميل (بيسلسل كل الكتابات
// لنفس العميل — config، knowledge، مواعيد، طلبات، ملفات زبائن، كلهم بنفس القفل، حتى ما تصير
// كتابتين متزامنتين لنفس العميل من مصدرين مختلفين "بوت حيّ" و"داشبورد" بنفس اللحظة)، نسخة
// احتياطية قبل كل كتابة، وكتابة ذرّية (temp ثم rename).
//
// ⚠️ withClientLock هو القفل الوحيد — أي كود بدّه يكتب أو يقرأ-ثم-يكتب (read-modify-write،
// زي حجز موعد: فحص التوفر ثم الحجز) لازم يلف العملية **كلها** بـwithClientLock، مش يستدعي
// safeWriteFile/safeWriteDataFile من جوّا قفل موجود أصلاً — هيك بيصير deadlock (نفس الـclientId
// بينتظر حاله). لهيك فيه نسخة "raw" بدون قفل (rawWrite*) للاستخدام **جوا** withClientLock بس.

const fs = require("fs");
const path = require("path");

const CLIENTS_DIR = path.join(__dirname, "..", "clients");
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const CLIENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

const locks = new Map(); // clientId -> Promise (سلسلة كل العمليات المعلّقة لهالعميل — كتابة أو قراءة-ثم-كتابة)

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

function resolveUnder(baseDir, clientId) {
  assertValidClientId(clientId);
  const resolved = path.resolve(baseDir, clientId);
  const base = path.resolve(baseDir) + path.sep;
  if (!resolved.startsWith(base)) {
    throw new Error("مسار غير مسموح");
  }
  return resolved;
}

function clientDir(clientId) {
  return resolveUnder(CLIENTS_DIR, clientId);
}

function dataDir(clientId) {
  return resolveUnder(DATA_DIR, clientId);
}

// القفل الوحيد — كل عملية (كتابة، أو دورة قراءة-فحص-كتابة كاملة) لازم تصير جوا هون.
function withClientLock(clientId, fn) {
  assertValidClientId(clientId);
  const previous = locks.get(clientId) || Promise.resolve();
  const next = previous.then(fn, fn);
  // نخزّن نسخة ما بترمي استثناء حتى ما توقف سلسلة القفل لعملية لاحقة لو هاي فشلت —
  // الاستثناء الحقيقي لسا بيرجع لنداء withClientLock نفسه عبر `next`.
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
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.tmp-${path.basename(filePath)}-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, filePath);
}

// --- نسخ "raw" بدون قفل — للاستخدام جوا withClientLock بس (appointments.js/orders.js/customers.js) ---

function rawWriteClientFile(clientId, fileName, content) {
  const dir = clientDir(clientId);
  if (!fs.existsSync(dir)) throw new Error(`عميل غير موجود: ${clientId}`);
  const filePath = path.join(dir, fileName);
  backupFile(filePath);
  atomicWriteSync(filePath, content);
}

function rawWriteDataFile(clientId, relativeFilePath, content) {
  const filePath = path.join(dataDir(clientId), relativeFilePath);
  backupFile(filePath);
  atomicWriteSync(filePath, content);
}

// قراءة JSON صلبة بوجه تلف الملف: لو JSON.parse فشل، بننقل الملف التالف لجنب (.corrupt-<وقت>)
// بدل ما نخلي الاستثناء يطلع لفوق ويكسر كل قراءة لاحقة (كان هيك قبل — ملف تالف واحد = عميل
// معطّل نهائيًا). بترجع fallback (مصفوفة/كائن فاضي حسب السياق) وتسجّل تحذير.
function safeReadJSON(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    const corruptPath = `${filePath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(filePath, corruptPath);
    } catch {
      // لو حتى النقل فشل، ما منقدر نعمل أكتر من هيك — نكمل بالـfallback
    }
    console.error(
      `[safeWrite] ملف تالف: ${filePath} — نُقل لـ${corruptPath} واستُبدل بقيمة فاضية. راجعه يدويًا.`
    );
    return fallback;
  }
}

// --- واجهات عالية المستوى (بتاخد القفل بنفسها) — لعمليات "اكتب هالمحتوى" البسيطة بدون منطق تاني ---

// clientId + fileName ("config.json", "knowledge.md"...) + محتوى نصي جاهز.
// لو validate معرّفة وبترجع نص خطأ (مش null)، الكتابة بتترفض قبل ما توصل للقرص.
async function safeWriteFile(clientId, fileName, content, { validate } = {}) {
  if (validate) {
    const error = validate(content);
    if (error) throw new Error(`فشل التحقق: ${error}`);
  }
  return withClientLock(clientId, () => rawWriteClientFile(clientId, fileName, content));
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
  dataDir,
  withClientLock,
  rawWriteClientFile,
  rawWriteDataFile,
  safeReadJSON,
  safeWriteFile,
  safeWriteJSON,
  createClientDirAtomic,
};
