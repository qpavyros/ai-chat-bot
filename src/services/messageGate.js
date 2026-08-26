// البوابة الموحدة لرسائل الزبائن على القناتين (ودجت/واتساب) — على مرحلتين عمدًا:
//
// 1) evaluateStatic: حواجز بدون أي أثر جانبي (موقوف/قناة مطفية/باقة بدون ودجت) — بتشتغل
//    دائمًا أول شي حتى لو الرد جاي من الكاش أو رد كلمة تصعيد.
// 2) meterAndCap: عدادات الاستهلاك (trial/جلسة/يومي/شهري) — بتشتغلت **بس** لما رح نستدعي
//    DeepSeek فعليًا. ردود الكاش وكلمات التصعيد الجاهزة تكلفتهم صفر، فما منطقي تلتهم سقف
//    الفاتورة (كانت مشكلة حقيقية: FAQ متكرر بيخلّص سقف عميل بدون ما يوصل لـDeepSeek إطلاقًا).
//
// الفلسفة: التقييم بيرجع سبب المنع، والراوتر يقرر شكل الرد (HTTP status للودجت، رسالة واتساب
// أو تجاهل للويبهوك). ترتيب العدادات نفسه مطابق للنسخ القديمة.
const config = require("../config");
const rateLimit = require("./rateLimit");
const usageLedger = require("./usageLedger");
const usageAnomaly = require("./usageAnomaly");
const credits = require("./credits");

const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MONTHLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const KNOWN_CHANNELS = new Set(["web", "whatsapp", "telegram", "discord"]);

function channelKeyOf(channel) {
  // القنوات المعروفة ليها مفتاحها الخاص (حتى يقدر العميل يطفي قناة محددة)، وأي مستقبل
  // غير معروف بينعامل متل الويب كإجراء آمن.
  return KNOWN_CHANNELS.has(channel) ? channel : "web";
}

/**
 * حواجز ثابتة بدون آثار جانبية — تُفحص على كل رسالة واردة مهما كان مصدر الرد.
 * @param {object} client عميل من registry
 * @param {"web"|"whatsapp"|"telegram"|"discord"} channel
 * @returns {{allowed:true}|{allowed:false,reason:string}}
 */
function evaluateStatic(client, channel) {
  // البوت موقوف كليًا — رد ثابت بدون أي استهلاك
  if (client.botPaused) return { allowed: false, reason: "bot_paused" };

  const channelKey = channelKeyOf(channel);
  if (client.channels?.[channelKey]?.enabled === false) {
    return { allowed: false, reason: "channel_off" };
  }

  // باقة Starter تشمل واتساب بس (قرار المجلس 2026-08-12) — الودجت محجوز لـGrowth فما فوق.
  // القيد خاص بوودجت الموقع تحديدًا — تلغرام/ديسكورد ما منحصرهم بهالميزة.
  if (channelKey === "web" && client.tier && config.plans[client.tier]?.allowWidget === false) {
    return { allowed: false, reason: "widget_not_included" };
  }

  return { allowed: true };
}

/**
 * عدادات الاستهلاك + السقوف — استدعيها فقط قبل استدعاء DeepSeek فعليًا.
 * ⚠️ فيها آثار جانبية (زيادة عدادات) — نداء ثانٍ لنفس الرسالة بيعدّ مرتين.
 * @param {string|null} sessionId معرّف جلسة الودجت (باقي القنوات ما عندها سقف جلسة منفصل)
 */
