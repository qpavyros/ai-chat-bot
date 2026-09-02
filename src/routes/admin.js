// لوحة تحكم المشغّل (/admin) — داخلية بس، لصاحب المشروع نفسه، مش للعملاء. بُنيت حسب توصية
// مجلس LLM (2026-08-09، council-transcript-20260809-140000.md): auth حقيقي + rate limiting
// على الدخول + كل كتابة تمر عبر safeWrite.js (قفل + نسخة احتياطية + كتابة ذرّية) + audit log.
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");
const adminAuth = require("../services/adminAuth");
const safeWrite = require("../services/safeWrite");
const { parseCookies, setSessionCookie, clearSessionCookie, clientIp } = require("../middleware/sessionCookies");
const auditLog = require("../services/auditLog");
const replyCache = require("../services/replyCache");
const provisioning = require("../services/provisioning");
const apiKeys = require("../services/apiKeys");
const escalationLog = require("../services/escalationLog");
const escalationHandled = require("../services/escalationHandled");
const orders = require("../services/orders");
const appointments = require("../services/appointments");
const stats = require("../services/stats");
const registry = require("../clients/registry");
const customers = require("../services/customers");
const deepseek = require("../services/deepseek");
const handoff = require("../services/handoff");

// معرّف زبون ثابت لمحادثات التجربة من لوحة الأدمن — بادئة "admin-preview" مميّزة عمدًا
// حتى نقدر نستثنيها من إحصائيات /admin/api/analytics (زبون تجربة مش زبون حقيقي).
const ADMIN_PREVIEW_USER_ID = "admin-preview";
const { validateClientConfig, pickClientConfigFields } = require("../services/clientConfigSchema");

const router = express.Router();
const CLIENTS_DIR = path.join(__dirname, "..", "clients");
const SESSION_COOKIE = "admin_session";

// أي endpoint بيقبل clientId من الطلب لازم يتحقق منه بشكل مستقل (نفس شرط safeWrite) —
// بدون هيك، مسار مثل :id=..%2f..%2fdata ممكن يقرأ ملفات خارج مجلد العملاء (path traversal).
function validClientIdOr400(req, res) {
  try {
    safeWrite.assertValidClientId(req.params.id);
    return true;
  } catch {
    res.status(400).json({ error: "معرّف عميل غير صالح" });
    return false;
  }
}

const { requireSameOrigin } = require("../middleware/requestSecurity");

// بوابة API — أي endpoint تحت /admin/api لازم جلسة صالحة، وإلا 401 (الواجهة بتتصرف بالتحويل لتسجيل الدخول)
function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  if (!adminAuth.validateSession(cookies[SESSION_COOKIE])) {
    return res.status(401).json({ error: "غير مسجّل دخول" });
  }
  requireSameOrigin(req, res, next);
}

// ---------- صفحات ----------

router.get("/admin/login", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "admin-pages", "admin-login.html"));
});

router.get("/admin", (req, res) => {
  const cookies = parseCookies(req);
  if (!adminAuth.validateSession(cookies[SESSION_COOKIE])) {
    return res.redirect("/admin/login");
  }
  res.sendFile(path.join(__dirname, "..", "admin-pages", "admin-dashboard.html"));
});

// النسخة القديمة — كانت فيها التعديل/المعرفة/الإعداد/المعاينة قبل ما تنبني صفحة العميل
// المستقلة تحت. باقية بس كـfallback مؤقت (إضافة عميل جديد، صندوق التصعيدات، التحليلات)
// لحد ما تنبنى هني كمان كصفحات مستقلة.
router.get("/admin/legacy", (req, res) => {
  const cookies = parseCookies(req);
  if (!adminAuth.validateSession(cookies[SESSION_COOKIE])) {
    return res.redirect("/admin/login");
  }
  res.sendFile(path.join(__dirname, "..", "admin-pages", "admin-legacy.html"));
});

// صفحة عميل واحد — رابط حقيقي بمعرّف العميل بالمسار (مش مودال). الـid بينقرا من الرابط
// بالـJS نفسه (زي bot-manage.html بلوحة الزبون)، مش هون — الملف نفسه ثابت لأي عميل.
router.get("/admin/client/:id", (req, res) => {
  const cookies = parseCookies(req);
  if (!adminAuth.validateSession(cookies[SESSION_COOKIE])) {
    return res.redirect("/admin/login");
  }
  res.sendFile(path.join(__dirname, "..", "admin-pages", "admin-client-detail.html"));
});

