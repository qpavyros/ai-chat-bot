const fs = require("fs");
const path = require("path");
const apiKeys = require("../services/apiKeys");

const CLIENTS_DIR = __dirname;

function loadKnowledge(clientDir) {
  // بيلمّ كل ملفات .md بمجلد العميل (knowledge.md اليدوي + أي ملف source-*.md مولّد بـ scripts/ingest.js)
  // ويلزقهم ببعض. الترتيب أبجدي، فـ knowledge.md بيسبق source-* عادة — رتّب أسماء الملفات حسب الأولوية يلي بدك ياها.
  const mdFiles = fs
    .readdirSync(clientDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  return mdFiles
    .map((file) => fs.readFileSync(path.join(clientDir, file), "utf8"))
    .join("\n\n---\n\n");
}

// auth.json منفصل عن config.json عمدًا — config يُنشر كامل بمعلومات العميل (وبيروح لبناء
// الـ system prompt)، وما بدنا مفتاح سري ولا هاشاته يترافقوا بنفس الكائن يلي يمشي بكل هالطريق.
function loadAuth(clientDir) {
  const authPath = path.join(clientDir, "auth.json");
  if (!fs.existsSync(authPath)) return { publicKey: null, apiKeys: [] };
  return JSON.parse(fs.readFileSync(authPath, "utf8"));
}

function loadClients() {
  const clients = new Map();

  const entries = fs.readdirSync(CLIENTS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    // مجلدات مؤقتة بادئتها "." (provisioning.js بينشئها أثناء إنشاء عميل جديد ذرّيًا) —
    // ما بتوصل هون أصلاً عادة لأنها بتترّحل باسمها النهائي دفعة وحدة، بس هاي حماية إضافية رخيصة.
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const clientDir = path.join(CLIENTS_DIR, entry.name);
    const configPath = path.join(clientDir, "config.json");
    if (!fs.existsSync(configPath)) continue;

    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const knowledge = loadKnowledge(clientDir);
    if (!knowledge.trim()) {
      console.warn(`[registry] عميل "${config.id}" ما إله أي ملف .md بقاعدة المعرفة — رح يرد بدون أي سياق.`);
    }

    const auth = loadAuth(clientDir);
    const client = { ...config, knowledge };

    clients.set(config.id, client);
    if (config.whatsappPhoneNumberId) {
      clients.set(`wa:${config.whatsappPhoneNumberId}`, client);
    }
    if (auth.publicKey) {
      clients.set(`pk:${auth.publicKey}`, client);
    }
    for (const key of auth.apiKeys || []) {
      if (!key.revokedAt) {
        clients.set(`sk:${key.hash}`, client);
      }
    }
  }

  return clients;
}

// إعادة تحميل عند كل طلب مو مكلف بعدد العملاء القليل في هالمرحلة، وبيسمح تعديل ملفات .md
// أو إضافة ملفات جديدة بالـ ingest سكربت (أو عميل جديد بالتسجيل الذاتي) بدون إعادة تشغيل السيرفر.
function getClientById(id) {
  return loadClients().get(id) || null;
}

function getClientByWhatsappPhoneNumberId(phoneNumberId) {
  return loadClients().get(`wa:${phoneNumberId}`) || null;
}

function getClientByPublicKey(key) {
  return loadClients().get(`pk:${key}`) || null;
}

function getClientBySecretKey(rawKey) {
  return loadClients().get(`sk:${apiKeys.hashKey(rawKey)}`) || null;
}

// لفحص التكرار وقت التسجيل الذاتي: هل إيميل معيّن عنده عميل فعّال أصلاً؟ مسح مباشر بالذاكرة
// كافي بعدد العملاء المتوقع بهالمرحلة — مو مبرر فهرسة إضافية لهالاستخدام النادر.
function getClientByContactEmail(email) {
  const normalized = String(email).trim().toLowerCase();
  for (const client of loadClients().values()) {
    if (client.contactEmail?.toLowerCase() === normalized) return client;
  }
  return null;
}

// preview: لسا ما ضغطوا "تفعيل" بعد استعراض المعاينة — ما بيرد على زبائن حقيقيين بعد.
// active: حي، بس لو plan="trial" لازم نتحقق من trialExpiresAt كل مرة (ما منمدد الفترة تلقائيًا).
// expired/disabled: متل ما هي، ما بترد أبدًا.
function isServable(client) {
  if (!client) return false;

  // عملاء بدون حقل status صراحة = عملاء أنشئوا يدويًا (config.json مكتوب بالإيد من قبل المشغّل) —
  // دايمًا نشطين، بدون مرور بمرحلة preview. هالحقل أصلاً موجود بس لعملاء التسجيل الذاتي.
  if (client.status === undefined) return true;

  if (client.status === "disabled" || client.status === "expired" || client.status === "preview") {
    return false;
  }

  if (client.plan === "trial" && client.trialExpiresAt) {
    if (new Date(client.trialExpiresAt).getTime() < Date.now()) return false;
  }

  return client.status === "active";
}

// لأي endpoint بيرجع معلومات عميل لطرف خارجي (GET /me) — بيشيل الحقول يلي ما لازم تترب
// حتى لو مو "مفتاح" حرفيًا (قاعدة المعرفة الكاملة، معرّف واتساب الداخلي).
function sanitizeClient(client) {
  const { knowledge, whatsappPhoneNumberId, ...safe } = client;
  return safe;
}

module.exports = {
  getClientById,
  getClientByWhatsappPhoneNumberId,
  getClientByPublicKey,
  getClientBySecretKey,
  getClientByContactEmail,
  isServable,
  sanitizeClient,
};
