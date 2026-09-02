// إدارة بوت واحد — راجع docs/site-restructure-plan.md قسم 6. كل الراوتات هون محصورة بملكية:
// clientId لازم يكون ضمن bots[] تبع الحساب المسجّل دخوله (requireOwnedBot)، مش أي فحص
// signupToken/apiKey — هاي إدارة دائمة بعد التفعيل، مش تدفق onboarding مؤقت.

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const registry = require("../clients/registry");
const provisioning = require("../services/provisioning");
const safeWrite = require("../services/safeWrite");
const ingest = require("../services/ingest");
const urlGuard = require("../services/urlGuard");
const usageLedger = require("../services/usageLedger");
const auditLog = require("../services/auditLog");
const escalationLog = require("../services/escalationLog");
const escalationHandled = require("../services/escalationHandled");
const handoff = require("../services/handoff");
const orders = require("../services/orders");
const customers = require("../services/customers");
const { safeId } = require("../services/safe-id");
const config = require("../config");
const { validateClientConfig } = require("../services/clientConfigSchema");
const asyncHandler = require("../middleware/asyncHandler");
const { requireUserAuth } = require("./userAuth");
const userAccounts = require("../services/userAccounts");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

function detectUploadType(buffer, originalName) {
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return "excel";
  if (/\.csv$/i.test(originalName || "")) return "csv";
  return null;
}

// ownership: clientId لازم يكون بـbots[] تبع الحساب — بدون هيك 404 (مش 403) حتى ما نأكّد
// وجود/عدم وجود clientId لحساب ما إله علاقة فيه. مغلف بـasyncHandler حتى ما يصير unhandled
// rejection لو Firestore رمى استثناء (الطلب كان بيضل معلّق).
const requireOwnedBot = asyncHandler(async function requireOwnedBot(req, res, next) {
  const clientId = req.params.clientId;
  const profile = await userAccounts.getProfile(req.uid);
  if (!profile || !profile.bots.includes(clientId)) {
    return res.status(404).json({ error: { code: "bot_not_found", message: "بوت غير موجود" } });
  }
  safeWrite.assertValidClientId(clientId);
  const cfg = safeWrite.safeReadJSON(path.join(safeWrite.clientDir(clientId), "config.json"), null);
  if (!cfg) {
    return res.status(404).json({ error: { code: "bot_not_found", message: "بوت غير موجود" } });
  }
  req.clientId = clientId;
  req.clientConfig = cfg;
  next();
});

router.get("/dashboard/bots/:clientId", requireUserAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "bot-manage.html"));
});

