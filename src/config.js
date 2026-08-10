require("dotenv").config();

function required(name, fallback = undefined) {
  const value = process.env[name] ?? fallback;
  return value;
}

module.exports = {
  port: process.env.PORT || 3000,

  deepseek: {
    apiKey: required("DEEPSEEK_API_KEY"),
    baseUrl: required("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    model: required("DEEPSEEK_MODEL", "deepseek-chat"),
  },

  whatsapp: {
    token: required("WHATSAPP_TOKEN"),
    phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
    verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
    graphVersion: required("WHATSAPP_GRAPH_VERSION", "v21.0"),
    // رقم واتساب تبعك إنت (تحت نفس Business Manager)، يُستخدم بس لتنبيه أصحاب الأعمال
    // عند تصعيد محادثة لإنسان — مو للرد على الزبائن. مفيد خصوصًا للعملاء اللي عندهم
    // ودجت موقع بس بدون رقم واتساب مخصص لهم.
    notifySenderPhoneNumberId: required("NOTIFY_WHATSAPP_PHONE_NUMBER_ID"),
  },

  webWidgetKey: required("WEB_WIDGET_KEY"),
  // وضع مؤقت: بيقبل WEB_WIDGET_KEY القديم المشترك جنب مفاتيح pk_/sk_ الجديدة، حتى تنتقل
  // العملاء الحاليين تدريجيًا بدون ما ينكسر شي فورًا. طفّيه (false) بعد ما يخلص كل عميل انتقل.
  allowLegacyWidgetKey: required("ALLOW_LEGACY_WIDGET_KEY", "true") === "true",

  handoff: {
    // مدة وقف الرد الآلي بعد التصعيد لإنسان (بالساعات) — بعدها البوت بيرجع يرد عادي
    pauseHours: Number(required("HANDOFF_PAUSE_HOURS", "4")),
  },

  provisioning: {
    enabled: required("SIGNUP_ENABLED", "false") === "true",
    // رابط السيرفر العام — يُستخدم ببناء روابط التحقق بالإيميل وكود الودجت الجاهز
    publicBaseUrl: required("PUBLIC_BASE_URL", "http://localhost:3000"),
    // مدة الفترة التجريبية للعملاء يلي بيسجّلوا حالهم عبر التسجيل الذاتي (أيام)
    trialDays: Number(required("TRIAL_DAYS", "14")),
    // سقف رسائل الشات خلال فترة التجربة كلها — يحدّ كلفة أي بوت مهجور/معطّل تلقائيًا
    trialMessageCap: Number(required("TRIAL_MESSAGE_CAP", "200")),
    // رقم واتساب المشغّل الشخصي (إنت) — يوصله إشعار عند كل تسجيل ذاتي جديد
    operatorWhatsapp: required("OPERATOR_WHATSAPP"),
  },

  replyCache: {
    // كاش ردود بالذاكرة لأسئلة FAQ متكررة الصياغة — يوفر استدعاء DeepSeek بالكامل عند تطابق.
    // آمن عمدًا بنطاق ضيق (راجع replyCache.js): بس لزبون أول-تواصل بدون أداة استُخدمت بردّه.
    enabled: required("REPLY_CACHE_ENABLED", "true") === "true",
    ttlHours: Number(required("REPLY_CACHE_TTL_HOURS", "12")),
    maxEntries: Number(required("REPLY_CACHE_MAX_ENTRIES", "500")),
  },

  smtp: {
    // اختياري بالكامل. لو host مو معرّف، mailer.js بيرجع لوضع تطوير (يطبع رابط التحقق
    // بالـ console بدل ما يبعته). أي مزوّد SMTP عادي بيشتغل (Brevo، Gmail SMTP بـ app password، إلخ).
    host: required("SMTP_HOST"),
    port: Number(required("SMTP_PORT", "587")),
    user: required("SMTP_USER"),
    pass: required("SMTP_PASS"),
    from: required("SMTP_FROM", "no-reply@example.com"),
  },

  abuseGuard: {
    // سقف عام (كل الخطط، مو بس trial) — كان ناقص تمامًا: عميل غير-تجريبي (مدفوع/يدوي) ما
    // عنده أي حد أقصى، ومفتاح pk_ تبعه ظاهر بكود صفحته لأي حد يفتح devtools. حدا بيعمل loop
    // عالـendpoint كان بيستهلك رصيد DeepSeek تبعك إنت بلا حدود. اكتشاف مراجعة Opus (طبقة 1، بند 10).
    sessionHourlyMax: Number(required("SESSION_HOURLY_MSG_MAX", "30")),
    clientDailyMax: Number(required("CLIENT_DAILY_MSG_MAX", "500")),
  },

  admin: {
    // كلمة سر لوحة تحكم المشغّل (/admin) — مشغّل وحيد، فمقارنة نص ثابت (timing-safe) كافية.
    // لو فاضية، /admin بيرفض كل تسجيل دخول (فشل آمن، مو "مفتوح افتراضيًا").
    password: required("ADMIN_PASSWORD"),
    sessionTtlHours: Number(required("ADMIN_SESSION_TTL_HOURS", "12")),
  },
};
