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

// كاش ببصمة mtime — كان loadClients() بيعيد قراءة كل العملاء + نصوص المعرفة كاملة من القرص
// بشكل متزامن عند كل رسالة (O(عملاء × حجم معرفة) لكل طلب، وبيعطل الـevent loop). هلق بنحسب
// بصمة رخيصة (أسماء ملفات + mtime + size — قراءة metadata بس، بدون محتوى) وبنعيد البناء
// فقط لما تتغير. دلالة "إعادة التحميل الساخن" بضل نفسها تمامًا: أي تعديل config/auth/.md
// أو إضافة/حذف عميل = بصمة جديدة = إعادة تحميل فوري على الطلب الجاي.
//
// ⚠️ الكائنات المرجعة صارت مشتركة بين الطلبات (نفس reference) — أي مستدعي لازم يقرأ بس،
// يعدّل عبر safeWrite (اللي بيغير الملف → البصمة بتتغير → نسخة جديدة).
let cache = null; // { fingerprint, clients }
let firestoreHydrated = false;

async function hydrateFromFirestore({ db } = {}) {
  if (process.env.FIRESTORE_SOURCE_OF_TRUTH !== "true") return { enabled: false, hydrated: 0 };
  if (firestoreHydrated) return { enabled: true, hydrated: cache ? cache.clients.size : 0 };
  if (!db) db = require("../services/firebaseAdmin").db;
  const repository = require("../services/storageRepository").createRepository({ db });
  const local = getAllClients();
  let hydrated = 0;
  for (const client of local) {
    const remote = await repository.getBotConfig(client.id);
    if (!remote) continue;
    const knowledge = await repository.getKnowledge(client.id);
    const merged = { ...client, ...remote };
    if (knowledge !== null) merged.knowledge = knowledge;
    for (const [key, value] of cache.clients.entries()) {
      if (value === client) cache.clients.set(key, merged);
    }
    hydrated += 1;
  }
  firestoreHydrated = true;
  return { enabled: true, hydrated };
}

function currentFingerprint() {
  const parts = [];
  const entries = fs.readdirSync(CLIENTS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    let dirFp = entry.name;
    try {
      const names = fs.readdirSync(path.join(CLIENTS_DIR, entry.name)).sort();
      for (const name of names) {
        if (name === "config.json" || name === "auth.json" || name.endsWith(".md")) {
          const st = fs.statSync(path.join(CLIENTS_DIR, entry.name, name));
          dirFp += `|${name}:${st.mtimeMs}:${st.size}`;
        }
      }
    } catch {
      // مجلد انشال/اترّحل بنص الفحص — نتجاهله هون؛ أول طلب جاي بعد استقراره بينبني صح
    }
    parts.push(dirFp);
  }
  return parts.join("\n");
}

function buildClients() {
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

function loadClients() {
  const fingerprint = currentFingerprint();
  if (cache && cache.fingerprint === fingerprint) return cache.clients;

  const clients = buildClients();
  cache = { fingerprint, clients };
  return clients;
}

// التعديل على ملفات .md أو إضافة عميل جديد (ingest/تسجيل ذاتي) بيشتغل بدون إعادة تشغيل
// السيرفر — البصمة بتتغير والطلب الجاي بيعيد البناء. راجع currentFingerprint فوق.
function getAllClients() {
  // Index aliases (phone/public/secret key) point to the same client object.
  return [...new Set(loadClients().values())];
}

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

const { evaluateClientEligibility } = require("../services/clientEligibility");

// preview: لسا ما ضغطوا "تفعيل" بعد استعراض المعاينة — ما بيرد على زبائن حقيقيين بعد.
// active: حي، بس لو plan="trial" لازم نتحقق من trialExpiresAt كل مرة (ما منمدد الفترة تلقائيًا).
// expired/disabled: متل ما هي، ما بترد أبدًا.
function isServable(client, now = Date.now()) {
  return evaluateClientEligibility(client, now).allowed;
}

// لأي endpoint بيرجع معلومات عميل لطرف خارجي (GET /me) — بيشيل الحقول يلي ما لازم تترب
// حتى لو مو "مفتاح" حرفيًا (قاعدة المعرفة الكاملة، معرّف واتساب الداخلي).
function sanitizeClient(client) {
  const { knowledge, whatsappPhoneNumberId, ...safe } = client;
  return safe;
}

module.exports = {
  getAllClients,
  getClientById,
  getClientByWhatsappPhoneNumberId,
  getClientByPublicKey,
  getClientBySecretKey,
  isServable,
  hydrateFromFirestore,
};