router.get("/admin/escalations", (req, res) => {
  const cookies = parseCookies(req);
  if (!adminAuth.validateSession(cookies[SESSION_COOKIE])) {
    return res.redirect("/admin/login");
  }
  res.sendFile(path.join(__dirname, "..", "admin-pages", "admin-escalations.html"));
});

router.get("/admin/analytics", (req, res) => {
  const cookies = parseCookies(req);
  if (!adminAuth.validateSession(cookies[SESSION_COOKIE])) {
    return res.redirect("/admin/login");
  }
  res.sendFile(path.join(__dirname, "..", "admin-pages", "admin-analytics.html"));
});

router.get("/admin/add-client", (req, res) => {
  const cookies = parseCookies(req);
  if (!adminAuth.validateSession(cookies[SESSION_COOKIE])) {
    return res.redirect("/admin/login");
  }
  res.sendFile(path.join(__dirname, "..", "admin-pages", "admin-add-client.html"));
});

// ---------- مصادقة ----------

router.post("/admin/login", express.json(), (req, res) => {
  const ip = clientIp(req);
  if (adminAuth.isLocked(ip)) {
    return res.status(429).json({ error: "محاولات كتيرة غلط — جرب بعد 15 دقيقة" });
  }

  const { password } = req.body || {};
  if (!adminAuth.checkPassword(password)) {
    adminAuth.recordFailure(ip);
    auditLog.record("login_failed", null, { ip });
    return res.status(401).json({ error: "كلمة سر غلط" });
  }

  adminAuth.recordSuccess(ip);
  const token = adminAuth.createSession();
  setSessionCookie(req, res, {
    name: SESSION_COOKIE,
    value: token,
    maxAgeSeconds: config.admin.sessionTtlHours * 60 * 60,
  });
  auditLog.record("login", null, { ip });
  res.json({ ok: true });
});

router.post("/admin/logout", requireSameOrigin, (req, res) => {
  const cookies = parseCookies(req);
  adminAuth.destroySession(cookies[SESSION_COOKIE]);
  clearSessionCookie(res, SESSION_COOKIE);
  res.json({ ok: true });
});

// ---------- قراءة بيانات العملاء (مباشرة من القرص، بدون المرور بـregistry.js —
// ما بدنا نحمّل نص المعرفة الكامل هون، بس بيانات ملخّصة للعرض) ----------

function readClientConfig(clientId) {
  const configPath = path.join(CLIENTS_DIR, clientId, "config.json");
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function listKnowledgeFiles(clientId) {
  const dir = path.join(CLIENTS_DIR, clientId);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { fileName: f, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
    });
}

function summarize(clientId) {
  const cfg = readClientConfig(clientId);
  if (!cfg) return null;
  return {
    id: clientId,
    displayName: cfg.displayName,
    status: cfg.status || "active", // بدون status صراحة = عميل يدوي قديم، دايمًا نشط (نفس منطق registry.js)
    plan: cfg.plan || "manual",
    expiresAt: cfg.trialExpiresAt || cfg.subscriptionExpiresAt || null,
    knowledgeSource: cfg.source?.value || cfg.knowledgeSourceLabel || null,
    knowledgeFiles: listKnowledgeFiles(clientId),
    hasWhatsapp: Boolean(cfg.whatsappPhoneNumberId),
    createdAt: cfg.createdAt || null,
    onboardingChecklist: cfg.onboardingChecklist || {},
    tier: cfg.tier || null,
    referralCode: cfg.referralCode || null,
    referredByClientId: cfg.referredByClientId || null,
    referralRewarded: Boolean(cfg.referralRewarded),
    paymentCount: (cfg.paymentHistory || []).length,
    referralRewardEligible:
      Boolean(cfg.referredByClientId) && !cfg.referralRewarded && hasConsecutivePayments(cfg.paymentHistory),
  };
}

// ---------- API: عملاء ----------

