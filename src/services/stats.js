// عدادات يومية دائمة لكل السيرفر — أساس إحصائيات الأدمن وتقدير تكلفة DeepSeek.
//
// الأداء: كل رسالة بتعمل increment بالذاكرة بس، والكتابة عالقرص مرة كل 30 ثانية (أو عند
// الخروج). data/stats.json بيحتفظ بآخر 90 يوم وبينضف تلقائيًا وقت الفلش.
//
// التقدير بالدولار تقريبي من متغيرات الأسعار بـ.env — أرقام للمتابعة، مو فاتورة رسمية.
const fs = require("fs");
const path = require("path");

const STATS_PATH = path.join(__dirname, "..", "..", "data", "stats.json");
const KEEP_DAYS = 90;

let diskData = readDisk();
const pending = {}; // date -> counters (مش مفلوشة للقرص بعد)

function readDisk() {
  const data = safeRead();
  if (!data || typeof data !== "object") return {};
  // تنظيف قديم عند التحميل كمان
  const cutoff = cutoffDate();
  for (const key of Object.keys(data)) {
    if (key < cutoff) delete data[key];
  }
  return data;
}

function safeRead() {
  try {
    return JSON.parse(fs.readFileSync(STATS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function cutoffDate() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - KEEP_DAYS);
  return d.toISOString().slice(0, 10);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // أيام UTC — كافي لمتابعة يومية
}

/**
 * @param {{messages?,llmCalls?,cacheHits?,escalations?,offHours?,tokensIn?,tokensOut?}} fields
 */
function increment(fields) {
  const day = todayKey();
  const bucket = (pending[day] = pending[day] || {});
  for (const [key, value] of Object.entries(fields)) {
    bucket[key] = (bucket[key] || 0) + value;
  }
}

/** الدمج الحالي: القرص + المعلّق بالذاكرة */
function snapshot() {
  const merged = {};
  for (const source of [diskData, pending]) {
    for (const [date, counters] of Object.entries(source)) {
      merged[date] = merged[date] || {};
      for (const [k, v] of Object.entries(counters)) {
        merged[date][k] = (merged[date][k] || 0) + v;
      }
    }
  }
  return merged;
}

function flushSync() {
  if (!Object.keys(pending).length) return;
  diskData = snapshot();
  try {
    fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
    const tmp = `${STATS_PATH}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(diskData, null, 2), "utf8");
    fs.renameSync(tmp, STATS_PATH);
    for (const key of Object.keys(pending)) delete pending[key];
  } catch (err) {
    console.error("[stats] فشلت الكتابة:", err.message);
  }
}

const flushTimer = setInterval(flushSync, 30_000);
flushTimer.unref();
process.on("exit", flushSync);

module.exports = { increment, snapshot, flushSync };
