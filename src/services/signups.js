// دورة حياة طلب تسجيل بوت جديد: in_progress → completed. بـFirestore (pendingSignups)
// بدل ملفات JSON — الهوية هلق حساب مستخدم مسجّل دخول فعليًا (Firebase session cookie، راجع
// src/routes/userAuth.js)، مش رابط إيميل مؤقت زي النسخة القديمة. هيك ما عاد محتاجين
// verifyToken/signupToken المنفصلين — تحقق ملكية الطلب هو بس: هل req.uid == record.ownerUid؟
//
// كل حساب بيقدر يكون عندو طلب واحد بس "قيد التنفيذ" بأي وقت (userAccounts.onboarding
// بيعكس هالحالة) — لهيك createPending بترجّع الطلب الموجود لو المستخدم كان عندو أصلاً
// طلب مو completed، بدل ما تنشئ نسخة ثانية.

const crypto = require("crypto");
const { db } = require("./firebaseAdmin");

const COLLECTION = "pendingSignups";
const MAX_KNOWLEDGE_ATTEMPTS = 5;

function pendingRef(pendingId) {
  return db.collection(COLLECTION).doc(pendingId);
}

async function createPending(ownerUid, { companyName, contactEmail, notifyWhatsapp, escalationPhone, websiteUrl, campaignCode }) {
  // لو عندو طلب قيد التنفيذ أصلاً، رجّعه بدل ما تنشئ وحدة تانية (idempotent).
  const existing = await db
    .collection(COLLECTION)
    .where("ownerUid", "==", ownerUid)
    .where("status", "==", "in_progress")
    .limit(1)
    .get();
  if (!existing.empty) return existing.docs[0].data();

  const pendingId = crypto.randomBytes(12).toString("hex");
  const record = {
    pendingId,
    ownerUid,
    companyName,
    contactEmail, // إيميل حساب Firebase تبع المستخدم — مش حقل نموذج، ثابت من هويته المسجّلة
    notifyWhatsapp,
    escalationPhone,
    websiteUrl,
    campaignCode: campaignCode || null,
    status: "in_progress",
    clientId: null, // بينحط بعد أول استيراد معرفة ناجح (POST /signup/knowledge)
    publicKey: null,
    knowledgeAttempts: 0,
    createdAt: new Date().toISOString(),
  };
  await pendingRef(pendingId).set(record);
  return record;
}

async function getPending(pendingId) {
  const snap = await pendingRef(pendingId).get();
  return snap.exists ? snap.data() : null;
}

async function incrementKnowledgeAttempts(pendingId) {
  const ref = pendingRef(pendingId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("طلب تسجيل غير موجود");
    const attempts = (snap.data().knowledgeAttempts || 0) + 1;
    tx.update(ref, { knowledgeAttempts: attempts });
    return attempts;
  });
}

async function attachClient(pendingId, clientId, publicKey) {
  await pendingRef(pendingId).update({ clientId, publicKey });
  return getPending(pendingId);
}

async function setWebsiteUrl(pendingId, websiteUrl) {
  await pendingRef(pendingId).update({ websiteUrl });
  return getPending(pendingId);
}

async function markCompleted(pendingId) {
  await pendingRef(pendingId).update({ status: "completed" });
  return getPending(pendingId);
}

module.exports = {
  createPending,
  getPending,
  incrementKnowledgeAttempts,
  attachClient,
  setWebsiteUrl,
  markCompleted,
  MAX_KNOWLEDGE_ATTEMPTS,
};