router.get("/admin/api/clients", requireAuth, (req, res) => {
  const clients = safeWrite.listClientIds().map(summarize).filter(Boolean);

  // نمرّ مرة تانية لنعلّم كل عميل "مُحيل" بلائحة العملاء المُحالين المستحقين مكافأة منه —
  // معلومة عابرة للعملاء (referredByClientId موجود بعميل تاني)، أبسط تحسب هون مرة وحدة
  // بدل ما تتكرر بكل صف بالواجهة.
  const byId = new Map(clients.map((c) => [c.id, c]));
  for (const c of clients) {
    if (c.referralRewardEligible && byId.has(c.referredByClientId)) {
      const referrer = byId.get(c.referredByClientId);
      referrer.pendingReferralRewards = referrer.pendingReferralRewards || [];
      referrer.pendingReferralRewards.push({ clientId: c.id, displayName: c.displayName });
    }
  }

  clients.sort((a, b) => a.displayName.localeCompare(b.displayName, "ar"));
  res.json({ clients });
});

router.get("/admin/api/clients/:id", requireAuth, (req, res) => {
  if (!validClientIdOr400(req, res)) return;
  const cfg = readClientConfig(req.params.id);
  if (!cfg) return res.status(404).json({ error: "عميل غير موجود" });

  const knowledgePath = path.join(CLIENTS_DIR, req.params.id, "knowledge.md");
  const knowledge = fs.existsSync(knowledgePath) ? fs.readFileSync(knowledgePath, "utf8") : "";

  res.json({ config: cfg, knowledge, knowledgeFiles: listKnowledgeFiles(req.params.id) });
});

