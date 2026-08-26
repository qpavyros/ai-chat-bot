// عدّاد استهلاك دائم بـFirestore — بديل لـrateLimit.js (بالذاكرة بس) للعدّادات يلي أثرها
// مباشر على الفوترة (سقف الباقة الشهري، سقف رسائل الفترة التجريبية). rateLimit.js يضل
// مستخدم لحماية burst/إساءة العامة (session/داily) يلي فقدانها عند إعادة تشغيل مقبول.
//
// اكتشاف Fable 5 (2026-08-14): `tier-monthly-msgs:${client.id}` كانت بس Map بالذاكرة —
// أي pm2 restart كان يصفّر عدّاد الشهر، يعني عميل بيقدر يستهلك أضعاف سقف باقته المدفوعة
// بلا أي حد فعلي. نفس منطق النافذة الزمنية المتحركة تبع rateLimit.checkLimit، بس بمعاملة
// Firestore ذرّية (transaction) بدل Map — ما بتضيع مع أي إعادة تشغيل.

const { db } = require("./firebaseAdmin");

const COLLECTION = "usageCounters";

// amount: كم وحدة تنضاف هالنداء (1 افتراضيًا للرسائل؛ ثواني الصوت بتمر أرقام أكبر).
// الرفض بيصير قبل أي زيادة — نداء مرفوض ما بيستهلك شي.
async function checkAndIncrement(key, { max, windowMs, amount = 1 }) {
  const ref = db.collection(COLLECTION).doc(key);
  const add = Math.max(1, Math.round(amount));

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const data = snap.exists ? snap.data() : null;

    if (!data || data.resetAt <= now) {
      if (add > max) return { allowed: false, remaining: 0, resetAt: now + windowMs };
      const fresh = { count: add, resetAt: now + windowMs };
      tx.set(ref, fresh);
      return { allowed: true, remaining: max - add, resetAt: fresh.resetAt };
    }

    if (data.count + add > max) {
      return { allowed: false, remaining: Math.max(0, max - data.count), resetAt: data.resetAt };
    }

    const nextCount = data.count + add;
    tx.update(ref, { count: nextCount });
    return { allowed: true, remaining: max - nextCount, resetAt: data.resetAt };
  });
}

// قراءة بدون زيادة — للوحة التحكّم (Dashboard، Phase 4) لعرض "كم رسالة متبقية" بدون ما تحتسب
// كأنها رسالة جديدة.
async function peek(key) {
  const snap = await db.collection(COLLECTION).doc(key).get();
  if (!snap.exists) return { count: 0, resetAt: null };
  return snap.data();
}

module.exports = { checkAndIncrement, peek };
