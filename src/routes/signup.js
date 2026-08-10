// التسجيل الذاتي: شركة بدها بوت تسجّل حالها بأربع خطوات بدون أي تدخل من المشغّل.
//   POST /signup             → تحقق أولي + إيميل تأكيد (رخيص، بدون أي معالجة ملفات/شبكة)
//   GET  /signup/verify      → تأكيد الإيميل، بيحوّل لصفحة onboard.html حاملة signupToken
//   POST /signup/knowledge   → رفع ملف أو رابط موقع → استخراج + فحص جودة + إنشاء عميل (preview)
//   POST /signup/preview-chat → تجربة الشركة لبوتها قبل التفعيل (بس signupToken، مو مفتاح عام)
//   POST /signup/activate    → تفعيل نهائي، بيرجّع كود الودجت الجاهز

const express = require("express");
const multer = require("multer");
const config = require("../config");
const registry = require("../clients/registry");
const provisioning = require("../services/provisioning");
const signups = require("../services/signups");
const ingest = require("../services/ingest");
const urlGuard = require("../services/urlGuard");
const mailer = require("../services/mailer");
const rateLimit = require("../services/rateLimit");
const whatsapp = require("../services/whatsapp");
const deepseek = require("../services/deepseek");
const customers = require("../services/customers");
const handoff = require("../services/handoff");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(), // ما منكتب بايتات مجهولة المصدر عالديسك أبدًا قبل ما تنفحص
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

function requireSignupEnabled(req, res, next) {
  if (!config.provisioning.enabled) {
    return res.status(503).json({ error: { code: "signup_disabled", message: "التسجيل الذاتي مو مفعّل حاليًا" } });
  }
  next();
}

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// فحص بالبايتات الفعلية (magic numbers) مو بس امتداد اسم الملف — بيحدد النوع الحقيقي حتى
// لو حدا غيّر اسم الامتداد. مقارنة رقمية مباشرة (مو نص فيه محارف تحكّم) حتى تضل واضحة
// ومقروءة بغض النظر عن ترميز الملف.
function detectUploadType(buffer, originalName) {
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return "excel"; // توقيع zip "PK" — xlsx هو أرشيف zip
  if (/\.csv$/i.test(originalName || "")) return "csv";
  return null;
}

router.use(requireSignupEnabled);

// ===== 1) POST /signup =====
router.post("/signup", async (req, res) => {
  const { companyName, contactEmail, notifyWhatsapp, escalationPhone, websiteUrl, acceptedTerms } = req.body || {};

  if (!companyName || String(companyName).trim().length < 2 || String(companyName).length > 100) {
    return res.status(400).json({ error: { code: "invalid_company_name", message: "اسم الشركة مطلوب (2-100 حرف)" } });
  }
  if (!isValidEmail(contactEmail)) {
    return res.status(400).json({ error: { code: "invalid_email", message: "إيميل غير صحيح" } });
  }
  if (!notifyWhatsapp || String(notifyWhatsapp).trim().length < 6) {
    return res.status(400).json({ error: { code: "invalid_notify_whatsapp", message: "رقم واتساب لتنبيهك مطلوب" } });
  }
  if (!escalationPhone || String(escalationPhone).trim().length < 6) {
    return res.status(400).json({ error: { code: "invalid_escalation_phone", message: "رقم تواصل للزبائن مطلوب" } });
  }
  if (!isValidUrl(websiteUrl)) {
    return res.status(400).json({ error: { code: "invalid_website_url", message: "رابط موقع صحيح مطلوب (http/https)" } });
  }
  if (acceptedTerms !== true) {
    return res.status(400).json({ error: { code: "terms_not_accepted", message: "لازم توافق على الشروط" } });
  }

  const ip = clientIp(req);
  const ipHour = rateLimit.checkLimit(`signup-ip-hr:${ip}`, { max: 3, windowMs: 60 * 60 * 1000 });
  const ipDay = rateLimit.checkLimit(`signup-ip-day:${ip}`, { max: 10, windowMs: 24 * 60 * 60 * 1000 });
  const globalDay = rateLimit.checkLimit("signup-global-day", { max: 20, windowMs: 24 * 60 * 60 * 1000 });

  if (!ipHour.allowed || !ipDay.allowed || !globalDay.allowed) {
    return res.status(429).json({ error: { code: "rate_limited", message: "عدد تسجيلات كتير — جرب بعد شوي" } });
  }

  if (registry.getClientByContactEmail(contactEmail) || signups.hasActivePendingForEmail(contactEmail)) {
    return res.status(409).json({ error: { code: "email_already_used", message: "هالإيميل عنده تسجيل شغال أصلاً" } });
  }

  const { pendingId, verifyToken } = signups.createPending({
    companyName: String(companyName).trim(),
    contactEmail: String(contactEmail).trim(),
    notifyWhatsapp: String(notifyWhatsapp).trim(),
    escalationPhone: String(escalationPhone).trim(),
    websiteUrl: String(websiteUrl).trim(),
  });

  const verifyUrl = `${config.provisioning.publicBaseUrl}/api/v1/signup/verify?pendingId=${pendingId}&token=${verifyToken}`;
  await mailer.sendVerificationEmail(contactEmail, verifyUrl);

  res.json({ pendingId, status: "pending_email_verification" });
});