router.get("/dashboard/bots/:clientId/api/summary", requireUserAuth, requireOwnedBot, asyncHandler(async (req, res) => {
  const cfg = req.clientConfig;
  const planDef = cfg.tier ? config.plans[cfg.tier] : null;
  const isTrial = cfg.plan === "trial";
  const cap = planDef ? planDef.monthlyMessageCap : isTrial ? config.provisioning.trialMessageCap : null;
  const usageKey = planDef ? `tier-monthly-msgs:${req.clientId}` : isTrial ? `trial-msgs:${req.clientId}` : null;
  const usage = usageKey ? await usageLedger.peek(usageKey) : { count: 0 };

  // الصوت: نفس سقف messageGate، والاستهلاك عداد ثواني شهري
  const messageGate = require("../services/messageGate");
  const voiceCapSeconds = messageGate.voiceCapSeconds(cfg);
  const voiceUsage = voiceCapSeconds != null
    ? await usageLedger.peek(`voice-seconds-monthly:${req.clientId}`)
    : { count: 0 };

  res.json({
    clientId: req.clientId,
    displayName: cfg.displayName,
    tone: cfg.tone,
    escalation: cfg.escalation,
    botPaused: Boolean(cfg.botPaused),
    channels: {
      whatsapp: { enabled: cfg.channels?.whatsapp?.enabled !== false, connected: Boolean(cfg.whatsappPhoneNumberId) },
      web: { enabled: cfg.channels?.web?.enabled !== false },
    },
    messagesThisPeriod: usage.count || 0,
    messagesCap: cap,
    tier: cfg.tier || null,
    plan: cfg.plan || "manual",
    plans: config.plans,
    topUpPacks: config.topUpPacks,
    topUpCreditsRemaining: cfg.topUpCreditsRemaining || 0,
    paymentHistory: cfg.paymentHistory || [],
    voice: {
      enabled: cfg.voice?.enabled !== false,
      minutesUsed: Math.ceil((voiceUsage.count || 0) / 60),
      minutesCap: voiceCapSeconds != null ? Math.round(voiceCapSeconds / 60) : null,
    },
    salesMode: cfg.salesMode !== false,
    businessHours: {
      enabled: Boolean(cfg.businessHours?.enabled),
      start: cfg.businessHours?.start || "09:00",
      end: cfg.businessHours?.end || "17:00",
      // بدون byDay محفوظ = كل الأيام مفتوحة (السلوك الافتراضي بـbusinessHours.js). لو محفوظ،
      // الأيام المفتوحة هي بس يلي إلها مدخل غير closed بـbyDay (أي يوم غايب = مغلق، راجع hoursForDate).
      days: cfg.businessHours?.byDay
        ? Object.keys(cfg.businessHours.byDay)
            .filter((d) => !cfg.businessHours.byDay[d]?.closed)
            .map(Number)
        : [0, 1, 2, 3, 4, 5, 6],
    },
    widget: {
      accentColor: cfg.widget?.accentColor || "#00288e",
      title: cfg.widget?.title || "",
      suggestions: cfg.widget?.suggestions || [],
    },
    integrations: {
      telegramConnected: Boolean(cfg.telegramBotToken),
      discordConnected: Boolean(cfg.discordBotToken),
    },
  });
}));

// ===== إعدادات متقدمة: صوت، وضع البيع، ساعات الدوام، تخصيص الودجت =====
// كل الحقول هون فعلياً موجودة بالنظام (راجع deepseek.js/messageGate.js/businessHours.js)
// بس كانت بس متاحة من لوحة الأدمن — هون بنفتحها للعميل نفسه يتحكم فيها بدون ما يحتاج يطلب.
router.post("/dashboard/bots/:clientId/api/settings", requireUserAuth, requireOwnedBot, asyncHandler(async (req, res) => {
  const { voiceEnabled, salesMode, businessHours, widget } = req.body || {};

  await safeWrite.updateClientConfig(req.clientId, async (existing) => {
    const updated = { ...existing };

    if (typeof voiceEnabled === "boolean") {
      updated.voice = { ...updated.voice, enabled: voiceEnabled };
    }

    if (typeof salesMode === "boolean") {
      updated.salesMode = salesMode;
    }

    if (businessHours && typeof businessHours === "object") {
      const start = /^\d{2}:\d{2}$/.test(businessHours.start) ? businessHours.start : "09:00";
      const end = /^\d{2}:\d{2}$/.test(businessHours.end) ? businessHours.end : "17:00";
      const days = Array.isArray(businessHours.days)
        ? businessHours.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        : [0, 1, 2, 3, 4, 5, 6];
      const byDay = {};
      for (let d = 0; d <= 6; d += 1) {
        if (days.includes(d)) byDay[String(d)] = { start, end };
      }
      updated.businessHours = { enabled: Boolean(businessHours.enabled), start, end, byDay };
    }

    if (widget && typeof widget === "object") {
      const accentColor = /^#[0-9a-fA-F]{6}$/.test(widget.accentColor) ? widget.accentColor : (updated.widget?.accentColor || "#00288e");
      const title = typeof widget.title === "string" ? widget.title.trim().slice(0, 60) : (updated.widget?.title || "");
      const suggestions = Array.isArray(widget.suggestions)
        ? widget.suggestions.map((s) => String(s).trim()).filter(Boolean).slice(0, 6)
        : (updated.widget?.suggestions || []);
      updated.widget = { accentColor, title, suggestions };
    }

    return updated;
  }, { validate: validateClientConfig });

  require("../services/replyCache").clear(req.clientId);

  res.json({ ok: true });
}));

