// تسجيل بوت جديد لحساب مسجّل دخول (راجع docs/site-restructure-plan.md قسم 4). الهوية هلق
// جلسة حساب مستخدم (src/routes/userAuth.js)، مش رابط إيميل مؤقت — النسخة القديمة كانت تبلّش
// بتحقق إيميل منفصل قبل ما يصير عندك حساب أصلاً؛ هلق الحساب موجود أول (Firebase Auth بيتحقق
// ملكية الإيميل ضمنيًا عبر تسجيل الدخول فيه)، فمنبلّش مباشرة بتفاصيل الشركة.
//
//   POST /signup/start        → (requireUserAuth) ينشئ/يرجّع طلب تسجيل بوت قيد التنفيذ لهالحساب
//   GET  /signup/status       → حالة الطلب الحالي (لصفحة onboard.html)
//   POST /signup/knowledge    → رفع ملف أو رابط موقع → استخراج + فحص جودة + إنشاء عميل (preview)
//   POST /signup/preview-chat → تجربة الشركة لبوتها قبل التفعيل
//   POST /signup/connect-whatsapp → WhatsApp Embedded Signup
//   POST /signup/activate     → تفعيل نهائي + ربط البوت بالحساب (userAccounts.attachBot)

const express = require("express");
const multer = require("multer");
const axios = require("axios");
const crypto = require("crypto");
const config = require("../config");
const registry = require("../clients/registry");
const provisioning = require("../services/provisioning");
const signups = require("../services/signups");
const trialFraudGuard = require("../services/trialFraudGuard");
const userAccounts = require("../services/userAccounts");
const ingest = require("../services/ingest");
const urlGuard = require("../services/urlGuard");
const rateLimit = require("../services/rateLimit");
const whatsapp = require("../services/whatsapp");
const deepseek = require("../services/deepseek");
const customers = require("../services/customers");
const handoff = require("../services/handoff");
const safeWrite = require("../services/safeWrite");
const asyncHandler = require("../middleware/asyncHandler");
const { validateClientConfig } = require("../services/clientConfigSchema");
const { verifyEmbeddedSignupOwnership } = require("../services/whatsappOwnership");
const { requireUserAuth } = require("./userAuth");

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

// App ID وConfiguration ID مش سريين (App Secret هو السري، ما بيطلع من هون أبدًا) — الصفحة
// العامة (onboard.html) محتاجتهم لتشغيل Facebook JS SDK.
router.get("/signup/embedded-signup-config", (req, res) => {
  res.json({
    enabled: Boolean(config.meta.appId && config.meta.appSecret && config.meta.configId),
    appId: config.meta.appId || null,
    configId: config.meta.configId || null,
    graphVersion: config.whatsapp.graphVersion,
  });
});

// ===== POST /signup/start — يحتاج تسجيل دخول حساب أول =====
router.post("/signup/start", requireUserAuth, asyncHandler(async (req, res) => {
  const { companyName, notifyWhatsapp, escalationPhone, websiteUrl, acceptedTerms } = req.body || {};

  if (!companyName || String(companyName).trim().length < 2 || String(companyName).length > 100) {
    return res.status(400).json({ error: { code: "invalid_company_name", message: "اسم الشركة مطلوب (2-100 حرف)" } });
  }
  if (!notifyWhatsapp || String(notifyWhatsapp).trim().length < 6) {
    return res.status(400).json({ error: { code: "invalid_notify_whatsapp", message: "رقم واتساب لتنبيهك مطلوب" } });
  }
  if (!escalationPhone || String(escalationPhone).trim().length < 6) {
    return res.status(400).json({ error: { code: "invalid_escalation_phone", message: "رقم تواصل للزبائن مطلوب" } });
  }
  const trimmedWebsiteUrl = websiteUrl ? String(websiteUrl).trim() : "";
  if (trimmedWebsiteUrl && !isValidUrl(trimmedWebsiteUrl)) {
    return res.status(400).json({ error: { code: "invalid_website_url", message: "رابط الموقع لازم يبلّش بـhttp:// أو https://" } });
  }
  if (acceptedTerms !== true) {
    return res.status(400).json({ error: { code: "terms_not_accepted", message: "لازم توافق على الشروط" } });
  }

  const ip = clientIp(req);
  const ipHour = rateLimit.checkLimit(`signup-ip-hr:${ip}`, { max: 3, windowMs: 60 * 60 * 1000 });
  const ipDay = rateLimit.checkLimit(`signup-ip-day:${ip}`, { max: 10, windowMs: 24 * 60 * 60 * 1000 });
  if (!ipHour.allowed || !ipDay.allowed) {
    return res.status(429).json({ error: { code: "rate_limited", message: "عدد تسجيلات كتير — جرب بعد شوي" } });
  }

  // منع نفس الشخص من فتح أكتر من حساب تجريبي واحد (بحساب Firebase مختلف) عبر إعادة استخدام
  // نفس رقم واتساب/رقم تصعيد/دومين موقع، أو تسجيلات كتيرة من نفس الشبكة. راجع trialFraudGuard.js.
  const fraudCheck = await trialFraudGuard.reserveSignupFingerprints(req.uid, {
    notifyWhatsapp,
    escalationPhone,
    websiteUrl: trimmedWebsiteUrl,
    ip,
  });
  if (fraudCheck.blocked) {
    return res.status(409).json({ error: { code: "trial_already_used", message: trialFraudGuard.messageForReason(fraudCheck.reason) } });
  }

  const profile = await userAccounts.getProfile(req.uid);
  const pending = await signups.createPending(req.uid, {
    companyName: String(companyName).trim(),
    contactEmail: profile.email,
    notifyWhatsapp: String(notifyWhatsapp).trim(),
    escalationPhone: String(escalationPhone).trim(),
    websiteUrl: trimmedWebsiteUrl,
  });

  await userAccounts.setOnboardingState(req.uid, { pendingId: pending.pendingId, currentStep: "knowledge" });

  res.json({ pendingId: pending.pendingId });
}));

