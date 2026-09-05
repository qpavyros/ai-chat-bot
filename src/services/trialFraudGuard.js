// منع نفس الشخص من فتح أكتر من حساب تجريبي واحد. حسابات المستخدمين (Firebase Auth) سهل
// تتكرر — إيميل جديد كل مرة بواسطة Google/email مختلف — فالتحقق الحقيقي لازم يعتمد على
// معرّفات الشركة نفسها يلي بتتكرر بصعوبة أكبر: رقم واتساب الإشعارات، رقم تصعيد الزبائن،
// دومين الموقع، ومعرّف حساب واتساب بزنس (WABA ID) بعد ربطه فعليًا. بالإضافة لعدّاد IP دائم
// بـFirestore (rateLimit.js بالذاكرة بيصفّر مع كل إعادة تشغيل).
//
// waha/whatsapp/phone/domain: حجب صارم (mismatch بمالك مختلف = رفض) — صعب لشركة حقيقية
// تشارك هالمعرّفات، فوجودها مسبقًا بحساب تاني إشارة قوية جدًا لإساءة استخدام.
// IP: عدّاد نافذة متحركة (بيسمح لعدد محدود خلال شهر) — إشارة أضعف (شبكات مشتركة/NAT)
// فمنحجب فقط لما يتخطى حد معقول، مش من أول تكرار.

const crypto = require("crypto");
const { db } = require("./firebaseAdmin");

const COLLECTION = "trialFingerprints";
const IP_MAX_SIGNUPS = 3;
const IP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // ٣٠ يوم

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.slice(-8); // آخر ٨ أرقام — يتجاوز فروق كود الدولة (+961 مقابل 0 مقابل 00961)
}

function normalizeDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

function hashIp(ip) {
  return crypto.createHash("sha256").update(`trial-fraud-guard:${ip}`).digest("hex").slice(0, 24);
}

function buildHardKeys({ notifyWhatsapp, escalationPhone, websiteUrl }) {
  const keys = [];
  const wa = normalizePhone(notifyWhatsapp);
  if (wa) keys.push({ reason: "whatsapp", key: `wa:${wa}` });
  const phone = normalizePhone(escalationPhone);
  if (phone && phone !== wa) keys.push({ reason: "phone", key: `ph:${phone}` });
  const domain = normalizeDomain(websiteUrl);
  if (domain) keys.push({ reason: "website", key: `dom:${domain}` });
  return keys;
}

// بيتنفّذ بـ/signup/start قبل إنشاء طلب التسجيل. بيرجع { blocked: false } لو مسموح،
// أو { blocked: true, reason } لو في تكرار. لو مسموح، بيسجّل المعرّفات فورًا (نفس المعاملة)
// حتى لو حدا حاول يسجّل بالتوازي بحسابين مختلفين ما يفوت الاثنين.
async function reserveSignupFingerprints(ownerUid, { notifyWhatsapp, escalationPhone, websiteUrl, ip }) {
  const hardKeys = buildHardKeys({ notifyWhatsapp, escalationPhone, websiteUrl });
  const ipKey = ip && ip !== "unknown" ? `ip:${hashIp(ip)}` : null;

  return db.runTransaction(async (tx) => {
    const hardRefs = hardKeys.map((k) => db.collection(COLLECTION).doc(k.key));
    const ipRef = ipKey ? db.collection(COLLECTION).doc(ipKey) : null;

    const hardSnaps = await Promise.all(hardRefs.map((ref) => tx.get(ref)));
    const ipSnap = ipRef ? await tx.get(ipRef) : null;

    for (let i = 0; i < hardSnaps.length; i++) {
      const snap = hardSnaps[i];
      if (snap.exists && snap.data().ownerUid !== ownerUid) {
        return { blocked: true, reason: hardKeys[i].reason };
      }
    }

    const now = Date.now();
    if (ipSnap && ipSnap.exists) {
      const data = ipSnap.data();
      const stillInWindow = data.resetAt > now;
      if (stillInWindow && data.count >= IP_MAX_SIGNUPS && data.ownerUid !== ownerUid) {
        return { blocked: true, reason: "ip" };
      }
    }

    const nowIso = new Date().toISOString();
    hardSnaps.forEach((snap, i) => {
      const ref = hardRefs[i];
      if (!snap.exists) {
        tx.set(ref, { ownerUid, firstSeenAt: nowIso, lastSeenAt: nowIso, hits: 1 });
      } else {
        tx.update(ref, { lastSeenAt: nowIso, hits: (snap.data().hits || 1) + 1 });
      }
    });

    if (ipRef) {
      if (!ipSnap.exists || ipSnap.data().resetAt <= now) {
        tx.set(ipRef, { ownerUid, count: 1, resetAt: now + IP_WINDOW_MS, firstSeenAt: nowIso, lastSeenAt: nowIso });
      } else {
        tx.update(ipRef, { count: ipSnap.data().count + 1, lastSeenAt: nowIso });
      }
    }

    return { blocked: false };
  });
}

