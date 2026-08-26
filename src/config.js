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
    // أسعار تقديرية لكل مليون توكن — للإحصائيات فقط (مو فاتورة). حدّثها لو تغيرت
    // تسعيرة DeepSeek أو بدلت الموديل.
    priceInPerMillion: Number(required("DEEPSEEK_PRICE_IN_PER_M", "0.27")),
    priceOutPerMillion: Number(required("DEEPSEEK_PRICE_OUT_PER_M", "1.10")),
  },

  // WhatsApp Embedded Signup (Meta for Developers) — بيسمح للعميل يربط رقم واتساب البزنس
  // تبعه بنفسه بضغطة زر بدل خطوات يدوية، قرار المعمارية: كل عميل WABA خاص فيه (راجع الذاكرة
  // ai-customer-service-whatsapp-architecture) — هالإعداد بيخليه يمنح صلاحية لـSystem User
  // تبعنا (WHATSAPP_TOKEN فوق) على WABA تبعو هو، بدون ما نحتاج توكن منفصل لكل عميل.
  meta: {
    appId: required("META_APP_ID"),
    appSecret: required("META_APP_SECRET"), // ⚠️ لا تُدخل هالقيمة بأي محادثة — تُضاف مباشرة بـ.env على السيرفر
    configId: required("META_EMBEDDED_SIGNUP_CONFIG_ID"),
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
    trialDays: Number(required("TRIAL_DAYS", "7")),
    // سقف رسائل الشات خلال فترة التجربة كلها — يحدّ كلفة أي بوت مهجور/معطّل تلقائيًا
    trialMessageCap: Number(required("TRIAL_MESSAGE_CAP", "120")),
    // سقف دقائق الصوت خلال التجربة — أصغر من الباقات حتى ما تنستهك مجانًا
    trialVoiceMinutes: Number(required("TRIAL_VOICE_MINUTES", "5")),
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

  streaming: {
    // بث ردود الودجت (SSE) — أول حرف بيوصال خلال ~نص ثانية بدل انتظار الرد كامل.
    // أي فشل بالبث بينزل تلقائيًا للمسار العادي. طفّيه بـWIDGET_STREAMING=false لو حصلت
    // مشكلة مع proxy معيّن.
    enabled: required("WIDGET_STREAMING", "true") === "true",
  },

  transcription: {
    // تحويل الرسائل الصوتية لنص — أي مزود بواجهة متوافقة مع OpenAI.
    // Groq Whisper هو الموصى به (https://console.groq.com): أرخص وأسرع بكثير من OpenAI
    // وبنفس شكل النداء. بدون TRANSCRIBE_API_KEY الخدمة مطفية تمامًا والويبهوك بيرد برسالة
    // مهذبة على أي رسالة صوتية.
    baseUrl: required("TRANSCRIBE_BASE_URL", "https://api.groq.com/openai/v1"),
    apiKey: required("TRANSCRIBE_API_KEY"),
    model: required("TRANSCRIBE_MODEL", "whisper-large-v3-turbo"),
    language: required("TRANSCRIBE_LANGUAGE", "ar"), // ISO 639-1، فاضي = كشف تلقائي
  },

  abuseGuard: {
    // سقف عام (كل الخطط، مو بس trial) — كان ناقص تمامًا: عميل غير-تجريبي (مدفوع/يدوي) ما
    // عنده أي حد أقصى، ومفتاح pk_ تبعه ظاهر بكود صفحته لأي حد يفتح devtools. حدا بيعمل loop
    // عالـendpoint كان بيستهلك رصيد DeepSeek تبعك إنت بلا حدود. اكتشاف مراجعة Opus (طبقة 1، بند 10).
    sessionHourlyMax: Number(required("SESSION_HOURLY_MSG_MAX", "30")),
    clientDailyMax: Number(required("CLIENT_DAILY_MSG_MAX", "500")),
  },

  backupSheets: {
    // نسخ احتياطي دوري (child_process.fork منفصل — تعليق/فشل باستدعاء Google ما بيأثر عالسيرفر
    // الحي أبدًا) لبيانات data/ إلى Google Sheet، راجع scripts/backup-to-sheets.js للتفاصيل.
    enabled: required("BACKUP_SHEETS_ENABLED", "false") === "true",
    intervalMinutes: Number(required("BACKUP_SHEETS_INTERVAL_MINUTES", "30")),
  },

  admin: {
    // كلمة سر لوحة تحكم المشغّل (/admin) — مشغّل وحيد، فمقارنة نص ثابت (timing-safe) كافية.
    // لو فاضية، /admin بيرفض كل تسجيل دخول (فشل آمن، مو "مفتوح افتراضيًا").
    password: required("ADMIN_PASSWORD"),
    sessionTtlHours: Number(required("ADMIN_SESSION_TTL_HOURS", "12")),
  },

  // الباقات المتدرّجة — قرار مجلس LLM (2026-08-12، council-report-20260812.html):
  // 3 باقات بلا setup fee، السعر على القناة/الحد الشهري مش على "الميزات" التفصيلية.
  // ⚠️ حقل العميل المطابق اسمه client.tier ("starter"|"growth"|"pro")، مش client.plan —
  // client.plan مستخدم أصلاً بمعنى مختلف تمامًا ("trial" مقابل "manual"، راجع provisioning.js
  // وwebChat.js/whatsappWebhook.js لسقف رسائل التجربة). عميل بدون tier (undefined) = عميل
  // يدوي قديم أو تجريبي لسا ما تحدد له tier، بدون أي قيد إضافي فوق سقف abuseGuard العام.
  //
  // monthlyVoiceMinutes: سقف دقائق تحويل الصوت لنص شهريًا لكل باقة — قرار 2026-08-23.
  // مدروس عمدًا: Starter كافي لاستخدام خفيف، Growth/Pro أوسع. العميل يقدر يعطّل الميزة
  // كليًا من voice.enabled.
  plans: {
    starter: { price: 29, monthlyMessageCap: 500, monthlyVoiceMinutes: 15, allowWidget: false },
    growth: { price: 59, monthlyMessageCap: 1500, monthlyVoiceMinutes: 45, allowWidget: true },
    pro: { price: 99, monthlyMessageCap: 5000, monthlyVoiceMinutes: 120, allowWidget: true },
  },

  topUpPacks: {
    // باقات شحن رصيد رسائل إضافية — تسعيرها أعلى من سعر الرسالة داخل أي باقة عمدًا
    // ($0.080/$0.070 مقابل $0.058/$0.039/$0.020 بالباقات) حتى يبقى الاشتراك الخيار الأذكى.
    small: { credits: 100, priceUsd: 8 },
    medium: { credits: 300, priceUsd: 21 },
  },

  referral: {
    // شهرين مجانين لكل طرف — بس ينزل الحافز يدويًا من المشغّل بس بعد ما يتأكد العميل
    // المُحال دفع شهرين متتاليين فعليًا (مش مجرد تسجيل)، حسب قرار المجلس.
    rewardMonths: 2,
  },

  // Firebase (2026-08-15) — Firestore + Authentication لطبقة البيانات الجديدة (حسابات مستخدمين،
  // بوتات متعددة لكل حساب، إلخ). راجع docs/site-restructure-plan.md. المحادثات لسا بره Firebase
  // عمدًا (بتترفع لاحقًا على Google Drive، بند منفصل).
  firebase: {
    projectId: required("FIREBASE_PROJECT_ID"),
    credentialsPath: required("GOOGLE_APPLICATION_CREDENTIALS"),
    webApiKey: required("FIREBASE_WEB_API_KEY"),
    authDomain: required("FIREBASE_AUTH_DOMAIN"),
    storageBucket: required("FIREBASE_STORAGE_BUCKET"),
    messagingSenderId: required("FIREBASE_MESSAGING_SENDER_ID"),
    appId: required("FIREBASE_APP_ID"),
  },

  userAccounts: {
    sessionTtlHours: Number(required("USER_SESSION_TTL_HOURS", "720")), // 30 يوم افتراضيًا
  },
};