// كل الراوتات تحت هون بتحتاج pendingId (query لـGET، body لـPOST) + ملكية: نفس الحساب
// يلي أنشأ الطلب. allowCompleted بيسمح بمتابعة العمل بعد "بوتك جاهز 🎉" (ربط واتساب، تحميل
// الصفحة تاني) — العمليات الحسّاسة (رفع/استبدال معرفة، إعادة تفعيل) بتبقى محصورة بـallowCompleted=false.
function requireOwnedPending({ allowCompleted = false } = {}) {
  return [
    requireUserAuth,
    asyncHandler(async (req, res, next) => {
      // pendingId بالـquery string بس (مش body) عمدًا — /signup/knowledge بيستخدم multipart
      // (upload.single يفكّك الـbody بعد ما هالميدلوير يشتغل)، فلازم مصدر واحد ثابت لكل الراوتات.
      const pendingId = req.query.pendingId;
      if (!pendingId) {
        return res.status(400).json({ error: { code: "missing_pending_id", message: "pendingId مطلوب" } });
      }
      const pending = await signups.getPending(String(pendingId));
      if (!pending || pending.ownerUid !== req.uid) {
        return res.status(404).json({ error: { code: "pending_not_found", message: "طلب تسجيل غير موجود" } });
      }
      if (pending.status === "completed" && !allowCompleted) {
        return res.status(409).json({ error: { code: "already_completed", message: "هالطلب اتفعّل أصلاً" } });
      }
      req.pending = pending;
      next();
    }),
  ];
}

router.get("/signup/status", requireOwnedPending({ allowCompleted: true }), (req, res) => {
  const p = req.pending;
  res.json({
    companyName: p.companyName,
    websiteUrl: p.websiteUrl,
    clientId: p.clientId,
    publicKey: p.publicKey,
    completed: p.status === "completed",
    knowledgeAttemptsRemaining: signups.MAX_KNOWLEDGE_ATTEMPTS - p.knowledgeAttempts,
  });
});

// ===== POST /signup/knowledge =====
router.post("/signup/knowledge", ...requireOwnedPending(), upload.single("file"), asyncHandler(async (req, res) => {
  const pending = req.pending;

  const attempts = await signups.incrementKnowledgeAttempts(pending.pendingId);
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
      let websiteUrl = pending.websiteUrl;
      if (!websiteUrl) {
        const provided = req.body?.websiteUrl ? String(req.body.websiteUrl).trim() : "";
        if (!isValidUrl(provided)) {
          return res.status(400).json({ error: { code: "invalid_website_url", message: "رابط الموقع لازم يبلّش بـhttp:// أو https://" } });
        }
        websiteUrl = provided;
        await signups.setWebsiteUrl(pending.pendingId, websiteUrl);
      }
      content = await ingest.ingestWebsite(websiteUrl, { fetch: urlGuard.safeGet });
      sourceType = "website";
      sourceValue = websiteUrl;
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
    await provisioning.replaceKnowledge(pending.clientId, content, knowledgeFileName);
    clientId = pending.clientId;
    publicKey = pending.publicKey;
  } else {
    const result = provisioning.createClient({
      companyName: pending.companyName,
      contactEmail: pending.contactEmail,
      notifyWhatsapp: pending.notifyWhatsapp,
      escalationPhone: pending.escalationPhone,
      websiteUrl: sourceType === "website" ? sourceValue : pending.websiteUrl,
      source: { type: sourceType, value: sourceValue, ingestedAt: new Date().toISOString() },
      knowledgeContent: content,
      knowledgeFileName,
    });
    clientId = result.clientId;
    publicKey = result.publicKey;
    await signups.attachClient(pending.pendingId, clientId, publicKey);
  }

  res.json({
    clientId,
    warnings: check.warnings,
    stats: check.stats,
    previewExcerpt: content.slice(0, 2000),
    attemptsRemaining: signups.MAX_KNOWLEDGE_ATTEMPTS - attempts,
  });
}));

