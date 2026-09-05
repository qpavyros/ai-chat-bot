// سجل JSONL append-only بسقف تلقائي — كان escalation.log وadmin-audit.log بينمو للأبد
// وreadRecent بيقرأ الملف كامل ثم يقص (ذاكرة/إدخال-إخراج بيكبرو مع العمر). الحل: الإلحاق
// عادي، ولما حجم الملف يتجاوز maxBytes بنعيد كتابته بآخر keepLast سطر فقط.
//
// فحص الحجم statSync رخيص (metadata)، وإعادة الكتابة نادرة عمليًا (مرة كل عدة آلاف سجل).
// ملفات بيانات الأعمال (orders.json، appointments.json، paymentHistory) مو هنا عمدًا —
// حذف آلي لسجلات طلبات/مواعيد حقيقية قرار تجاري، مش تنظيف تقني.
const fs = require("fs");
const path = require("path");

function appendCapped(logPath, entryObject, { maxBytes = 256 * 1024, keepLast = 500 } = {}) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entryObject) + "\n", "utf8");

  let size = 0;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return; // انكتب للتو، الفحص الجاي بيمسكه
  }
  if (size <= maxBytes) return;

  // تجاوز السقف — نحتفظ بآخر keepLast سطر صالح ونعيد كتابة الملف ذرّيًا
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const kept = lines.slice(-keepLast);
  const archived = lines.slice(0, -keepLast);
  if (archived.length) {
    fs.appendFileSync(`${logPath}.archive.jsonl`, archived.join("\n") + "\n", "utf8");
  }
  const tempPath = `${logPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, kept.length ? kept.join("\n") + "\n" : "", "utf8");
  fs.renameSync(tempPath, logPath);
}

function parseLines(raw) {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function readPage(logPath, { limit = 100, cursor = "0" } = {}) {
  if (!fs.existsSync(logPath) && !fs.existsSync(`${logPath}.archive.jsonl`)) {
    return { entries: [], nextCursor: null };
  }
  const archive = fs.existsSync(`${logPath}.archive.jsonl`)
    ? parseLines(fs.readFileSync(`${logPath}.archive.jsonl`, "utf8")) : [];
  const active = fs.existsSync(logPath) ? parseLines(fs.readFileSync(logPath, "utf8")) : [];
  const all = archive.concat(active).reverse();
  const offset = Math.max(0, Number.parseInt(cursor, 10) || 0);
  const entries = all.slice(offset, offset + limit);
  const nextCursor = offset + entries.length < all.length ? String(offset + entries.length) : null;
  return { entries, nextCursor };
}

function readRecent(logPath, limit = 100) {
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, "utf8");
  if (!raw.trim()) return [];
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = { appendCapped, readRecent, readPage };
