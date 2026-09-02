// عدّاد استهلاك دائم بـFirestore — بديل لـrateLimit.js (بالذاكرة بس) للعدّادات يلي أثرها
// مباشر على الفوترة (سقف الباقة الشهري، سقف رسائل الفترة التجريبية). rateLimit.js يضل
// مستخدم لحماية burst/إساءة العامة (session/داily) يلي فقدانها عند إعادة تشغيل مقبول.
//
// اكتشاف Fable 5 (2026-08-14): `tier-monthly-msgs:${client.id}` كانت بس Map بالذاكرة —
// أي pm2 restart كان يصفّر عدّاد الشهر، يعني عميل بيقدر يستهلك أضعاف سقف باقته المدفوعة
// بلا أي حد فعلي. نفس منطق النافذة الزمنية المتحركة تبع rateLimit.checkLimit، بس بمعاملة
// Firestore ذرّية (transaction) بدل Map — ما بتضيع مع أي إعادة تشغيل.

const { db } = require("./firebaseAdmin");
const crypto = require("crypto");

const COLLECTION = "usageCounters";
const RESERVATIONS = "usageReservations";

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
  const data = snap.data();
  if (data.resetAt <= Date.now()) return { count: 0, resetAt: null };
  return data;
}

async function reserve(key, { max, windowMs, amount, operationId }) {
  if (!Number.isFinite(amount) || amount <= 0 ||
      !Number.isFinite(max) || max <= 0 ||
      !Number.isFinite(windowMs) || windowMs <= 0 ||
      !operationId || typeof operationId !== 'string') {
    throw new Error("Invalid parameters");
  }

  const reservationId = crypto.createHash("sha256").update(`${key}:${operationId}`).digest("hex");
  const counterRef = db.collection(COLLECTION).doc(key);
  const resRef = db.collection(RESERVATIONS).doc(reservationId);

  return db.runTransaction(async (tx) => {
    const [counterSnap, resSnap] = await tx.getAll(counterRef, resRef);

    if (resSnap.exists) {
      if (resSnap.data().amount !== amount) {
        return { allowed: false, reason: "conflict" };
      }
      return { allowed: false, reason: "duplicate" };
    }

    const now = Date.now();
    let data = counterSnap.exists ? counterSnap.data() : null;
    let count = 0;
    let resetAt = now + windowMs;

    if (data && data.resetAt > now) {
      count = data.count;
      resetAt = data.resetAt;
    }

    if (count + amount > max) {
      return { allowed: false, reason: "quota_exceeded" };
    }

    const nextCount = count + amount;
    if (!data || data.resetAt <= now) {
      tx.set(counterRef, { count: nextCount, resetAt });
    } else {
      tx.update(counterRef, { count: nextCount });
    }

    tx.set(resRef, {
      key,
      amount,
      resetAt,
      status: "pending",
      createdAtUTC: new Date().toISOString()
    });

    return { allowed: true, reservationId, remaining: max - nextCount, resetAt };
  });
}

async function commitReservation(reservationId) {
  const resRef = db.collection(RESERVATIONS).doc(reservationId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(resRef);
    if (snap.exists && snap.data().status === "pending") {
      tx.update(resRef, { status: "committed" });
    }
  });
}

async function refundReservation(reservationId) {
  const resRef = db.collection(RESERVATIONS).doc(reservationId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(resRef);
    if (!snap.exists) return;
    const data = snap.data();
    if (data.status !== "pending") return;
    
    const counterRef = db.collection(COLLECTION).doc(data.key);
    const counterSnap = await tx.get(counterRef);
    
    tx.update(resRef, { status: "refunded" });
    
    if (counterSnap.exists) {
      const counterData = counterSnap.data();
      if (counterData.resetAt === data.resetAt) {
        tx.update(counterRef, { count: Math.max(0, counterData.count - data.amount) });
      }
    }
  });
}

module.exports = { checkAndIncrement, peek, reserve, commitReservation, refundReservation };
