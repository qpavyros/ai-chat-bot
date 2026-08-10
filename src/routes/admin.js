// لوحة تحكم المشغّل (/admin) — داخلية بس، لصاحب المشروع نفسه، مش للعملاء. بُنيت حسب توصية
// مجلس LLM (2026-08-09، council-transcript-20260809-140000.md): auth حقيقي + rate limiting
// على الدخول + كل كتابة تمر عبر safeWrite.js (قفل + نسخة احتياطية + كتابة ذرّية) + audit log.
const express = require("express");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const adminAuth = require("../services/adminAuth");
const safeWrite = require("../services/safeWrite");
const auditLog = require("../services/auditLog");
const provisioning = require("../services/provisioning");
const { validateClientConfig } = require("../services/clientConfigSchema");

const router = express.Router();
const CLIENTS_DIR = path.join(__dirname, "..", "clients");
const SESSION_COOKIE = "admin_session";

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return cookies;
}

function setSessionCookie(req, res, token) {
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  const maxAge = config.admin.sessionTtlHours * 60 * 60;
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Strict${isHttps ? "; Secure" : ""}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict`);
}

function clientIp(req) {
  return req.ip || req.connection?.remoteAddress || "unknown";
}

// بوابة API — أي endpoint تحت /admin/api لازم جلسة صالحة، وإلا 401 (الواجهة بتتصرف بالتحويل لتسجيل الدخول)
function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  if (!adminAuth.validateSession(cookies[SESSION_COOKIE])) {
    return res.status(401).json({ error: "غير مسجّل دخول" });
  }
  next();
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
  setSessionCookie(req, res, token);
  auditLog.record("login", null, { ip });
  res.json({ ok: true });
});

router.post("/admin/logout", (req, res) => {
  const cookies = parseCookies(req);
  adminAuth.destroySession(cookies[SESSION_COOKIE]);
  clearSessionCookie(res);
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
  };
}

// ---------- API: عملاء ----------

router.get("/admin/api/clients", requireAuth, (req, res) => {
  const clients = safeWrite.listClientIds().map(summarize).filter(Boolean);
  clients.sort((a, b) => a.displayName.localeCompare(b.displayName, "ar"));
  res.json({ clients });
});

router.get("/admin/api/clients/:id", requireAuth, (req, res) => {
  const cfg = readClientConfig(req.params.id);
  if (!cfg) return res.status(404).json({ error: "عميل غير موجود" });

  const knowledgePath = path.join(CLIENTS_DIR, req.params.id, "knowledge.md");
  const knowledge = fs.existsSync(knowledgePath) ? fs.readFileSync(knowledgePath, "utf8") : "";

  res.json({ config: cfg, knowledge, knowledgeFiles: listKnowledgeFiles(req.params.id) });
});

router.post("/admin/api/clients", requireAuth, express.json(), (req, res) => {
  const { companyName, contactEmail, escalationPhone, notifyWhatsapp, knowledgeSourceLabel, knowledgeText, expiresAt } =
    req.body || {};

  if (!companyName || !String(companyName).trim()) {
    return res.status(400).json({ error: "اسم الشركة مطلوب" });
  }
  if (!escalationPhone || !String(escalationPhone).trim()) {
    return res.status(400).json({ error: "رقم تواصل التصعيد مطلوب" });
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
    subscriptionExpiresAt: expiresAt || null,
    knowledgeSourceLabel: knowledgeSourceLabel || null,
    createdAt: new Date().toISOString(),
  };

  const schemaError = validateClientConfig(cfg);
  if (schemaError) return res.status(400).json({ error: schemaError });

  try {
    safeWrite.createClientDirAtomic(slug, {
      "config.json": JSON.stringify(cfg, null, 2),
      "knowledge.md": knowledgeText || `# قاعدة معرفة — ${companyName}\n\n(لسا فاضية — عدّلها من هون أو من الملف مباشرة)\n`,
      "auth.json": JSON.stringify({ publicKey: null, apiKeys: [] }, null, 2),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  auditLog.record("create_client", slug, { companyName });
  res.status(201).json({ id: slug });
});

router.put("/admin/api/clients/:id", requireAuth, express.json(), async (req, res) => {
  const { id } = req.params;
  const existing = readClientConfig(id);
  if (!existing) return res.status(404).json({ error: "عميل غير موجود" });

  const updated = { ...existing, ...req.body, id }; // id ثابت — ما بيتغيّر من الفورم
  const schemaError = validateClientConfig(updated);
  if (schemaError) return res.status(400).json({ error: schemaError });

  try {
    await safeWrite.safeWriteJSON(id, "config.json", updated, { validate: validateClientConfig });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  auditLog.record("update_config", id, { fields: Object.keys(req.body || {}) });
  res.json({ ok: true });
});

router.put("/admin/api/clients/:id/knowledge", requireAuth, express.json({ limit: "2mb" }), async (req, res) => {
  const { id } = req.params;
  const { content } = req.body || {};
  if (typeof content !== "string") return res.status(400).json({ error: "content (نص) مطلوب" });

  try {
    await safeWrite.safeWriteFile(id, "knowledge.md", content);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  auditLog.record("update_knowledge", id, { chars: content.length });
  res.json({ ok: true });
});

router.post("/admin/api/clients/:id/renew", requireAuth, express.json(), async (req, res) => {
  const { id } = req.params;
  const { expiresAt, status } = req.body || {};
  const existing = readClientConfig(id);
  if (!existing) return res.status(404).json({ error: "عميل غير موجود" });

  const updated = { ...existing };
  if (expiresAt) {
    if (updated.plan === "trial") updated.trialExpiresAt = expiresAt;
    else updated.subscriptionExpiresAt = expiresAt;
  }
  if (status) updated.status = status;

  try {
    await safeWrite.safeWriteJSON(id, "config.json", updated, { validate: validateClientConfig });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  auditLog.record("renew", id, { expiresAt, status });
  res.json({ ok: true });
});

router.get("/admin/api/audit-log", requireAuth, (req, res) => {
  res.json({ entries: auditLog.readRecent(200) });
});

module.exports = router;