// ===== طلب ترقية باقة أو شراء رصيد شحن — بدون بوابة دفع فعلياً، فقط بيبعت طلب لصاحب
// النظام عبر واتساب ليتواصل ويتمّم الدفع يدويًا (نفس أسلوب الفوترة الحالي بالمشروع) =====
router.post("/dashboard/bots/:clientId/api/billing-request", requireUserAuth, requireOwnedBot, asyncHandler(async (req, res) => {
  const { kind, target } = req.body || {};
  const cfg = req.clientConfig;

  let details;
  if (kind === "upgrade") {
    const plan = config.plans[target];
    if (!plan) {
      return res.status(400).json({ error: { code: "invalid_plan", message: "باقة غير معروفة" } });
    }
    details = `ترقية للباقة "${target}" ($${plan.price}/شهر — ${plan.monthlyMessageCap} رسالة)`;
  } else if (kind === "topup") {
    const pack = config.topUpPacks[target];
    if (!pack) {
      return res.status(400).json({ error: { code: "invalid_pack", message: "باقة شحن غير معروفة" } });
    }
    details = `شحن رصيد "${target}" (${pack.credits} رسالة — $${pack.priceUsd})`;
  } else {
    return res.status(400).json({ error: { code: "invalid_kind", message: "kind لازم يكون upgrade أو topup" } });
  }

  auditLog.record("billing_request", req.clientId, { kind, target, byUser: req.uid });

  if (config.provisioning.operatorWhatsapp && config.whatsapp.notifySenderPhoneNumberId) {
    const whatsapp = require("../services/whatsapp");
    const text =
      `💳 طلب فوترة جديد\n` +
      `البوت: ${cfg.displayName} (${req.clientId})\n` +
      `الباقة الحالية: ${cfg.tier || cfg.plan || "—"}\n` +
      `الطلب: ${details}\n` +
      `إيميل التواصل: ${cfg.contactEmail || "—"}\n` +
      `واتساب: ${cfg.escalation?.notifyWhatsapp || "—"}`;
    whatsapp
      .sendTextMessage(config.provisioning.operatorWhatsapp, config.whatsapp.notifySenderPhoneNumberId, text)
      .catch((err) => console.error("[billing-request] فشل إشعار المشغّل:", err.response?.data || err.message));
  }

  res.json({ ok: true });
}));

// ===== قنوات إضافية: تلغرام وديسكورد — نفس منطق تسجيل الأدمن بالضبط (admin.js) =====
router.post("/dashboard/bots/:clientId/api/integrations", requireUserAuth, requireOwnedBot, asyncHandler(async (req, res) => {
  const { telegramBotToken, discordBotToken } = req.body || {};
  let updatedTelegram = false;
  let updatedDiscord = false;

  const finalConfig = await safeWrite.updateClientConfig(req.clientId, async (existing) => {
    const updated = { ...existing };
    updatedTelegram = false;
    updatedDiscord = false;

    if (typeof telegramBotToken === "string") {
      updated.telegramBotToken = telegramBotToken.trim() || undefined;
      if (updated.telegramBotToken && !existing.telegramWebhookSecret) {
        updated.telegramWebhookSecret = crypto.randomBytes(24).toString("hex");
      }
      if (updated.telegramBotToken !== existing.telegramBotToken) updatedTelegram = true;
    }
    if (typeof discordBotToken === "string") {
      updated.discordBotToken = discordBotToken.trim() || undefined;
      if (updated.discordBotToken !== existing.discordBotToken) updatedDiscord = true;
    }
    return updated;
  }, { validate: validateClientConfig });

  if (
    updatedTelegram && finalConfig.telegramBotToken &&
    config.provisioning.publicBaseUrl.startsWith("https://")
  ) {
    const telegram = require("../services/telegram");
    telegram
      .setWebhook(
        finalConfig.telegramBotToken,
        `${config.provisioning.publicBaseUrl}/webhook/telegram/${req.clientId}`,
        finalConfig.telegramWebhookSecret || ""
      )
      .then(() => console.log(`[telegram] تسجّل ويبهوك "${req.clientId}" بعد تحديث العميل`))
      .catch((err) => console.error(`[telegram] فشل تسجيل "${req.clientId}" من العميل:`, err.response?.data || err.message));
  }

  if (updatedDiscord) {
    try {
      require("../services/discordGateway").syncAll();
    } catch (err) {
      console.error("[discord] فشلت المزامنة من العميل:", err.message);
    }
  }

  res.json({ ok: true });
}));