async function meterAndCap(client, channel, sessionId = null) {
  const channelKey = channelKeyOf(channel);

  // سقف رسائل الفترة التجريبية — يحدّ كلفة أي بوت مهجور تلقائيًا (على القناتين).
  // رصيد الشحن بينفع يعديه كمان — تجربة موفقة = فرصة تحويل لشحن/اشتراك.
  if (client.plan === "trial") {
    const trialUsage = await usageLedger.checkAndIncrement(`trial-msgs:${client.id}`, {
      max: config.provisioning.trialMessageCap,
      windowMs: config.provisioning.trialDays * 24 * 60 * 60 * 1000,
    });
    if (!trialUsage.allowed) {
      if (await credits.consumeOne(client.id)) {
        return { allowed: true, usedCredit: true };
      }
      return { allowed: false, reason: "trial_cap" };
    }
  }

  // سقف الجلسة بالساعة — للودجت بس (بالويبهوك رقم الهاتف هو الجلسة والسقف اليومي يغطيه)
  if (channelKey === "web") {
    const sessionUsage = rateLimit.checkLimit(`session-msgs:${client.id}:${sessionId}`, {
      max: config.abuseGuard.sessionHourlyMax,
      windowMs: 60 * 60 * 1000,
    });
    if (!sessionUsage.allowed) return { allowed: false, reason: "session_cap" };
  }

  // سقف يومي عام لكل الخطط — حماية إساءة مستقلة عن الباقات
  const dailyUsage = rateLimit.checkLimit(`client-daily-msgs:${client.id}`, {
    max: config.abuseGuard.clientDailyMax,
    windowMs: DAILY_WINDOW_MS,
  });
  usageAnomaly.checkAndAlert(client, dailyUsage);
  if (!dailyUsage.allowed) return { allowed: false, reason: "daily_cap" };

  // سقف شهري حسب الباقة — عملاء يدويا قدما بدون tier ما بيتأثروا.
  // لو السقف منع: منجرب نخصم من رصيد الشحن (top-up) قبل ما نقول "خلص" — هيدا يلي
  // بيخلي الرصيد قيمة حقيقية عند العميل.
  const planDef = client.tier ? config.plans[client.tier] : null;
  if (planDef) {
    const monthlyUsage = await usageLedger.checkAndIncrement(`tier-monthly-msgs:${client.id}`, {
      max: planDef.monthlyMessageCap,
      windowMs: MONTHLY_WINDOW_MS,
    });
    if (!monthlyUsage.allowed) {
      if (await credits.consumeOne(client.id)) {
        return { allowed: true, usedCredit: true };
      }
      return { allowed: false, reason: "monthly_cap" };
    }
  }

  return { allowed: true };
}

/**
 * سقف ثواني الصوت الشهري للعميل، أو null لو بلا سقف (عميل يدوي بدون tier).
 */
function voiceCapSeconds(client) {
  const planDef = client.tier ? config.plans[client.tier] : null;
  if (planDef?.monthlyVoiceMinutes != null) return planDef.monthlyVoiceMinutes * 60;
  if (client.plan === "trial") return config.provisioning.trialVoiceMinutes * 60;
  return null;
}

/**
 * عدّاد دقائق/ثواني تحويل الصوت لنص — ينادى قبل تنزيل الميديا ونداء Groq حتى ما
 * ننصرف على صوت راح ينرفض. durationSec من حقل audio.duration تبع Meta.
 */
async function meterVoice(client, durationSec) {
  const cap = voiceCapSeconds(client);
  if (cap == null) return { allowed: true, capSeconds: null };

  const usage = await usageLedger.checkAndIncrement(`voice-seconds-monthly:${client.id}`, {
    max: cap,
    windowMs: MONTHLY_WINDOW_MS,
    amount: durationSec,
  });

  if (!usage.allowed) {
    // نفس فلسفة الرسائل: رصيد الشحن بينقذ الموقف قبل رسالة "خلص باقتك"
    if (await credits.consumeOne(client.id)) {
      return { allowed: true, capSeconds: cap, usedCredit: true };
    }
    return { allowed: false, reason: "voice_cap", capSeconds: cap };
  }

  return { allowed: true, capSeconds: cap };
}

module.exports = { evaluateStatic, meterAndCap, meterVoice, voiceCapSeconds };
