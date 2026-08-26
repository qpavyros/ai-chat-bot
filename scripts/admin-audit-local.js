// فحص محلي شامل لصفحة الأدمن بعد التعديلات (بدون طباعة أي سر)
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const BASE = "http://127.0.0.1:4006";

async function main() {
  // 1) تسجيل دخول أدمن
  const login = await fetch(BASE + "/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
  });
  if (login.status !== 200) throw new Error("login failed " + login.status);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  console.log("1) admin-login: OK");

  // 2) صفحة الأدمن فيها المفاتيح الجديدة؟
  const page = await fetch(BASE + "/admin", { headers: { cookie } });
  const html = await page.text();
  const controls = [
    "f_salesMode", "f_voiceEnabled", "f_businessEnabled", "f_widgetAccent",
    "f_telegramBotToken", "f_discordBotToken", "f_botPaused",
    "f_channelWhatsapp", "f_channelWeb", "f_channelTelegram",
    "f_apptEnabled", "f_ordersEnabled", "f_remindersEnabled", "f_remTemplate",
  ];
  let missing = [];
  for (const id of controls) if (!html.includes(id)) missing.push(id);
  console.log(missing.length === 0
    ? `2) admin-page-controls: كل الـ${controls.length} مفتاح موجود ✓`
    : `2) ناقص: ${missing.join(", ")}`);

  // 3) حفظ تجريبي على example-client (محلي فقط — ما يمس الإنتاج) ثم قراءة القيم
  const getRes = await fetch(BASE + "/admin/api/clients/example-client", { headers: { cookie } });
  const cur = (await getRes.json()).config;
  const payload = { ...cur, salesMode: true, botPaused: false,
    channels: { whatsapp: { enabled: true }, web: { enabled: true }, telegram: { enabled: true } },
    appointments: { ...(cur.appointments || {}), enabled: false },
    orders: { ...(cur.orders || {}), enabled: true },
    voice: { enabled: true } };
  const put = await fetch(BASE + "/admin/api/clients/example-client", {
    method: "PUT",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(payload),
  });
  console.log("3) save-with-new-fields:", put.status === 200 ? "OK ✓" : "FAIL " + put.status);

  // 4) إعادة قراءة للتأكد من الاستمرارية
  const again = await fetch(BASE + "/admin/api/clients/example-client", { headers: { cookie } });
  const cfg = (await again.json()).config;
  console.log("4) persistence:",
    "salesMode=" + (cfg.salesMode === true),
    "| orders.enabled=" + (cfg.orders?.enabled === true),
    "| appointments.enabled=" + (cfg.appointments?.enabled === false));

  // 5) التيوتوريال والـPDF
  for (const [name, u] of [["tutorial-page", "/tutorial"], ["tutorial-pdf", "/public/tutorial.pdf"]]) {
    const r = await fetch(BASE + u);
    console.log(`5) ${name}:`, r.status, r.ok ? "(" + (await r.arrayBuffer()).byteLength + " bytes)" : "");
  }
}

main().catch((e) => { console.error("FAIL:", e.message); process.exitCode = 1; });