// ===== معلومات أساسية =====
router.post("/dashboard/bots/:clientId/api/info", requireUserAuth, requireOwnedBot, asyncHandler(async (req, res) => {
  const { displayName, tone, escalationPhone, escalationContactMethod, notifyWhatsapp } = req.body || {};

  if (!displayName || String(displayName).trim().length < 2) {
    return res.status(400).json({ error: { code: "invalid_display_name", message: "اسم البوت مطلوب (حرفين على الأقل)" } });
  }
  if (!escalationContactMethod || !String(escalationContactMethod).trim()) {
    return res.status(400).json({ error: { code: "invalid_contact_method", message: "طريقة التواصل مطلوبة" } });
  }

  await safeWrite.updateClientConfig(req.clientId, async (existing) => {
    return {
      ...existing,
      displayName: String(displayName).trim(),
      tone: tone ? String(tone).trim() : existing.tone,
      escalation: {
        ...existing.escalation,
        phone: escalationPhone ? String(escalationPhone).trim() : existing.escalation?.phone,
        contactMethod: String(escalationContactMethod).trim(),
        notifyWhatsapp: notifyWhatsapp ? String(notifyWhatsapp).trim() : existing.escalation?.notifyWhatsapp,
      },
    };
  }, { validate: validateClientConfig });

  require("../services/replyCache").clear(req.clientId);

  res.json({ ok: true });
}));

// ===== استبدال المعرفة =====
router.post("/dashboard/bots/:clientId/api/knowledge", requireUserAuth, requireOwnedBot, upload.single("file"), asyncHandler(async (req, res) => {
  let content;
  let sourceType;

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
    } else if (req.body?.source === "website") {
      // websiteUrl الخام ما بينكتب بـconfig.json أبداً (راجع provisioning.js defaultConfig) —
      // بس أصل الرابط (origin) محفوظ بـallowedOrigins لو المصدر الأصلي كان موقع، أو لو
      // العميل بدّل مصدره لموقع سابقاً عبر نفس هالـendpoint. source.value بس اسم ملف لو
      // المصدر الأصلي كان PDF/Excel، مش رابط أبداً — ما لازم يُستخدم هون.
      const websiteUrl = req.clientConfig.allowedOrigins?.[0];
      if (!websiteUrl) {
        return res.status(400).json({ error: { code: "no_website_url", message: "ما في رابط موقع محفوظ لهالبوت — استخدم رفع ملف بدل هيك" } });
      }
      content = await ingest.ingestWebsite(websiteUrl, { fetch: urlGuard.safeGet });
      sourceType = "website";
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

  await provisioning.replaceKnowledge(req.clientId, content, `source-${sourceType}.md`);
  res.json({ warnings: check.warnings, stats: check.stats, previewExcerpt: content.slice(0, 2000) });
}));

