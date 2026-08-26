// حسابات المستخدمين — كيان جديد فوق بنية العملاء/البوتات الحالية (راجع
// docs/site-restructure-plan.md قسم 3). حساب واحد بيقدر يملك أكتر من بوت (clientId).
//
// المصادقة (كلمة السر، إعادة تعيينها، تأكيد الإيميل) مفوّضة بالكامل لـFirebase Authentication —
// هيك منستفيد من "نسيت كلمة السر" جاهزة بدون ما نبنيها يدويًا (كانت ثغرة بالخطة الأصلية).
// بيانات الملف الشخصي (bots[]، حالة onboarding) بتعيش بـFirestore، مفتاحها Firebase UID.

const { db, auth } = require("./firebaseAdmin");

const USERS_COLLECTION = "users";

function userRef(uid) {
  return db.collection(USERS_COLLECTION).doc(uid);
}

// ===== ملف شخصي بـFirestore — يُنشأ أول لحظة دخول (تسجيل جديد أو دخول Google لأول مرة) =====
// التسجيل/الدخول نفسه بيصير بالكامل بالفرونت إند عبر Firebase JS SDK (createUserWithEmailAndPassword
// أو signInWithPopup لـGoogle) — كلمة السر ما بتمرّق عبر سيرفرنا أبدًا. أول ما يوصلنا الـID token
// (بعد signup أو أول signin)، منتأكد فيه ملف شخصي Firestore مطابق، وإذا لأ منُنشئه (upsert آمن —
// ما بيلمس bots/onboarding لو الملف موجود أصلاً).
async function ensureProfile(uid, email) {
  const ref = userRef(uid);
  const snap = await ref.get();
  if (snap.exists) return snap.data();

  const profile = {
    uid,
    email: String(email || "").trim().toLowerCase(),
    createdAt: new Date().toISOString(),
    bots: [],
    onboarding: null, // { pendingId, currentStep, lastUpdatedAt } لما يبلّش تسجيل بوت
  };
  await ref.set(profile);
  return profile;
}

// ===== جلسة سيرفر فوق Firebase Auth =====
// الفرونت إند بيسجّل دخول مباشرة عبر Firebase JS SDK (كلمة السر ما بتمرّق عبر سيرفرنا أبدًا)،
// وبيبعتلنا الـID token الناتج بس. منحوّله لـsession cookie رسمي من Firebase (JWT موقّع منهم،
// stateless بالكامل — ما محتاجين نخزّن الجلسات بالذاكرة متل portalAuth.js القديمة، وبالتالي
// ما بتضيع الجلسات مع كل pm2 restart).
async function createSessionCookie(idToken, ttlMs) {
  return auth.createSessionCookie(idToken, { expiresIn: ttlMs });
}

async function verifySessionCookie(sessionCookie) {
  try {
    const decoded = await auth.verifySessionCookie(sessionCookie, true /* checkRevoked */);
    return decoded.uid;
  } catch {
    return null;
  }
}

async function getProfile(uid) {
  const snap = await userRef(uid).get();
  if (!snap.exists) return null;
  return snap.data();
}

// ===== ربط بوت بحساب =====
async function attachBot(uid, clientId) {
  const ref = userRef(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("حساب غير موجود");
    const bots = snap.data().bots || [];
    if (!bots.includes(clientId)) {
      tx.update(ref, { bots: [...bots, clientId] });
    }
  });
}

// ===== حالة onboarding (استكمال من وين وقف) =====
async function setOnboardingState(uid, { pendingId, currentStep }) {
  await userRef(uid).update({
    onboarding: { pendingId, currentStep, lastUpdatedAt: new Date().toISOString() },
  });
}

async function clearOnboardingState(uid) {
  await userRef(uid).update({ onboarding: null });
}

module.exports = {
  ensureProfile,
  createSessionCookie,
  verifySessionCookie,
  getProfile,
  attachBot,
  setOnboardingState,
  clearOnboardingState,
};