// ===== تجربة البوت قبل التفعيل =====
// سقف رسائل خفيف دفاعًا إضافيًا حتى ما يصير مسار لاستهلاك DeepSeek بلا حدود.
router.post("/signup/preview-chat", ...requireOwnedPending(), asyncHandler(async (req, res) => {
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
}));

// ===== POST /signup/connect-whatsapp — WhatsApp Embedded Signup =====
router.post("/signup/connect-whatsapp", ...requireOwnedPending({ allowCompleted: true }), asyncHandler(async (req, res) => {
  const pending = req.pending;
  const { code, phoneNumberId, wabaId } = req.body || {};

  if (!pending.clientId) {
    return res.status(400).json({ error: { code: "no_knowledge_yet", message: "لازم ترفع معرفة عبر /signup/knowledge أول" } });
  }
  if (!code || !phoneNumberId) {
    return res.status(400).json({ error: { code: "missing_fields", message: "code وphoneNumberId مطلوبين" } });
  }
  if (!config.meta.appId || !config.meta.appSecret) {
    return res.status(503).json({ error: { code: "embedded_signup_not_configured", message: "ربط واتساب التلقائي مش مفعّل حالياً — تواصل معنا" } });
  }

  let reservedWabaId = null;
  try {
    const ownership = await verifyEmbeddedSignupOwnership({
      axios,
      graphVersion: config.whatsapp.graphVersion,
      appId: config.meta.appId,
      appSecret: config.meta.appSecret,
      code,
      phoneNumberId,
      wabaId,
    });

    reservedWabaId = ownership.wabaId;
    if (reservedWabaId) {
      const wabaFraudCheck = await trialFraudGuard.reserveWabaFingerprint(req.uid, reservedWabaId);
      if (wabaFraudCheck.blocked) {
        reservedWabaId = null;
        return res.status(409).json({ error: { code: "trial_already_used", message: trialFraudGuard.messageForReason(wabaFraudCheck.reason) } });
      }
    }

    const pin = String(crypto.randomInt(100000, 999999));
    await axios.post(
      `https://graph.facebook.com/${config.whatsapp.graphVersion}/${phoneNumberId}/register`,
      { messaging_product: "whatsapp", pin },
      { headers: { Authorization: `Bearer ${config.whatsapp.token}` }, timeout: 15_000 }
    );

    const existing = registry.getClientById(pending.clientId);
    if (!existing) return res.status(404).json({ error: { code: "client_not_found", message: "عميل غير موجود" } });

    const { knowledge, ...configOnly } = existing;
    const updated = {
      ...configOnly,
      whatsappPhoneNumberId: phoneNumberId,
      whatsappBusinessAccountId: ownership.wabaId,
      whatsappRegistrationPin: pin,
    };

    await safeWrite.safeWriteJSON(pending.clientId, "config.json", updated, { validate: validateClientConfig });
    await trialFraudGuard.confirmWabaFingerprint(req.uid, reservedWabaId);

    res.json({ ok: true, phoneNumberId });
  } catch (err) {
    if (reservedWabaId) {
      await trialFraudGuard.releaseWabaFingerprint(req.uid, reservedWabaId).catch((releaseError) =>
        console.error("[signup] فشل تحرير حجز WABA:", releaseError.message)
      );
    }
    if (err.code === "whatsapp_ownership_mismatch" || err.code === "whatsapp_ownership_failed") {
      return res.status(400).json({ error: { code: err.code, message: "تعذر إثبات ملكية رقم واتساب — أعد المحاولة من حساب Meta الصحيح" } });
    }
    console.error("[signup] فشل ربط واتساب:", err.response?.data || err.message);
    res.status(500).json({ error: { code: "whatsapp_connect_failed", message: "فشل ربط واتساب — تأكد من الصلاحيات وحاول كمان مرة" } });
  }
}));

// ===== POST /signup/activate — تفعيل نهائي + ربط البوت بالحساب =====
router.post("/signup/activate", ...requireOwnedPending(), asyncHandler(async (req, res) => {
  const pending = req.pending;

  if (!pending.clientId) {
    return res.status(400).json({ error: { code: "no_knowledge_yet", message: "لازم ترفع معرفة عبر /signup/knowledge أول" } });
  }

  await provisioning.activateClient(pending.clientId);
  await userAccounts.attachBot(req.uid, pending.clientId);
  await signups.markCompleted(pending.pendingId);
  await userAccounts.clearOnboardingState(req.uid);

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
  });
}));

module.exports = router;