// ===== قنوات التشغيل: إيقاف كامل / واتساب بس / موقع بس =====
router.post("/dashboard/bots/:clientId/api/channels", requireUserAuth, requireOwnedBot, asyncHandler(async (req, res) => {
  const { botPaused, whatsappEnabled, webEnabled } = req.body || {};

  await safeWrite.updateClientConfig(req.clientId, async (existing) => {
    return {
      ...existing,
      botPaused: typeof botPaused === "boolean" ? botPaused : Boolean(existing.botPaused),
      channels: {
        ...existing.channels,
        whatsapp: { ...existing.channels?.whatsapp, enabled: typeof whatsappEnabled === "boolean" ? whatsappEnabled : existing.channels?.whatsapp?.enabled !== false },
        web: { ...existing.channels?.web, enabled: typeof webEnabled === "boolean" ? webEnabled : existing.channels?.web?.enabled !== false },
      },
    };
  }, { validate: validateClientConfig });

  res.json({ ok: true });
}));

// ===== فصل واتساب نهائياً =====
router.post("/dashboard/bots/:clientId/api/disconnect-whatsapp", requireUserAuth, requireOwnedBot, asyncHandler(async (req, res) => {
  await safeWrite.updateClientConfig(req.clientId, async (existing) => {
    const { whatsappPhoneNumberId, whatsappBusinessAccountId, whatsappRegistrationPin, ...rest } = existing;
    return rest;
  }, { validate: validateClientConfig });
  res.json({ ok: true });
}));

// ===== حذف البوت (soft delete، 30 يوم استرجاع) =====
// تأكيد كلمة السر بيصير بالفرونت إند مباشرة عبر Firebase reauthenticateWithCredential —
// Admin SDK ما بيقدر يتحقق من كلمات سر أصلاً (بتصميم Firebase، تعمّد أمني). وصول هالطلب هون
// أصلاً معناه المستخدم أثبت كلمة سره لتوّه + كتب اسم البوت بالضبط بالفرونت إند (تأكيد مزدوج).
router.delete("/dashboard/bots/:clientId", requireUserAuth, requireOwnedBot, asyncHandler(async (req, res) => {
  const { confirmName } = req.body || {};
  if (confirmName !== req.clientConfig.displayName) {
    return res.status(400).json({ error: { code: "name_mismatch", message: "اسم البوت ما طابق — الحذف اتلغى" } });
  }

  const clientDir = safeWrite.clientDir(req.clientId);
  const archiveDir = path.join(__dirname, "..", "..", "data", "deleted-bots", `${req.clientId}-${Date.now()}`);

  // النقل والأرشفة جوا قفل العميل — بدون هيك، رسالة حية واصلة بنفس اللحظة كانت ممكن
  // تكتب على مجلد اننقل للتو (rename خارج القفل سابقًا = سباق حقيقي).
  await safeWrite.withClientLock(req.clientId, async () => {
    fs.mkdirSync(path.dirname(archiveDir), { recursive: true });
    fs.renameSync(clientDir, archiveDir);
  });

  const profile = await userAccounts.getProfile(req.uid);
  const remainingBots = profile.bots.filter((id) => id !== req.clientId);
  const { db } = require("../services/firebaseAdmin");
  await db.collection("users").doc(req.uid).update({ bots: remainingBots });

  auditLog.record("delete_bot", req.clientId, { archivedTo: path.basename(archiveDir), byUser: req.uid });
  res.json({ ok: true });
}));