// ===== 2) GET /signup/verify =====
router.get("/signup/verify", (req, res) => {
  const { pendingId, token } = req.query;
  if (!pendingId || !token) {
    return res.status(400).json({ error: { code: "missing_params", message: "pendingId وtoken مطلوبين" } });
  }

  try {
    const { signupToken } = signups.verifyEmail(String(pendingId), String(token));
    res.redirect(`/public/onboard.html?token=${encodeURIComponent(signupToken)}`);
  } catch (err) {
    // ما في صفحة خطأ مخصصة بهالمرحلة — رسالة JSON واضحة كافية (رابط منتهي/مُستخدم مسبقًا)
    res.status(400).json({ error: { code: "verification_failed", message: err.message } });
  }
});

function requireSignupToken(req, res, next) {
  const authHeader = req.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (!token) {
    return res.status(401).json({ error: { code: "missing_signup_token", message: "Authorization: Bearer <signupToken> مطلوب" } });
  }

  const pending = signups.getPendingBySignupToken(token);
  if (!pending) {
    return res.status(401).json({ error: { code: "invalid_signup_token", message: "signupToken غير صحيح أو منتهي" } });
  }

  req.pending = pending;
  next();
}

// حالة الطلب الحالية — تخلي صفحة onboard.html تعرض رابط الموقع الصحيح وتتعامل صح مع
// إعادة تحميل الصفحة نص الطريق (لو خلص رفع المعرفة، تعرض المعاينة مباشرة بدل ما تطلب رفع تاني).
// ⚠️ بعد التفعيل الكامل، signupToken يصير "منتهي" عمدًا (راجع getPendingBySignupToken) —
// فهالـ endpoint بيرجع 401 بعدها، وهاد مقصود (توكن مكتمل ما لازم يضل صالح). الصفحة بتحتفظ
// بكود الودجت بالذاكرة (JS) مباشرة بعد التفعيل، مو عبر إعادة استعلام لاحقة.
router.get("/signup/status", requireSignupToken, (req, res) => {
  const p = req.pending;
  res.json({
    companyName: p.companyName,
    websiteUrl: p.websiteUrl,
    clientId: p.clientId,
    publicKey: p.publicKey,
    knowledgeAttemptsRemaining: signups.MAX_KNOWLEDGE_ATTEMPTS - p.knowledgeAttempts,
  });
});

// ===== 3) POST /signup/knowledge =====
router.post("/signup/knowledge", requireSignupToken, upload.single("file"), async (req, res) => {
  const pending = req.pending;

  const attempts = signups.incrementKnowledgeAttempts(pending.pendingId);
  if (attempts > signups.MAX_KNOWLEDGE_ATTEMPTS) {
    return res.status(429).json({ error: { code: "too_many_attempts", message: "تجاوزت الحد المسموح لمحاولات رفع المعرفة" } });
  }

  let content;
  let sourceType;
  let sourceValue;

  try {
    if (req.file) {
      const detected = detectUploadType(req.file.buffer, req.file.originalname);
      if (detected === "pdf") {
        content = await ingest.ingestPdfBuffer(req.file.buffer);
      } else if (detected === "excel" || detected === "csv") {
        content = await ingest.ingestExcelBuffer(req.file.buffer, detected === "csv" ? ".csv" : ".xlsx");
      } else {
        return res.status(422).json({ error: { code: "unsupported_file_type", message: "نوع ملف غير مدعوم (PDF أو Excel/CSV بس)" } });
      }
      sourceType = detected;
      sourceValue = req.file.originalname;
    } else if (req.body?.source === "website") {
      content = await ingest.ingestWebsite(pending.websiteUrl, { fetch: urlGuard.safeGet });
      sourceType = "website";
      sourceValue = pending.websiteUrl;
    } else {
      return res.status(400).json({ error: { code: "no_source_provided", message: "ارفع ملف (file) أو ابعت source=website" } });
    }
  } catch (err) {
    return res.status(422).json({ error: { code: "extraction_failed", message: err.message } });
  }

  const check = ingest.sanityCheck(content);
  if (!check.ok) {
    return res.status(422).json({ error: { code: "knowledge_quality_check_failed", message: "الاستخراج ما اجتاز الفحص الأولي" }, warnings: check.warnings, stats: check.stats });
  }

  const knowledgeFileName = `source-${sourceType}.md`;
  let clientId;
  let publicKey;

  if (pending.clientId) {
    provisioning.replaceKnowledge(pending.clientId, content, knowledgeFileName);
    clientId = pending.clientId;
    publicKey = pending.publicKey;
  } else {
    const result = provisioning.createClient({
      companyName: pending.companyName,
      contactEmail: pending.contactEmail,
      notifyWhatsapp: pending.notifyWhatsapp,
      escalationPhone: pending.escalationPhone,
      websiteUrl: pending.websiteUrl,
      source: { type: sourceType, value: sourceValue, ingestedAt: new Date().toISOString() },
      knowledgeContent: content,
      knowledgeFileName,
    });
    clientId = result.clientId;
    publicKey = result.publicKey;
    signups.attachClient(pending.pendingId, clientId, publicKey);
  }

  res.json({
    clientId,
    warnings: check.warnings,
    stats: check.stats,
    previewExcerpt: content.slice(0, 2000),
    attemptsRemaining: signups.MAX_KNOWLEDGE_ATTEMPTS - attempts,
  });
});

