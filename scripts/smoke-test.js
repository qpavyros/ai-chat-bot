#!/usr/bin/env node
/**
 * فحص سريع (smoke test) قبل أي نشر — يتأكد إنه الأساسيات شغالة فعليًا، مو بس إنه الكود
 * "بيتصرّف" (compile) بدون أخطاء. يفترض السيرفر شغال أصلاً (npm run dev/start بترمينال تاني).
 *
 * الاستخدام: npm test
 * (بيقرا BASE_URL و.env من نفس بيئة المشروع — شغّله محليًا أو عالسيرفر، مش أوتوماتيكي بأي CI)
 *
 * ⚠️ بيعمل استدعاء حقيقي واحد لـDeepSeek (فحص الشات) — تكلفة سنتات، مقصود (فحص وهمي بمفتاح
 * وهمي بيثبت الشكل الخارجي بس، مو سلوك النموذج الفعلي — درس اتعلّمناه بالمشروع هذا صراحة).
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const BASE_URL = process.env.SMOKE_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const WIDGET_KEY = process.env.WEB_WIDGET_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`❌ ${name}\n   ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "فشل التحقق");
}

async function main() {
  console.log(`فحص ${BASE_URL}\n`);

  await check("GET /health بيرجع ok", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const data = await res.json();
    assert(res.status === 200 && data.ok === true, `status=${res.status} body=${JSON.stringify(data)}`);
  });

  await check("محادثة ودجت (example-client) بترد فعليًا", async () => {
    assert(WIDGET_KEY, "WEB_WIDGET_KEY مش معرّف بـ.env");
    const res = await fetch(`${BASE_URL}/api/v1/chat/example-client`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-widget-key": WIDGET_KEY },
      body: JSON.stringify({ message: "مرحبا", sessionId: `smoke-test-${Date.now()}` }),
    });
    const data = await res.json();
    assert(res.status === 200, `status=${res.status} body=${JSON.stringify(data)}`);
    assert(typeof data.reply === "string" && data.reply.length > 0, "الرد فاضي");
  });

  await check("حجز موعد فعلي (example-clinic) ينكتب عالقرص", async () => {
    const appointments = require("../src/services/appointments");
    const registry = require("../src/clients/registry");
    const client = registry.getClientById("example-clinic");
    assert(client, "example-clinic مش موجود");

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const before = appointments.readAppointments("example-clinic").length;

    const free = appointments.getFreeSlots(client, tomorrow);
    assert(free.length > 0, `ما في خانات فاضية بكرا (${tomorrow})`);

    const record = appointments.bookAppointment(client, {
      date: tomorrow,
      time: free[0],
      customerName: "SMOKE_TEST",
      customerPhone: "0000000000",
      note: "smoke-test — احذفه لو شفته",
    });
    assert(record.id, "الحجز ما رجّع id");

    const after = appointments.readAppointments("example-clinic");
    assert(after.length === before + 1, "الحجز ما انكتب فعليًا بالملف");

    // تنظيف — نشيل حجز الفحص حتى ما يضل يحجب الخانة عن زبون حقيقي
    const cleaned = after.filter((a) => a.id !== record.id);
    fs.writeFileSync(
      path.join(__dirname, "..", "data", "example-clinic", "appointments.json"),
      JSON.stringify(cleaned, null, 2),
      "utf8"
    );
  });

  await check("تسجيل دخول /admin بكلمة غلط بيترفض", async () => {
    const res = await fetch(`${BASE_URL}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "definitely-wrong-password" }),
    });
    assert(res.status === 401, `المفروض 401، طلع ${res.status}`);
  });

  await check("تسجيل دخول /admin بكلمة صح + قراءة قائمة العملاء", async () => {
    assert(ADMIN_PASSWORD, "ADMIN_PASSWORD مش معرّف بـ.env");
    const loginRes = await fetch(`${BASE_URL}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    assert(loginRes.status === 200, `فشل تسجيل الدخول: ${loginRes.status}`);
    const cookie = loginRes.headers.get("set-cookie");
    assert(cookie, "ما رجع cookie جلسة");

    const listRes = await fetch(`${BASE_URL}/admin/api/clients`, {
      headers: { cookie: cookie.split(";")[0] },
    });
    const data = await listRes.json();
    assert(listRes.status === 200 && Array.isArray(data.clients), "قائمة العملاء ما رجعت صح");
    assert(data.clients.length > 0, "قائمة العملاء فاضية — غريب");
  });

  console.log(`\n${passed} نجح، ${failed} فشل`);
  // process.exitCode بدل process.exit() — الأخيرة بتقطع event loop بقوة وبتصطدم أحيانًا
  // بمشكلة معروفة بـNode على Windows (assertion crash بمقابض async معلّقة من fetch/keep-alive).
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("فشل الفحص بالكامل:", err.message);
  process.exitCode = 1;
});
