const express = require("express");
const path = require("path");
const { fork } = require("child_process");
const config = require("./config");
const whatsappWebhook = require("./routes/whatsappWebhook");
const telegramWebhook = require("./routes/telegramWebhook");
const webChat = require("./routes/webChat");
const signup = require("./routes/signup");
const admin = require("./routes/admin");
const { router: userAuth } = require("./routes/userAuth");
const dashboard = require("./routes/dashboard");
const botManagement = require("./routes/botManagement");

const app = express();
// خلف Nginx reverse proxy (VPS) — لازم حتى req.secure يعكس X-Forwarded-Proto الصحيح
// (كوكي جلسة /admin بتحطّ Secure بس لو الطلب فعليًا وصل عبر HTTPS، راجع src/routes/admin.js)
app.set("trust proxy", 1);
// verify بيحتفظ بالجسم الخام (req.rawBody) — لازمنا للتحقق من توقيع X-Hub-Signature-256
// تبع ويبهوك واتساب (HMAC على البايتات الخام بالضبط، مش على النص المُعاد parse-ه).
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "landing.html")));

// روابط نظيفة بدون .html — الملفات نفسها تبقى شغّالة بامتدادها الكامل كمان (توافق خلفي).
app.get("/public/signup", (req, res) => res.sendFile(path.join(__dirname, "public", "signup.html")));
app.get("/public/onboard", (req, res) => res.sendFile(path.join(__dirname, "public", "onboard.html")));
// الرحلة التفاعلية scroll-world (٦ مشاهد سكرول-سكرَاب)
app.get("/world", (req, res) => res.sendFile(path.join(__dirname, "public", "world-preview.html")));
app.get("/privacy", (req, res) => res.sendFile(path.join(__dirname, "public", "privacy.html")));
app.get("/tutorial", (req, res) => res.sendFile(path.join(__dirname, "public", "tutorial.html")));
app.get("/terms", (req, res) => res.sendFile(path.join(__dirname, "public", "terms.html")));
app.get("/cookies", (req, res) => res.sendFile(path.join(__dirname, "public", "cookies.html")));
// robots.txt وsitemap.xml لازم يكونوا عالجذر تحديدًا — مش تحت /public — حتى تلاقيهم محركات البحث.
app.get("/robots.txt", (req, res) => res.sendFile(path.join(__dirname, "public", "robots.txt")));
app.get("/sitemap.xml", (req, res) => res.sendFile(path.join(__dirname, "public", "sitemap.xml")));

// الودجت بيشتغل من دومين موقع العميل، مو من دومين هالسيرفر، فلازم CORS مفتوح على /api تحديدًا.
// وسّعنا الهيدرز/الميثودز عن النسخة القديمة حتى تستوعب Authorization (مفاتيح pk_/sk_) ومسارات
// GET الجديدة (/signup/verify) بدون ما تفشل بصمت على أول preflight.
app.use(["/api", "/api/v1"], (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-widget-key");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use("/", whatsappWebhook);
app.use("/", telegramWebhook);
app.use("/", admin);
app.use("/", userAuth);
app.use("/", dashboard);
app.use("/", botManagement);

// /api/v1 هو المسار الموثّق (راجع docs/) — /api غير مُعرّف يبقى شغال لأي تضمين قديم موجود.
app.use("/api/v1", webChat);
app.use("/api/v1", signup);
app.use("/api", webChat);

// صفحة تجربة الودجت + ملف الودجت نفسه، تصفحهم من المتصفح لتجربة سريعة بدون واتساب
app.use("/widget", express.static(path.join(__dirname, "widget")));

// صفحات التسجيل الذاتي المُستضافة (الـ/docs القديم أُزيل — كان يعرض خططا داخلية للعامة)
app.use("/public", express.static(path.join(__dirname, "public")));

// 404 مخصّص — بعد كل الراوتات والملفات الثابتة، قبل معالج الأخطاء. لازم يرجّع status 404
// فعليًا (مش 200) حتى لا يتفسّر كـsoft-404 من محركات البحث. الـAPI بيرجعله JSON مو صفحة.
app.use((req, res) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/webhook")) {
    return res.status(404).json({ error: { code: "not_found", message: "الرابط غير موجود" } });
  }
  res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
});

