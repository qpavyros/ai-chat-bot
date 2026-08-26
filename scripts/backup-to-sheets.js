#!/usr/bin/env node
/**
 * نسخة احتياطية دورية لبيانات data/ (مواعيد، طلبات، ملفات تعريف زبائن) إلى Google Sheet
 * بدرايف المشغّل — أرشيف للتصفّح من الموبايل بدون SSH، مش قاعدة بيانات حية. البوت نفسه
 * ما بيقرا ولا بيكتب من هون أبدًا؛ هاد سكربت منفصل بالكامل (raw JSON files هي المصدر الحقيقي).
 *
 * قراءة فقط عبر safeReadJSON — الكتابة الذرّية (temp+rename) بـsafeWrite.js كافية لمنع قراءة
 * ملف نص مكتوب، فما في داعي ولا يجوز ياخد قفل العميل (withClientLock) هون: أخذه ممكن يعطّل
 * حجز حي وقت ما البوت مستني نفس القفل.
 *
 * الاستخدام:
 *   node scripts/backup-to-sheets.js --dry-run   يحسب التابات وعدد الصفوف بدون أي اتصال شبكة
 *                                                  (يشتغل بدون أي إعداد Google — فحص أول قبل الإعداد)
 *   node scripts/backup-to-sheets.js              يرفع فعليًا (يحتاج .env معبّى، راجع تحت)
 *
 * الإعداد المطلوب بـ.env (راجع .env.example للتفاصيل الكاملة):
 *   GOOGLE_SERVICE_ACCOUNT_KEY_FILE   مسار ملف JSON لحساب خدمة Google
 *   GOOGLE_SHEETS_SPREADSHEET_ID      معرّف الـ Sheet — ⚠️ أنشئه إنت بحسابك الشخصي وشاركه
 *                                      (تحرير) مع بريد حساب الخدمة. لو حساب الخدمة هو يلي
 *                                      بينشئ الملف، الملف بيصير ملكه هو مش ملكك، وما رح يظهر
 *                                      بدرايف حسابك — كل الفكرة (تصفّح من الموبايل) بتنكسر.
 *
 * كل تشغيلة بتعمل استبدال كامل لكل تاب (clear ثم write) — بسيط ومتوقّع (idempotent)، بدون
 * حاجة لمنطق "دمج تغييرات". لو تشغيلة فشلت (نت مقطوع، حصة API)، بنسجّل الخطأ ونطلع بحالة فشل
 * والتشغيلة الجاية (بعد نص ساعة) بتصحح تلقائيًا — بدون أي retry/backoff إضافي.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const safeWrite = require("../src/services/safeWrite");

const DRY_RUN = process.argv.includes("--dry-run");

function listCustomerFiles(clientId) {
  const dir = path.join(safeWrite.dataDir(clientId), "customers");
  if (!fs.existsSync(dir)) return [];
  // smoke-test-* من npm test، *.bak/*.corrupt-* نسخ داخلية — ما إلها مكان بأرشيف للتصفّح
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("smoke-test-"));
}

function buildAppointmentsRows() {
  const header = ["clientId", "id", "date", "time", "customerName", "customerPhone", "status", "note", "createdAt", "cancelledAt"];
  const rows = [header];
  for (const clientId of safeWrite.listClientIds()) {
    const file = path.join(safeWrite.dataDir(clientId), "appointments.json");
    const appointments = safeWrite.safeReadJSON(file, []);
    for (const a of appointments) {
      rows.push([clientId, a.id, a.date, a.time, a.customerName, a.customerPhone, a.status, a.note || "", a.createdAt, a.cancelledAt || ""]);
    }
  }
  return rows;
}

function buildOrdersRows() {
  const header = ["clientId", "id", "items", "totalPrice", "deliveryMethod", "deliveryAddress", "paymentMethod", "customerName", "customerPhone", "note", "createdAt"];
  const rows = [header];
  for (const clientId of safeWrite.listClientIds()) {
    const file = path.join(safeWrite.dataDir(clientId), "orders.json");
    const orders = safeWrite.safeReadJSON(file, []);
    for (const o of orders) {
      rows.push([clientId, o.id, o.items, o.totalPrice, o.deliveryMethod, o.deliveryAddress || "", o.paymentMethod, o.customerName, o.customerPhone, o.note || "", o.createdAt]);
    }
  }
  return rows;
}

function buildCustomersRows() {
  // بس ملخّص (اسم/هاتف ضمني بـuserId، آخر رسالة، معلومات محفوظة، عدد ردود) — بدون كامل
  // سجل المحادثة (history): سجل كامل بيخلي الشيت ضخم وصعب التصفّح، والملخّص كافي لأي متابعة سريعة.
  const header = ["clientId", "userId", "firstSeenAt", "lastMessageAt", "lastMessage", "turnCount", "factsCount", "facts"];
  const rows = [header];
  for (const clientId of safeWrite.listClientIds()) {
    for (const file of listCustomerFiles(clientId)) {
      const profile = safeWrite.safeReadJSON(path.join(safeWrite.dataDir(clientId), "customers", file), null);
      if (!profile) continue;
      const turnCount = Math.floor((profile.history || []).length / 2);
      const facts = (profile.facts || []).map((f) => f.text).join(" | ");
      rows.push([
        clientId,
        profile.userId,
        profile.firstSeenAt,
        profile.lastMessageAt || "",
        profile.lastMessage || "",
        turnCount,
        (profile.facts || []).length,
        facts,
      ]);
    }
  }
  return rows;
}

async function ensureTabsExist(sheets, spreadsheetId, wantedTabs) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingTitles = new Set(meta.data.sheets.map((s) => s.properties.title));
  const missing = wantedTabs.filter((t) => !existingTitles.has(t));
  if (!missing.length) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
  });
}

async function writeTab(sheets, spreadsheetId, tab, rows) {
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${tab}!A1:ZZ100000` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });
}

async function main() {
  const sheetsData = {
    appointments: buildAppointmentsRows(),
    orders: buildOrdersRows(),
    customers: buildCustomersRows(),
  };
  const syncedAt = new Date().toISOString();

  if (DRY_RUN) {
    console.log("(dry-run) بدون أي اتصال شبكة:\n");
    for (const [tab, rows] of Object.entries(sheetsData)) {
      console.log(`  ${tab}: ${rows.length - 1} صف`);
    }
    console.log(`\n  synced_at سيكون: ${syncedAt}`);
    return;
  }

  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!keyFile || !spreadsheetId) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY_FILE و GOOGLE_SHEETS_SPREADSHEET_ID لازم يكونوا معرّفين بـ.env");
  }

  const { google } = require("googleapis");
  const auth = new google.auth.GoogleAuth({
    keyFile: path.isAbsolute(keyFile) ? keyFile : path.join(__dirname, "..", keyFile),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const wantedTabs = [...Object.keys(sheetsData), "synced_at"];
  await ensureTabsExist(sheets, spreadsheetId, wantedTabs);

  for (const [tab, rows] of Object.entries(sheetsData)) {
    await writeTab(sheets, spreadsheetId, tab, rows);
  }
  await writeTab(sheets, spreadsheetId, "synced_at", [["آخر تحديث", syncedAt]]);

  console.log(`✅ اتحدّث Google Sheet بنجاح — ${syncedAt}`);
}

main().catch((err) => {
  console.error("❌ فشل نسخ البيانات لـGoogle Sheets:", err.response?.data || err.message);
  process.exitCode = 1;
});
