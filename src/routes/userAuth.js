// تسجيل الدخول/التسجيل الموحّد لحساب المستخدم (راجع docs/site-restructure-plan.md قسم 4).
// المصادقة نفسها (كلمة السر) بتصير بالكامل بالفرونت إند عبر Firebase JS SDK — هالراوت بس
// يستلم الـID token الناتج، يتحقق منه، وينشئ جلسة سيرفر (session cookie من Firebase نفسها،
// stateless — ما بتضيع مع pm2 restart، بعكس portal_session القديمة).

const express = require("express");
const path = require("path");
const userAccounts = require("../services/userAccounts");
const rateLimit = require("../services/rateLimit");
const asyncHandler = require("../middleware/asyncHandler");
const { parseCookies, setSessionCookie, clearSessionCookie } = require("../middleware/sessionCookies");
const config = require("../config");

const router = express.Router();
const SESSION_COOKIE = "user_session";
const SESSION_TTL_MS = config.userAccounts.sessionTtlHours * 60 * 60 * 1000;

// Middleware — بيستخدمه أي route تاني (dashboard, بند إدارة بوت) محتاج تسجيل دخول حساب مستخدم.
async function requireUserAuth(req, res, next) {
  const cookies = parseCookies(req);
  const uid = await userAccounts.verifySessionCookie(cookies[SESSION_COOKIE]);
  if (!uid) return res.status(401).json({ error: { code: "not_authenticated", message: "غير مسجّل دخول" } });
  req.uid = uid;
  next();
}

router.get("/auth", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "auth.html"));
});

// App ID/API key وباقي حقول Firebase مش سرية أصلاً (بتنكشف بأي كود فرونت إند عادةً، محمية
// بقيود دومين من لوحة Firebase مش بالسرية) — بس منجيبها من endpoint بدل ما نكتبها مباشرة
// بـauth.html، حتى config.js يضل مصدر الحقيقة الوحيد (نفس فلسفة /signup/embedded-signup-config).
router.get("/auth/firebase-config", (req, res) => {
  res.json({
    apiKey: config.firebase.webApiKey,
    authDomain: config.firebase.authDomain,
    projectId: config.firebase.projectId,
    storageBucket: config.firebase.storageBucket,
    messagingSenderId: config.firebase.messagingSenderId,
    appId: config.firebase.appId,
  });
});

// الفرونت إند بيصير عندو ID token بعد createUserWithEmailAndPassword/signInWithEmailAndPassword/
// signInWithPopup (Google) — بيبعتلنا ياه هون، منتحقق منه ونبني جلسة سيرفر فوقه.
// rate limit حسب IP — كل نداء صالح بيكلف Firebase verify + Firestore write، وبدون حد
// كان ممكن يُستخدم كضغط غير محدود على الندائين.
router.post("/auth/session", async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const limited = rateLimit.checkLimit(`auth-session:${ip}`, { max: 20, windowMs: 15 * 60 * 1000 });
  if (!limited.allowed) {
    return res.status(429).json({ error: { code: "rate_limited", message: "محاولات كتيرة — جرب بعد شوي" } });
  }

  const { idToken } = req.body || {};
  if (!idToken) {
    return res.status(400).json({ error: { code: "missing_token", message: "idToken مطلوب" } });
  }

  try {
    const { auth } = require("../services/firebaseAdmin");
    const decoded = await auth.verifyIdToken(idToken);
    const profile = await userAccounts.ensureProfile(decoded.uid, decoded.email);

    const sessionCookie = await userAccounts.createSessionCookie(idToken, SESSION_TTL_MS);
    setSessionCookie(req, res, {
      name: SESSION_COOKIE,
      value: sessionCookie,
      maxAgeSeconds: SESSION_TTL_MS / 1000,
    });

    res.json({
      uid: profile.uid,
      email: profile.email,
      hasBots: profile.bots.length > 0,
      onboarding: profile.onboarding,
    });
  } catch (err) {
    console.error("[auth] فشل التحقق من idToken:", err.message);
    res.status(401).json({ error: { code: "invalid_token", message: "جلسة غير صالحة، جرب تسجّل دخول تاني" } });
  }
});

router.post("/auth/logout", (req, res) => {
  clearSessionCookie(res, SESSION_COOKIE);
  res.json({ ok: true });
});

router.get("/auth/me", requireUserAuth, asyncHandler(async (req, res) => {
  const profile = await userAccounts.getProfile(req.uid);
  if (!profile) return res.status(404).json({ error: { code: "profile_not_found", message: "ملف شخصي غير موجود" } });
  res.json(profile);
}));

// "ابدأ بوت جديد من الصفر" بشاشة استكمال الخطوات — بيمسح حالة onboarding العالقة بدون ما يلمس
// أي بوت مفعّل أصلاً (bots[] ما بتتأثر، هاي بس مؤشر "فيه تسجيل ناقص" أو لأ).
router.post("/auth/onboarding/restart", requireUserAuth, asyncHandler(async (req, res) => {
  await userAccounts.clearOnboardingState(req.uid);
  res.json({ ok: true });
}));

module.exports = { router, requireUserAuth };