router.post("/admin/api/clients", requireAuth, express.json(), (req, res) => {
  const { companyName, contactEmail, escalationPhone, notifyWhatsapp, knowledgeSourceLabel, knowledgeText, expiresAt, tier, referredByClientId } =
    req.body || {};

  if (!companyName || !String(companyName).trim()) {
    return res.status(400).json({ error: "اسم الشركة مطلوب" });
  }
  if (!escalationPhone || !String(escalationPhone).trim()) {
    return res.status(400).json({ error: "رقم تواصل التصعيد مطلوب" });
  }

  if (referredByClientId && !readClientConfig(referredByClientId)) {
    return res.status(400).json({ error: `عميل المُحيل غير موجود: ${referredByClientId}` });
  }

  const slug = provisioning.generateUniqueSlug(companyName);
  const cfg = {
    id: slug,
    displayName: companyName,
    language: "ar-LB",
    tone: "ودود، مباشر، جمل قصيرة، يرد باللهجة اللبنانية إذا كتب الزبون فيها",
    escalation: {
      phone: escalationPhone,
      contactMethod: `التواصل مع فريق ${companyName} مباشرة`,
      notifyWhatsapp: notifyWhatsapp || "",
    },
    contactEmail: contactEmail || null,
    status: "active",
    plan: "manual",
    tier: ["starter", "growth", "pro"].includes(tier) ? tier : null,
    subscriptionExpiresAt: expiresAt || null,
    knowledgeSourceLabel: knowledgeSourceLabel || null,
    // كود إحالة تلقائي — بادئة ثابتة + جزء من الـslug، يكفي كمعرّف يشاركه صاحب العمل
    // شفهيًا أو عبر واتساب، بدون ما يحتاج يتذكر UUID.
    referralCode: `REF-${slug}`.toUpperCase(),
    referredByClientId: referredByClientId || null,
    referralRewarded: false,
    paymentHistory: [],
    createdAt: new Date().toISOString(),
  };

  const schemaError = validateClientConfig(cfg);
  if (schemaError) return res.status(400).json({ error: schemaError });

  // pk_ فورًا وقت الإنشاء — قبل كان يترك null، يعني كل عميل جديد يعتمد بالكامل على
  // WEB_WIDGET_KEY المشترك القديم لحد ما حدا يتذكر يشغّل npm run key يدويًا (نادرًا ما بيصير).
  const publicKey = apiKeys.generatePublicKey();

  try {
    safeWrite.createClientDirAtomic(slug, {
      "config.json": JSON.stringify(cfg, null, 2),
      "knowledge.md": knowledgeText || `# قاعدة معرفة — ${companyName}\n\n(لسا فاضية — عدّلها من هون أو من الملف مباشرة)\n`,
      "auth.json": JSON.stringify({ publicKey, apiKeys: [] }, null, 2),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  auditLog.record("create_client", slug, { companyName });
  res.status(201).json({ id: slug, publicKey });
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

router.put("/admin/api/clients/:id", requireAuth, express.json(), async (req, res) => {
  if (!validClientIdOr400(req, res)) return;
  const { id } = req.params;
  
  let oldTelegramToken, oldDiscordToken, newTelegramToken, newDiscordToken, updatedWebhookSecret;

  try {
    await safeWrite.updateClientConfig(id, (existing) => {
      oldTelegramToken = existing.telegramBotToken;
      oldDiscordToken = existing.discordBotToken;

      const incoming = pickClientConfigFields(req.body);
      if (incoming.telegramBotToken && !existing.telegramWebhookSecret && !incoming.telegramWebhookSecret) {
        incoming.telegramWebhookSecret = crypto.randomBytes(24).toString("hex");
      }

      const updated = { ...existing, ...incoming, id };
      
      // preservenestedunmodifiedchannels/options
      for (const key of ['channels', 'options', 'escalation', 'appointments', 'orders', 'onboardingChecklist', 'businessHours', 'widget', 'voice']) {
        if (incoming[key] && isPlainObject(incoming[key]) && existing[key] && isPlainObject(existing[key])) {
          updated[key] = { ...existing[key], ...incoming[key] };
        }
      }

      newTelegramToken = updated.telegramBotToken;
      newDiscordToken = updated.discordBotToken;
      updatedWebhookSecret = updated.telegramWebhookSecret;

      return updated;
    }, { validate: validateClientConfig });
  } catch (err) {
    if (err.message === 'Missing client' || err.message.includes('غير موجود')) return res.status(404).json({ error: "عميل غير موجود" });
    if (err.status) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }

  replyCache.clear(id);
  auditLog.record("update_config", id, { fields: Object.keys(req.body || {}) });

  if (
    newTelegramToken &&
    newTelegramToken !== oldTelegramToken &&
    config.provisioning.publicBaseUrl.startsWith("https://")
  ) {
    const telegram = require("../services/telegram");
    telegram
      .setWebhook(
        newTelegramToken,
        `${config.provisioning.publicBaseUrl}/webhook/telegram/${id}`,
        updatedWebhookSecret || ""
      )
      .then(() => console.log(`[telegram] تسجّل ويبهوك "${id}" بعد تحديث الأدمن`))
      .catch((err) => console.error(`[telegram] فشل تسجيل "${id}" من الأدمن:`, err.response?.data || err.message));
  }

  if (newDiscordToken !== oldDiscordToken) {
    try {
      require("../services/discordGateway").syncAll();
    } catch (err) {
      console.error("[discord] فشلت المزامنة من الأدمن:", err.message);
    }
  }

  res.json({ ok: true });
});

router.put("/admin/api/clients/:id/knowledge", requireAuth, express.json({ limit: "2mb" }), async (req, res) => {
  if (!validClientIdOr400(req, res)) return;
  const { id } = req.params;
  const { content } = req.body || {};
  if (typeof content !== "string") return res.status(400).json({ error: "content (نص) مطلوب" });

  try {
    await safeWrite.safeWriteFile(id, "knowledge.md", content);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  replyCache.clear(id);
  auditLog.record("update_knowledge", id, { chars: content.length });
  res.json({ ok: true });
});

router.post("/admin/api/clients/:id/renew", requireAuth, express.json(), async (req, res) => {
  if (!validClientIdOr400(req, res)) return;
  const { id } = req.params;
  const { expiresAt, status } = req.body || {};

  try {
    const billing = require("../services/billing");
    await safeWrite.updateClientConfig(id, (existing) => {
      const updated = { ...existing };
      if (expiresAt !== undefined) {
        const parsedDate = billing.parseExpiry(expiresAt);
        if (updated.plan === "trial") {
          updated.trialExpiresAt = parsedDate ? parsedDate.toISOString() : null;
        } else {
          updated.subscriptionExpiresAt = parsedDate ? parsedDate.toISOString() : null;
        }
      }
      if (status) updated.status = status;
      return updated;
    }, { validate: validateClientConfig });
  } catch (err) {
    if (err.message === 'Missing client' || err.message.includes('غير موجود')) return res.status(404).json({ error: "عميل غير موجود" });
    if (err.status) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }

  replyCache.clear(id);
  auditLog.record("renew", id, { expiresAt, status });
  res.json({ ok: true });
});

router.post("/admin/api/clients/:id/record-payment", requireAuth, express.json(), async (req, res) => {
  if (!validClientIdOr400(req, res)) return;
  const { id } = req.params;
  const { operationId } = req.body || {};
  const opId = req.headers['idempotency-key'] || operationId;

  if (!opId) return res.status(400).json({ error: "Idempotency key required" });

  try {
    const billing = require("../services/billing");
    const result = await billing.recordPayment(id, opId);
    replyCache.clear(id);
    auditLog.record("record_payment", id, { nextExpiry: result.nextExpiry, amountUsd: result.amountUsd });
    // Remove amountUsd from result before returning to client if needed, but it's fine.
    const responseData = { ...result };
    delete responseData.amountUsd;
    res.json(responseData);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post("/admin/api/clients/:id/apply-referral-reward", requireAuth, async (req, res) => {
  if (!validClientIdOr400(req, res)) return;
  const { id } = req.params;

  try {
    const billing = require("../services/billing");
    const result = await billing.applyReferralReward(id);
    replyCache.clear(result.referrerId);
    auditLog.record("referral_reward_applied", result.referrerId, { referredClientId: id, nextExpiry: result.nextExpiry });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post("/admin/api/clients/:id/topup", requireAuth, express.json(), async (req, res) => {
  if (!validClientIdOr400(req, res)) return;
  const { id } = req.params;
  const { pack, operationId } = req.body || {};
  const opId = req.headers['idempotency-key'] || operationId;

  const credits = require("../services/credits");
  if (!credits.packDef(pack)) {
    return res.status(400).json({ error: `باقة غير معروفة: ${pack}. المتاح: small, medium` });
  }
  
  if (!opId) return res.status(400).json({ error: "Idempotency key required" });

  try {
    const result = await credits.addCredits(id, pack, opId);
    auditLog.record("topup_credits", id, { pack, added: result.added, balance: result.balance });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get("/admin/api/audit-log", requireAuth, (req, res) => {
  res.json({ entries: auditLog.readRecent(200) });
});

// إحصائيات يومية (آخر 14 يوم) + تقدير تكلفة DeepSeek من بداية الشهر
router.get("/admin/api/stats", requireAuth, (req, res) => {
  const snapshot = stats.snapshot();
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    const c = snapshot[key] || {};
    days.push({
      date: key,
      messages: c.messages || 0,
      llmCalls: c.llmCalls || 0,
      cacheHits: c.cacheHits || 0,
      escalations: c.escalations || 0,
      offHours: c.offHours || 0,
      tokensIn: c.tokensIn || 0,
      tokensOut: c.tokensOut || 0,
      costUsd:
        ((c.tokensIn || 0) / 1e6) * config.deepseek.priceInPerMillion +
        ((c.tokensOut || 0) / 1e6) * config.deepseek.priceOutPerMillion,
    });
  }

  // تكلفة من بداية الشهر الحالي
  let monthCost = 0;
  const monthPrefix = new Date().toISOString().slice(0, 7);
  for (const [date, c] of Object.entries(snapshot)) {
    if (!date.startsWith(monthPrefix)) continue;
    monthCost +=
      ((c.tokensIn || 0) / 1e6) * config.deepseek.priceInPerMillion +
      ((c.tokensOut || 0) / 1e6) * config.deepseek.priceOutPerMillion;
  }

  res.json({ days, monthToDateCostUsd: Math.round(monthCost * 100) / 100 });
});

// ---------- API: تحليلات مُجمّعة لكل العملاء ----------
// أرقام حقيقية بس من بيانات موجودة أصلاً — ما منختلق "إجمالي رسائل من البداية" (customers.js
// بيحتفظ بآخر 8 تبادلات بس لكل زبون، مش تاريخ كامل)، فبدلها منعرض "نشط آخر 7 أيام" كمؤشر حي.

router.get("/admin/api/analytics", requireAuth, (req, res) => {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const analytics = safeWrite
    .listClientIds()
    .map((clientId) => {
      const cfg = readClientConfig(clientId);
      if (!cfg) return null;

      const customersDir = path.join(safeWrite.dataDir(clientId), "customers");
      let uniqueCustomers = 0;
      let activeLast7Days = 0;
      if (fs.existsSync(customersDir)) {
        // بنستثني ملفات التجربة (admin-preview.json من "تجربة محادثة" باللوحة، preview-*.json
        // من معاينة التسجيل الذاتي) — مو زبائن حقيقيين، ما لازم يشوّشوا الأرقام.
        const files = fs
          .readdirSync(customersDir)
          .filter((f) => f.endsWith(".json") && f !== "admin-preview.json" && !f.startsWith("preview-"));
        uniqueCustomers = files.length;
        for (const f of files) {
          const profile = safeWrite.safeReadJSON(path.join(customersDir, f), null);
          if (profile?.lastMessageAt && now - new Date(profile.lastMessageAt).getTime() <= SEVEN_DAYS_MS) {
            activeLast7Days += 1;
          }
        }
      }

      const escalations = escalationLog.readRecent(clientId, 500);
      const handledIds = new Set(escalationHandled.getHandledIds(clientId));
      const unhandledEscalations = escalations.filter((e) => !handledIds.has(e.id)).length;

      return {
        clientId,
        displayName: cfg.displayName,
        status: cfg.status || "active",
        uniqueCustomers,
        activeLast7Days,
        totalOrders: orders.readOrders(clientId).length,
        totalAppointments: appointments.readAppointments(clientId).length,
        totalEscalations: escalations.length,
        unhandledEscalations,
      };
    })
    .filter(Boolean);

  analytics.sort((a, b) => b.activeLast7Days - a.activeLast7Days);
  res.json({ analytics });
});

// ---------- API: تجربة محادثة لأي عميل (نفس منطق /signup/preview-chat، بس متاح
// لعميل موجود أصلاً مش بس أثناء التسجيل الذاتي) ----------

router.post("/admin/api/clients/:id/preview-chat", requireAuth, express.json(), async (req, res) => {
  if (!validClientIdOr400(req, res)) return;
  const { id } = req.params;
  const { message } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message (نص) مطلوب" });
  }

  const client = registry.getClientById(id);
  if (!client) return res.status(404).json({ error: "عميل غير موجود" });

  try {
    const profile = customers.getProfile(client.id, ADMIN_PREVIEW_USER_ID);
    const { text: rawReply } = await deepseek.getReply(client, profile, message);
    const { cleanText } = handoff.extractEscalationMarker(rawReply);
    await customers.saveTurn(client.id, ADMIN_PREVIEW_USER_ID, message, cleanText);
    res.json({ reply: cleanText });
  } catch (err) {
    console.error("[admin] فشل تجربة المحادثة:", err.response?.data || err.message);
    res.status(500).json({ error: "صار خطأ بتجربة المحادثة، جرب كمان شوي" });
  }
});

// يمسح تاريخ محادثة التجربة (يبلش تجربة نظيفة بدون ذاكرة من محاولات سابقة)
router.post("/admin/api/clients/:id/preview-chat/reset", requireAuth, async (req, res) => {
  if (!validClientIdOr400(req, res)) return;
  const { id } = req.params;
  if (!readClientConfig(id)) return res.status(404).json({ error: "عميل غير موجود" });

  const previewFile = path.join(safeWrite.dataDir(id), "customers", `${ADMIN_PREVIEW_USER_ID}.json`);
  try {
    if (fs.existsSync(previewFile)) fs.unlinkSync(previewFile);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  res.json({ ok: true });
});

// ---------- API: صندوق التصعيدات المُجمّع ----------

router.get("/admin/api/escalations", requireAuth, (req, res) => {
  const clientIds = safeWrite.listClientIds();
  const allEscalations = [];

  for (const clientId of clientIds) {
    const cfg = readClientConfig(clientId);
    const logs = escalationLog.readRecent(clientId, 50);
    const handledIds = new Set(escalationHandled.getHandledIds(clientId));

    for (const item of logs) {
      allEscalations.push({
        ...item,
        clientId,
        displayName: cfg?.displayName || clientId,
        handled: handledIds.has(item.id),
      });
    }
  }

  allEscalations.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  res.json({ escalations: allEscalations.slice(0, 200) });
});

router.post("/admin/api/escalations/:clientId/:escalationId/handle", requireAuth, async (req, res) => {
  const { clientId, escalationId } = req.params;
  try {
    safeWrite.assertValidClientId(clientId);
    await escalationHandled.markHandled(clientId, escalationId);
    auditLog.record("escalation_handled", clientId, { escalationId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/admin/api/escalations/:clientId/:escalationId/unhandle", requireAuth, async (req, res) => {
  const { clientId, escalationId } = req.params;
  try {
    safeWrite.assertValidClientId(clientId);
    await escalationHandled.unmarkHandled(clientId, escalationId);
    auditLog.record("escalation_unhandled", clientId, { escalationId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