// معالج أخطاء مركزي — أخطاء الـasync بتوصل هون عبر asyncHandler (راجع middleware/asyncHandler.js).
// تفاصيل الخطأ الحقيقية بتنروح للسجل بس — err.message الخام ممكن يسرّب مسارات سيرفر للعميل.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error("[error]", req.method, req.originalUrl, "-", err.message);
  if (res.headersSent) return;
  res.status(err.status || err.statusCode || 500).json({
    error: { code: "internal_error", message: "صار خطأ داخلي، جرب كمان مرة" },
  });
});

app.listen(config.port, () => {
  console.log(`AI chat bot server running on http://localhost:${config.port}`);
  console.log(`Widget demo: http://localhost:${config.port}/widget/chat-widget-demo.html`);
});

// نسخة احتياطية دورية لـGoogle Sheets — process منفصل تمامًا (fork) كل مرة، مش thread داخل
// نفس العملية: لو استدعاء Google تعلّق أو رمى استثناء، ما بيوصل أبدًا لعملية السيرفر الحية.
if (config.backupSheets.enabled) {
  const scriptPath = path.join(__dirname, "..", "scripts", "backup-to-sheets.js");
  const runBackup = () => {
    const child = fork(scriptPath, [], { stdio: "inherit" });
    child.on("exit", (code) => {
      if (code !== 0) console.error(`[backup-to-sheets] فشلت التشغيلة (exit code ${code})`);
    });
  };
  runBackup();
  setInterval(runBackup, config.backupSheets.intervalMinutes * 60 * 1000);
}

// تذكير مواعيد استباقي — حلقة داخلية كل 5 دقائق (خفيفة: مسح ملفات config + مواعيد فقط).
// حارس running يمنع تداخل دورتين لو الدورة أخذت أطول من المعتاد.
const appointmentReminders = require("./services/appointmentReminders");
let remindersRunning = false;
setInterval(() => {
  if (remindersRunning) return;
  remindersRunning = true;
  appointmentReminders
    .runOnce()
    .catch((err) => console.error("[reminders] فشلت الدورة:", err.message))
    .finally(() => {
      remindersRunning = false;
    });
}, 5 * 60 * 1000).unref();

// تسجيل ويبهوكات تلغرام تلقائيًا عند الإقلاع — أي عميل عنده telegramBotToken بيتسجّل
// على PUBLIC_BASE_URL/webhook/telegram/<id> مع سرّه المحفوظ. يتطلب https (Telegram صارم).
const safeWrite = require("./services/safeWrite");
const telegramService = require("./services/telegram");
async function registerTelegramWebhooks() {
  const baseUrl = config.provisioning.publicBaseUrl;
  if (!baseUrl.startsWith("https://")) {
    console.warn("[telegram] تخطينا التسجيل — PUBLIC_BASE_URL لازم يكون https لتلغرام");
    return;
  }
  for (const clientId of safeWrite.listClientIds()) {
    try {
      const cfg = safeWrite.safeReadJSON(
        path.join(__dirname, "clients", clientId, "config.json"),
        null
      );
      if (!cfg?.telegramBotToken) continue;
      await telegramService.setWebhook(
        cfg.telegramBotToken,
        `${baseUrl}/webhook/telegram/${clientId}`,
        cfg.telegramWebhookSecret || ""
      );
      console.log(`[telegram] تسجّل ويبهوك البوت "${clientId}"`);
    } catch (err) {
      console.error(`[telegram] فشل تسجيل ويبهوك "${clientId}":`, err.response?.data || err.message);
    }
  }
}
registerTelegramWebhooks();

// بوتات ديسكورد — اتصالات gateway دائمة لكل عميل عنده توكن (DM بس)
const discordGateway = require("./services/discordGateway");
discordGateway.syncAll();

// التقرير الأسبوعي الملخص عبر واتساب
const weeklyDigest = require("./services/weeklyDigest");
weeklyDigest.scheduleWeeklyDigests();

