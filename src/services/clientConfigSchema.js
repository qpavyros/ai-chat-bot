// تحقق بسيط ومقصود (مو مكتبة schema كاملة زي ajv — الحقول قليلة وثابتة، تحقق يدوي كافٍ
// وأوضح للقراءة). الهدف الوحيد: منع حفظ config.json ناقص/مكسور من الداشبورد يوقف البوت
// لحظة ما يجي طلب حقيقي (registry.js بيقرا هالملف بكل رسالة، بدون أي تحقق دفاعي هناك).
function validateClientConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return "config لازم يكون كائن";
  if (typeof cfg.id !== "string" || !cfg.id.trim()) return "id مطلوب";
  if (typeof cfg.displayName !== "string" || !cfg.displayName.trim()) return "displayName مطلوب";
  if (!cfg.escalation || typeof cfg.escalation !== "object") return "escalation مطلوب ككائن";
  if (typeof cfg.escalation.contactMethod !== "string" || !cfg.escalation.contactMethod.trim()) {
    return "escalation.contactMethod مطلوب";
  }
  if (cfg.appointments?.enabled) {
    const wh = cfg.appointments.workingHours;
    const hasGlobalHours = Boolean(wh?.start && wh?.end);
    // أو ساعات لكل يوم (byDay بمفاتيح 0-6) — راجع appointments.js hoursForDate
    const hasByDayHours = wh?.byDay && typeof wh.byDay === "object";
    if (!hasGlobalHours && !hasByDayHours) {
      return "appointments.workingHours لازم يكون فيه start/end عامين أو byDay لساعات كل يوم";
    }
    // تذكيرات اختيارية — تحقق خفيف من الشكل فقط (راجع appointmentReminders.js)
    const rem = cfg.appointments.reminders;
    if (rem !== undefined) {
      if (!rem || typeof rem !== "object" || rem.enabled !== true) {
        return "appointments.reminders لازم يكون كائن فيه enabled=true";
      }
      if (rem.hoursBefore !== undefined && (!Array.isArray(rem.hoursBefore) || rem.hoursBefore.some((h) => typeof h !== "number" || h <= 0))) {
        return "appointments.reminders.hoursBefore لازم تكون لائحة أرقام موجبة";
      }
    }
  }
  return null;
}

// قائمة الحقول المعروفة بـconfig.json — أي حقل غير موجود هون بينشال من جسم الطلب قبل الدمج.
// بدون هيك، `PUT /admin/api/clients/:id` كان يقبل أي JSON ويخزنه بحقل config.json جديد
// (mass assignment — حقول مفبركة ممكن تلثم بناء الـsystem prompt لاحقًا).
const CONFIG_TOP_LEVEL_KEYS = [
  "displayName",
  "language",
  "tone",
  "escalation",
  "contactEmail",
  "allowedOrigins",
  "status",
  "plan",
  "tier",
  "trialExpiresAt",
  "subscriptionExpiresAt",
  "knowledgeSourceLabel",
  "knowledgeReviewed",
  "source",
  "appointments",
  "orders",
  "onboardingChecklist",
  "botPaused",
  "salesMode",
  "channels",
  "businessHours",
  "widget",
  "voice",
  "topUpCreditsRemaining",
  "whatsappPhoneNumberId",
  "whatsappBusinessAccountId",
  "telegramBotToken",
  "telegramWebhookSecret",
  "discordBotToken",
  "referralCode",
  "referredByClientId",
  "referralRewarded",
  "paymentHistory",
  "createdAt",
];

const ESCALATION_KEYS = ["phone", "contactMethod", "notifyWhatsapp"];

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

// يرجّع نسخة نظيفة من req.body فيها الحقول المعروفة فقط (نسخة عميقة للحقول الكائنية حتى
// ما نشارك مرجع مع الطلب). id ما بينقبل من الجسم إطلاقًا — بيتحدد من مسار الطلب بس.
function pickClientConfigFields(body) {
  const clean = {};
  if (!isPlainObject(body)) return clean;
  for (const key of CONFIG_TOP_LEVEL_KEYS) {
    const value = body[key];
    if (value === undefined) continue;
    if (isPlainObject(value)) {
      clean[key] = key === "escalation"
        ? Object.fromEntries(ESCALATION_KEYS.filter((k) => value[k] !== undefined).map((k) => [k, String(value[k])]))
        : JSON.parse(JSON.stringify(value));
    } else {
      clean[key] = Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : value;
    }
  }
  return clean;
}

module.exports = { validateClientConfig, pickClientConfigFields };