// ===== تجربة البوت قبل التفعيل — بـ signupToken بس، مش pk_/sk_ (العميل لسا preview) =====
// سقف رسائل خفيف دفاعًا إضافيًا (جنب TTL التوكن نفسه 24 ساعة) حتى ما يصير مسار لاستهلاك DeepSeek بلا حدود.
router.post("/signup/preview-chat", requireSignupToken, async (req, res) => {
  const pending = req.pending;

  if (!pending.clientId) {
    return res.status(400).json({ error: { code: "no_knowledge_yet", message: "لازم ترفع معرفة عبر /signup/knowledge أول" } });
  }

  const { message } = req.body || {};
  if (!message) {
    return res.status(400).json({ error: { code: "missing_message", message: "message مطلوب" } });
  }

  const previewLimit = rateLimit.checkLimit(`preview-chat:${pending.pendingId}`, { max: 30, windowMs: 24 * 60 * 60 * 1000 });
  if (!previewLimit.allowed) {
    return res.status(429).json({ error: { code: "preview_limit_reached", message: "وصلت لسقف رسائل تجربة البوت — فعّل البوت أول لتكمل الاختبار عليه" } });
  }

  const client = registry.getClientById(pending.clientId);
  if (!client) {
    return res.status(404).json({ error: { code: "client_not_found", message: "عميل غير موجود" } });
  }

  try {
    const previewUserId = `preview-${pending.pendingId}`;
    const profile = customers.getProfile(client.id, previewUserId);
    // ما بنستخدم replyCache هون عمدًا — هاي معاينة حية لصاحب الشركة يتأكد من ردود بوته
    // الفعلية، رد من كاش (حتى لو صحيح) بيعطي انطباع كاذب إنه اختبر النموذج مباشرة.
    const { text: rawReply } = await deepseek.getReply(client, profile, message);
    const { cleanText } = handoff.extractEscalationMarker(rawReply);
    await customers.saveTurn(client.id, previewUserId, message, cleanText);
    res.json({ reply: cleanText });
  } catch (err) {
    console.error("[signup] فشل معاينة الشات:", err.response?.data || err.message);
    res.status(500).json({ error: { code: "preview_chat_failed", message: "صار خطأ بمعاينة الشات، جرب كمان شوي" } });
  }
});

// ===== 4) POST /signup/activate =====
router.post("/signup/activate", requireSignupToken, (req, res) => {
  const pending = req.pending;

  if (!pending.clientId) {
    return res.status(400).json({ error: { code: "no_knowledge_yet", message: "لازم ترفع معرفة عبر /signup/knowledge أول" } });
  }

  provisioning.activateClient(pending.clientId);
  signups.markCompleted(pending.pendingId);

  const widgetSnippet =
    `<script src="${config.provisioning.publicBaseUrl}/widget/chat-widget.js"\n` +
    `        data-server="${config.provisioning.publicBaseUrl}"\n` +
    `        data-client-id="${pending.clientId}"\n` +
    `        data-public-key="${pending.publicKey}"></script>`;

  // إشعار المشغّل — fire-and-forget، ما لازم يوقف/يفشّل الرد لو الإرسال تعثّر
  if (config.provisioning.operatorWhatsapp && config.whatsapp.notifySenderPhoneNumberId) {
    whatsapp
      .sendTextMessage(
        config.provisioning.operatorWhatsapp,
        config.whatsapp.notifySenderPhoneNumberId,
        `🆕 عميل جديد فعّل بوته ذاتيًا: ${pending.companyName} (${pending.clientId})\nإيميل: ${pending.contactEmail}`
      )
      .catch((err) => console.error("[signup] فشل إشعار المشغّل:", err.response?.data || err.message));
  }

  res.json({
    clientId: pending.clientId,
    publicKey: pending.publicKey,
    widgetSnippet,
    docsUrl: `${config.provisioning.publicBaseUrl}/docs`,
  });
});

module.exports = router;