// بيتنفّذ بـ/signup/connect-whatsapp لما يربط رقم واتساب بزنس فعلي. WABA ID موثّق عبر
// Meta OAuth (مو نص بيكتبه المستخدم بالفورم)، فهو أقوى إشارة من رقم الهاتف العادي — بيتسجّل
// بعد نجاح الربط، وبيحجب أي محاولة ربط تانية لنفس الـWABA بحساب مختلف مستقبلًا.
async function reserveWabaFingerprint(ownerUid, wabaId) {
  if (!wabaId) return { blocked: false };
  const ref = db.collection(COLLECTION).doc(`waba:${wabaId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data().ownerUid !== ownerUid) {
      return { blocked: true, reason: "waba" };
    }
    const nowIso = new Date().toISOString();
    if (!snap.exists) {
      tx.set(ref, { ownerUid, firstSeenAt: nowIso, lastSeenAt: nowIso, hits: 1, status: "pending" });
    } else {
      tx.update(ref, { lastSeenAt: nowIso, hits: (snap.data().hits || 1) + 1 });
    }
    return { blocked: false };
  });
}

async function confirmWabaFingerprint(ownerUid, wabaId) {
  if (!wabaId) return;
  const ref = db.collection(COLLECTION).doc(`waba:${wabaId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data().ownerUid === ownerUid) {
      tx.update(ref, { status: "confirmed", lastSeenAt: new Date().toISOString() });
    }
  });
}

async function releaseWabaFingerprint(ownerUid, wabaId) {
  if (!wabaId) return;
  const ref = db.collection(COLLECTION).doc(`waba:${wabaId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data().ownerUid === ownerUid && snap.data().status === "pending") tx.delete(ref);
  });
}

const REASON_MESSAGES = {
  whatsapp: "رقم الواتساب يلي حطيته مستخدم أصلاً بحساب تجريبي تاني.",
  phone: "رقم التواصل يلي حطيته مستخدم أصلاً بحساب تجريبي تاني.",
  website: "رابط الموقع يلي حطيته مستخدم أصلاً بحساب تجريبي تاني.",
  waba: "حساب الواتساب بزنس هيدا مربوط أصلاً بحساب تجريبي تاني.",
  ip: "في عدد كبير من الحسابات التجريبية اتسجّلت من نفس الشبكة خلال آخر شهر.",
};

function messageForReason(reason) {
  return (REASON_MESSAGES[reason] || "تم رصد استخدام سابق لبيانات مشابهة.") + " تواصل معنا لو حابب تكمل أو ترقّي لباقة مدفوعة.";
}

module.exports = { reserveSignupFingerprints, reserveWabaFingerprint, confirmWabaFingerprint, releaseWabaFingerprint, messageForReason, normalizePhone, normalizeDomain };
