// محدد معدل بسيط بالذاكرة (نافذة ثابتة) — بدون Redis أو أي تبعية خارجية، بنفس فلسفة
// appointments.js/customers.js (ملف/ذاكرة بسيطة لحد ما يصير عندك حجم يبرر شي أعقد).
//
// ⚠️ حد معروف: بينصفر عند إعادة تشغيل السيرفر، ومحدود لعملية Node واحدة (مو موزّع بين
// أكتر من سيرفر). كافي لمشغّل واحد بعدد عملاء محدود — لو صار عندك أكثر من نسخة سيرفر
// شغالة بنفس الوقت، هاي أول إشارة تحتاج store خارجي مشترك (Redis).

const windows = new Map(); // key -> { count, resetAt }

// key: أي معرّف (IP، إيميل، clientId...) — نفس الدالة تُستخدم لأي نوع تحديد.
// max/windowMs: حد الطلبات المسموحة خلال النافذة الزمنية.
function checkLimit(key, { max, windowMs }) {
  const now = Date.now();
  const entry = windows.get(key);

  if (!entry || entry.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1, resetAt: now + windowMs };
  }

  if (entry.count >= max) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count += 1;
  return { allowed: true, remaining: max - entry.count, resetAt: entry.resetAt };
}

// تنظيف دوري بسيط حتى ما تكبر الـ Map للأبد بمفاتيح منتهية الصلاحية
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of windows) {
    if (entry.resetAt <= now) windows.delete(key);
  }
}, 10 * 60 * 1000);
cleanupTimer.unref();

module.exports = { checkLimit };
