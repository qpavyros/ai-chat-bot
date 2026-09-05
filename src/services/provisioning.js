// إنشاء عميل جديد آليًا (تسجيل ذاتي) — يُنتج src/clients/<slug>/ كامل ومتّسق دائمًا،
// أو ما يُنتج شي أبدًا. لا حالة نصف-مكتملة يقدر registry.js يحمّلها بالخطأ.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");
const apiKeys = require("./apiKeys");
const safeWrite = require("./safeWrite");

const CLIENTS_DIR = path.join(__dirname, "..", "clients");

// أسماء ما يصير تصير clientId — إما موجودة فعليًا بالمشروع، أو خطر (path traversal)،
// أو محجوزة لأسباب مستقبلية (مسارات API، إلخ)
const RESERVED_NAMES = new Set([
  "data", "node_modules", "src", "scripts", "docs", "public", "admin",
  "api", "www", "assets", "config", ".", "..", "example-client", "example-clinic",
]);

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}$/;

function slugify(companyName) {
  return String(companyName)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "") // بيشيل عربي/رموز — الـ slug لازم يكون ASCII بحت لأنه اسم مجلد ومعرّف بمسارات
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 30)
    .replace(/^-+|-+$/g, "");
}

function isValidSlugFormat(slug) {
  return SLUG_PATTERN.test(slug);
}

function isReservedName(slug) {
  return RESERVED_NAMES.has(slug);
}

function slugExists(slug) {
  return fs.existsSync(path.join(CLIENTS_DIR, slug));
}

// بيولّد slug فريد من اسم الشركة — لو "acme" محجوز، يجرّب acme-2، acme-3... لغاية ما يلاقي وحدة فاضية.
// أسماء عربي بحت (الحالة الأغلب لجمهورنا) بتصفّى لفراغ بعد التنظيف — بدل ما نكدّس كل هالشركات
// بنفس بادئة "client" (client-2, client-3...)، منولّد لاحقة عشوائية قصيرة فريدة لكل وحدة منهم.
function generateUniqueSlug(companyName) {
  const base = slugify(companyName) || `client-${crypto.randomBytes(3).toString("hex")}`;
  let candidate = base;
  let suffix = 2;

  while (isReservedName(candidate) || slugExists(candidate) || !isValidSlugFormat(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
    if (suffix > 1000) {
      // احتياط نظري بحت — ما لازم توصله بحجم عملاء هالمرحلة
      throw new Error("تعذّر توليد معرّف فريد للعميل");
    }
  }

  return candidate;
}

function defaultConfig({ slug, companyName, contactEmail, notifyWhatsapp, escalationPhone, websiteUrl, source, ownerUid }) {
  const now = new Date();
  const trialExpiresAt = new Date(now.getTime() + config.provisioning.trialDays * 24 * 60 * 60 * 1000);

  let origin = null;
  try {
    origin = new URL(websiteUrl).origin;
  } catch {
    // websiteUrl ممكن يكون فاضي لو المصدر PDF/إكسل بدل موقع — allowedOrigins بيضل فاضي وقتها
  }

  return {
    id: slug,
    ...(ownerUid ? { ownerUid } : {}),
    displayName: companyName,
    language: "ar-LB",
    tone: "مهذب، واضح، جمل قصيرة، ما بيوعد بشي مش أكيد منه",
    escalation: {
      phone: escalationPhone,
      contactMethod: `التواصل مع فريق ${companyName} مباشرة`,
      notifyWhatsapp,
    },
    contactEmail,
    allowedOrigins: origin ? [origin] : [],
    status: "preview", // preview → active (بعد /activate) → expired/disabled
    plan: "trial",
    knowledgeReviewed: false, // معرفة مستخرجة آليًا، ما راجعها حدا يدويًا بعد
    createdAt: now.toISOString(),
    trialExpiresAt: trialExpiresAt.toISOString(),
    source, // { type: "website"|"pdf"|"excel", value, ingestedAt } — للتتبّع/التدقيق لاحقًا
  };
}

// إنشاء ذرّي: نكتب كل شي بمجلد مؤقت مخفي (نفس المجلد الأب، حتى الـ rename يكون ذرّي فعليًا
// على نفس نظام الملفات)، وما ننقله لاسمه النهائي إلا بعد ما يخلص الكتابة بالكامل. أي عطل
// بالنص لا سمح الله بيوقف العملية قبل ما يوصل للـ rename — ما في مجلد عميل نصف-مكتمل
// registry.js يقدر يحمّله بالغلط (registry أصلاً بيتجاهل أي مجلد بدون config.json، فالمجلد
// المؤقت ما ظاهر إله أبدًا حتى لو حدا قرا المجلد بنفس اللحظة).
function createClient({ companyName, contactEmail, notifyWhatsapp, escalationPhone, websiteUrl, source, knowledgeContent, knowledgeFileName, ownerUid }) {
  const slug = generateUniqueSlug(companyName);
  const clientConfig = defaultConfig({ slug, companyName, contactEmail, notifyWhatsapp, escalationPhone, websiteUrl, source, ownerUid });
  const publicKey = apiKeys.generatePublicKey();
  const authData = { publicKey, apiKeys: [] };

  const tempDir = path.join(CLIENTS_DIR, `.tmp-${crypto.randomBytes(8).toString("hex")}`);
  const finalDir = path.join(CLIENTS_DIR, slug);

  fs.mkdirSync(tempDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify(clientConfig, null, 2), "utf8");
    fs.writeFileSync(path.join(tempDir, "auth.json"), JSON.stringify(authData, null, 2), "utf8");
    fs.writeFileSync(path.join(tempDir, knowledgeFileName || "knowledge.md"), knowledgeContent, "utf8");

    fs.renameSync(tempDir, finalDir);
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }

  return { clientId: slug, publicKey, config: clientConfig };
}