// ===== تقارير البوت — أرقام حقيقية من data/ (زبائن، تصعيدات، طلبات) =====
router.get("/dashboard/bots/:clientId/api/report", requireUserAuth, requireOwnedBot, asyncHandler(async (req, res) => {
  const clientId = req.clientId;
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const customersDir = path.join(safeWrite.dataDir(clientId), "customers");
  let uniqueCustomers = 0;
  let activeLast7Days = 0;
  let conversationsLast30Days = 0;
  const questionCounts = new Map(); // سؤال مُطبّع -> عدد

  if (fs.existsSync(customersDir)) {
    // نفس استبعاد ملفات التجربة يلي بـadmin analytics (preview/admin-preview/smoke-test مو زبائن حقيقيين)
    const files = fs
      .readdirSync(customersDir)
      .filter(
        (f) =>
          f.endsWith(".json") &&
          f !== "admin-preview.json" &&
          !f.startsWith("preview-") &&
          !f.startsWith("smoke-test-")
      );
    uniqueCustomers = files.length;

    for (const f of files) {
      const profile = safeWrite.safeReadJSON(path.join(customersDir, f), null);
      if (!profile) continue;

      if (profile.lastMessageAt && now - new Date(profile.lastMessageAt).getTime() <= SEVEN_DAYS_MS) {
        activeLast7Days += 1;
      }
      if (profile.firstSeenAt && now - new Date(profile.firstSeenAt).getTime() <= THIRTY_DAYS_MS) {
        conversationsLast30Days += 1;
      }

      // أكثر الأسئلة: رسائل الزبون من آخر 8 تبادلات محفوظة لكل زبون (هاد كل يلي بنحفظ عمدًا)
      for (const turn of profile.history || []) {
        if (turn.role !== "user" || typeof turn.content !== "string") continue;
        const normalized = turn.content.trim().toLowerCase().slice(0, 80);
        if (normalized.length < 3) continue;
        questionCounts.set(normalized, (questionCounts.get(normalized) || 0) + 1);
      }
    }
  }

  const topQuestions = [...questionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([question, count]) => ({ question, count }));

  const escalations = escalationLog.readRecent(clientId, 500);
  const handledIds = new Set(escalationHandled.getHandledIds(clientId));
  const unhandledEscalations = escalations.filter((e) => !handledIds.has(e.id)).length;

  res.json({
    uniqueCustomers,
    activeLast7Days,
    conversationsLast30Days,
    topQuestions,
    totalOrders: orders.readOrders(clientId).length,
    escalationsTotal: escalations.length,
    escalationsUnhandled: unhandledEscalations,
  });
}));

// ===== سجل المحادثات: لائحة الزبائن + عرض محادثة + تصدير Excel =====

function isTestOrPreviewProfile(fileName) {
  return (
    fileName === "admin-preview.json" ||
    fileName.startsWith("preview-") ||
    fileName.startsWith("smoke-test-")
  );
}

router.get("/dashboard/bots/:clientId/api/conversations", requireUserAuth, requireOwnedBot, asyncHandler(async (req, res) => {
  const customersDir = path.join(safeWrite.dataDir(req.clientId), "customers");
  const list = [];
  if (fs.existsSync(customersDir)) {
    for (const f of fs.readdirSync(customersDir)) {
      if (!f.endsWith(".json") || isTestOrPreviewProfile(f)) continue;
      const profile = safeWrite.safeReadJSON(path.join(customersDir, f), null);
      if (!profile?.userId) continue;
      list.push({
        userId: profile.userId,
        firstSeenAt: profile.firstSeenAt || null,
        lastMessageAt: profile.lastMessageAt || null,
        lastMessage: profile.lastMessage || "",
        exchanges: Math.floor((profile.history?.length || 0) / 2),
      });
    }
  }
  list.sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
  res.json({ conversations: list });
}));

// userId بالمسار — منعطف عبر نفس safeId يلي بيكتب الملفات، فالقراءة محصورة بمجلد transcripts
router.get(
  "/dashboard/bots/:clientId/api/conversations/:userId/transcript",
  requireUserAuth,
  requireOwnedBot,
  asyncHandler(async (req, res) => {
    res.json({ transcript: customers.readTranscript(req.clientId, decodeURIComponent(req.params.userId)) });
  })
);

