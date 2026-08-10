const express = require("express");
const path = require("path");
const config = require("./config");
const whatsappWebhook = require("./routes/whatsappWebhook");
const webChat = require("./routes/webChat");
const signup = require("./routes/signup");
const admin = require("./routes/admin");

const app = express();
// خلف Nginx reverse proxy (VPS) — لازم حتى req.secure يعكس X-Forwarded-Proto الصحيح
// (كوكي جلسة /admin بتحطّ Secure بس لو الطلب فعليًا وصل عبر HTTPS، راجع src/routes/admin.js)
app.set("trust proxy", 1);
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

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
app.use("/", admin);

// /api/v1 هو المسار الموثّق (راجع docs/) — /api غير مُعرّف يبقى شغال لأي تضمين قديم موجود.
app.use("/api/v1", webChat);
app.use("/api/v1", signup);
app.use("/api", webChat);

// صفحة تجربة الودجت + ملف الودجت نفسه، تصفحهم من المتصفح لتجربة سريعة بدون واتساب
app.use("/widget", express.static(path.join(__dirname, "widget")));

// صفحات التسجيل الذاتي المُستضافة + التوثيق (Phase 5)
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/docs", express.static(path.join(__dirname, "..", "docs")));

app.listen(config.port, () => {
  console.log(`AI chat bot server running on http://localhost:${config.port}`);
  console.log(`Widget demo: http://localhost:${config.port}/widget/chat-widget-demo.html`);
});