// شركة عم تحاول تستورد ملف تاني بعد فشل/عدم رضا عن المحاولة الأولى (لسا preview، ما انفعّل بعد).
// بنشيل أي source-*.md قديم ونكتب الجديد — ما منعمل عميل جديد (كان صار عندها clientId أصلاً).
// دورة الحذف+الكتابة كاملة جوا قفل العميل حتى ما تقرأ registry نص-معرفة مختلط بنص المعالجة.
async function replaceKnowledge(clientId, knowledgeContent, knowledgeFileName) {
  await safeWrite.withClientLock(clientId, () => {
    const clientDir = safeWrite.clientDir(clientId);
    if (!fs.existsSync(path.join(clientDir, "config.json"))) {
      throw new Error(`عميل غير موجود: ${clientId}`);
    }

    for (const file of fs.readdirSync(clientDir)) {
      if (file.startsWith("source-") && file.endsWith(".md")) {
        fs.unlinkSync(path.join(clientDir, file));
      }
    }

    safeWrite.rawWriteClientFile(clientId, knowledgeFileName || "source-website.md", knowledgeContent);
  });
  require("./replyCache").clear(clientId);
}

// preview → active. الفترة التجريبية تنطلق من هلق (لا من لحظة الإنشاء) — الشركة ممكن تاخد
// وقتها تراجع المعاينة قبل ما تفعّل، وما لازم هالوقت يقتطع من فترتها التجريبية الفعلية.
// قراءة-تعديل-كتابة config.json جوا القفل — بدون هيك ممكن تطغى على تعديل أدمن متزامن.
async function activateClient(clientId) {
  await safeWrite.withClientLock(clientId, () => {
    const clientDir = safeWrite.clientDir(clientId);
    const configPath = path.join(clientDir, "config.json");
    if (!fs.existsSync(configPath)) {
      throw new Error(`عميل غير موجود: ${clientId}`);
    }

    const clientConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const wasActive = clientConfig.status === "active";
    clientConfig.status = "active";
    if (!wasActive || !clientConfig.trialExpiresAt) {
      clientConfig.trialExpiresAt = new Date(
        Date.now() + config.provisioning.trialDays * 24 * 60 * 60 * 1000
      ).toISOString();
    }

    safeWrite.rawWriteClientFile(clientId, "config.json", JSON.stringify(clientConfig, null, 2));
    return clientConfig;
  });
}

module.exports = {
  slugify,
  isValidSlugFormat,
  isReservedName,
  slugExists,
  generateUniqueSlug,
  createClient,
  replaceKnowledge,
  activateClient,
};