router.get(
  "/dashboard/bots/:clientId/api/conversations/export.xlsx",
  requireUserAuth,
  requireOwnedBot,
  asyncHandler(async (req, res) => {
    const ExcelJS = require("exceljs");
    const workbook = new ExcelJS.Workbook();

    const summary = workbook.addWorksheet("الملخص");
    summary.columns = [
      { header: "معرف الزبون", key: "userId", width: 28 },
      { header: "أول ظهور", key: "firstSeenAt", width: 22 },
      { header: "آخر نشاط", key: "lastMessageAt", width: 22 },
      { header: "آخر رسالة", key: "lastMessage", width: 50 },
      { header: "تبادلات محفوظة", key: "exchanges", width: 16 },
    ];

    const log = workbook.addWorksheet("المحادثات الكاملة");
    log.columns = [
      { header: "معرف الزبون", key: "userId", width: 28 },
      { header: "التاريخ والوقت", key: "at", width: 22 },
      { header: "سؤال الزبون", key: "user", width: 60 },
      { header: "رد البوت", key: "bot", width: 60 },
    ];

    const customersDir = path.join(safeWrite.dataDir(req.clientId), "customers");
    if (fs.existsSync(customersDir)) {
      for (const f of fs.readdirSync(customersDir)) {
        if (!f.endsWith(".json") || isTestOrPreviewProfile(f)) continue;
        const profile = safeWrite.safeReadJSON(path.join(customersDir, f), null);
        if (!profile?.userId) continue;

        summary.addRow({
          userId: profile.userId,
          firstSeenAt: profile.firstSeenAt || "",
          lastMessageAt: profile.lastMessageAt || "",
          lastMessage: profile.lastMessage || "",
          exchanges: Math.floor((profile.history?.length || 0) / 2),
        });

        // النسخة الكاملة من ملفات transcripts (وليس آخر 8 تبادلات فقط)
        const transcript = customers.readTranscript(req.clientId, profile.userId, 5000);
        for (const line of transcript) {
          log.addRow({ userId: profile.userId, at: line.at, user: line.user, bot: line.bot });
        }
      }
    }

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="conversations-${req.clientId}-${new Date().toISOString().slice(0, 10)}.xlsx"`
    );
    auditLog.record("export_conversations", req.clientId, {});
    res.send(Buffer.from(await workbook.xlsx.writeBuffer()));
  })
);

// ===== التدخل البشري المباشر (Live Agent Takeover) =====

router.get("/dashboard/bots/:clientId/api/takeover-status", requireUserAuth, requireOwnedBot, asyncHandler(async (req, res) => {
  const pausedList = handoff.getPausedConversations(req.clientId);
  res.json({ pausedUsers: pausedList });
}));

router.post("/dashboard/bots/:clientId/api/pause-user", requireUserAuth, requireOwnedBot, asyncHandler(async (req, res) => {
  const { userId, hours } = req.body || {};
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: { code: "invalid_input", message: "معرف الزبون مطلوب" } });
  }
  const pauseHours = Number(hours) > 0 ? Number(hours) : 24;
  handoff.pauseBotUser(req.clientId, userId.trim(), pauseHours);
  auditLog.record("pause_bot_user", req.clientId, { userId: userId.trim(), hours: pauseHours });
  res.json({ ok: true, message: `تم إيقاف البوت للزبون ${userId.trim()} لمدة ${pauseHours} ساعة` });
}));

router.post("/dashboard/bots/:clientId/api/resume-user", requireUserAuth, requireOwnedBot, asyncHandler(async (req, res) => {
  const { userId } = req.body || {};
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: { code: "invalid_input", message: "معرف الزبون مطلوب" } });
  }
  handoff.resumeBotUser(req.clientId, userId.trim());
  auditLog.record("resume_bot_user", req.clientId, { userId: userId.trim() });
  res.json({ ok: true, message: `تم إعادة تفعيل البوت للزبون ${userId.trim()}` });
}));

module.exports = router;


