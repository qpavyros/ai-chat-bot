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

// Dependencies with side-effects or eager initializations are deferred to where they are used.

const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MONTHLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const KNOWN_CHANNELS = new Set(["web", "whatsapp", "telegram", "discord"]);

function channelKeyOf(channel) {
  // القنوات المعروفة ليها مفتاحها الخاص (حتى يقدر العميل يطفي قناة محددة)، وأي مستقبل
  // غير معروف بينعامل متل الويب كإجراء آمن.
  return KNOWN_CHANNELS.has(channel) ? channel : "web";
}

const { evaluateClientEligibility } = require("./clientEligibility");

/**
 * حواجز ثابتة بدون آثار جانبية — تُفحص على كل رسالة واردة مهما كان مصدر الرد.
 * @param {object} client عميل من registry
 * @param {"web"|"whatsapp"|"telegram"|"discord"} channel
 * @returns {{allowed:true}|{allowed:false,reason:string}}
 */
function evaluateStatic(client, channel, now = Date.now()) {
  const eligibility = evaluateClientEligibility(client, now);
  if (!eligibility.allowed) {
    return eligibility;
  }

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

// إشعار صاحب البوت مرة وحدة باليوم بالحد الأقصى — بدون هيك كل رسالة زبون مرفوضة بعد الحد
// كانت رح تبعت واتساب لصاحب البوت (سبام حقيقي بيوم مزدحم).
function notifyCapReachedOncePerDay(client, reason) {
  const rateLimit = require("./rateLimit");
  const handoff = require("./handoff");
  const gate = rateLimit.checkLimit(`cap-notify:${client.id}:${reason}`, { max: 1, windowMs: DAILY_WINDOW_MS });
  if (gate.allowed) {
    handoff.notifyCapReached(client, reason).catch(() => {});
  }
}

// permit for preflight
const crypto = require("crypto");
const PERMIT_SECRET = crypto.randomBytes(32);
function signPermit(clientId, sessionId) {
  const hmac = crypto.createHmac("sha256", PERMIT_SECRET);
  hmac.update(`${clientId}:${sessionId || ""}`);
  return { clientId, sessionId, sig: hmac.digest("hex") };
}
function verifyPermit(client, sessionId, permit) {
  if (!permit || permit.clientId !== client.id || permit.sessionId !== sessionId) return false;
  const expected = signPermit(client.id, sessionId);
  return permit.sig === expected.sig;
}

/**
 * عدادات الاستهلاك + السقوف — استدعيها فقط قبل استدعاء DeepSeek فعليًا.
 * ⚠️ فيها آثار جانبية (زيادة عدادات) — نداء ثانٍ لنفس الرسالة بيعدّ مرتين.
 * @param {string|null} sessionId معرّف جلسة الودجت (باقي القنوات ما عندها سقف جلسة منفصل)
 * @param {object} [permit] تصريح preflight لتجنب عد الإساءة مرتين
 */
async function meterAndCap(client, channel, sessionId = null, permit = null) {
  const staticEval = evaluateStatic(client, channel);
  if (!staticEval.allowed) return staticEval;

  const usageLedger = require("./usageLedger");
  const credits = require("./credits");
  const rateLimit = require("./rateLimit");
  const usageAnomaly = require("./usageAnomaly");
  
  const channelKey = channelKeyOf(channel);

  const skipAbuse = verifyPermit(client, sessionId, permit);

  if (!skipAbuse) {
    if (channelKey === "web") {
      const sessionUsage = rateLimit.checkLimit(`session-msgs:${client.id}:${sessionId}`, {
        max: config.abuseGuard.sessionHourlyMax,
        windowMs: 60 * 60 * 1000,
      });
      if (!sessionUsage.allowed) return { allowed: false, reason: "session_cap" };
    }

    const dailyUsage = rateLimit.checkLimit(`client-daily-msgs:${client.id}`, {
      max: config.abuseGuard.clientDailyMax,
      windowMs: DAILY_WINDOW_MS,
    });
    usageAnomaly.checkAndAlert(client, dailyUsage);
    if (!dailyUsage.allowed) return { allowed: false, reason: "daily_cap" };
  }

  // الحسابات الجديدة ذات الملكية المثبتة تستهلك من رصيد الحساب مرة واحدة فقط.
  // الحسابات القديمة بلا ownerUid تبقى على العدادات القديمة حتى تكتمل تسوية الملكية.
  if (client.ownerUid && client.plan !== "trial") {
    const accountEntitlements = require("./accountEntitlements").createAccountEntitlements();
    const shared = await accountEntitlements.consumeMessage(client.ownerUid);
    if (shared.available) return { allowed: true, remainingMessages: shared.remainingMessages };
    if (shared.reason === "message_cap") {
      const credit = await accountEntitlements.consumeCredit(client.ownerUid);
      if (credit.available) return { allowed: true, usedCredit: true, remainingCredits: credit.remainingCredits };
      notifyCapReachedOncePerDay(client, "account_message_cap");
      return { allowed: false, reason: "monthly_cap" };
    }
  }

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
      notifyCapReachedOncePerDay(client, "trial_cap");
      return { allowed: false, reason: "trial_cap" };
    }
    return { allowed: true };
  }

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
      notifyCapReachedOncePerDay(client, "monthly_cap");
      return { allowed: false, reason: "monthly_cap" };
    }
  }

  return { allowed: true };
}

/**
 * سقف ثواني الصوت الشهري للعميل، أو null لو بلا سقف (عميل يدوي بدون tier).
 */
function voiceCapSeconds(client) {
  if (client.plan === "trial") return config.provisioning.trialVoiceMinutes * 60;
  const planDef = client.tier ? config.plans[client.tier] : null;
  if (planDef?.monthlyVoiceMinutes != null) return planDef.monthlyVoiceMinutes * 60;
  return null;
}

/**
 * حاجز الإساءة المبكر — يستدعى قبل التنزيل والنسخ. 
 * يُرجع تصريحًا (permit) يُمرر لاحقًا لتجنب العد المزدوج.
 */
function preflightAbuse(client, channel, sessionId = null) {
  const staticEval = evaluateStatic(client, channel);
  if (!staticEval.allowed) return staticEval;

  const rateLimit = require("./rateLimit");
  const usageAnomaly = require("./usageAnomaly");
  const channelKey = channelKeyOf(channel);

  if (channelKey === "web") {
    const sessionUsage = rateLimit.checkLimit(`session-msgs:${client.id}:${sessionId}`, {
      max: config.abuseGuard.sessionHourlyMax,
      windowMs: 60 * 60 * 1000,
    });
    if (!sessionUsage.allowed) return { allowed: false, reason: "session_cap" };
  }

  const dailyUsage = rateLimit.checkLimit(`client-daily-msgs:${client.id}`, {
    max: config.abuseGuard.clientDailyMax,
    windowMs: DAILY_WINDOW_MS,
  });
  usageAnomaly.checkAndAlert(client, dailyUsage);
  if (!dailyUsage.allowed) return { allowed: false, reason: "daily_cap" };

  return { allowed: true, permit: signPermit(client.id, sessionId) };
}

/**
 * حجز ثواني الصوت مع preflight إساءة
 */
async function meterVoice(client, durationSec, options = {}) {
  const { channel = "whatsapp", sessionId, operationId, permit: providedPermit } = options;
  const staticEval = evaluateStatic(client, channel);
  if (!staticEval.allowed) return staticEval;

  if (typeof durationSec !== "number" || !Number.isFinite(durationSec) || durationSec <= 0) {
    return { allowed: false, reason: "invalid_duration" };
  }

  const skipAbuse = verifyPermit(client, sessionId, providedPermit);
  let permit = providedPermit;

  if (!skipAbuse) {
    const rateLimit = require("./rateLimit");
    const usageAnomaly = require("./usageAnomaly");
    const channelKey = channelKeyOf(channel);

    if (channelKey === "web") {
      const sessionUsage = rateLimit.checkLimit(`session-msgs:${client.id}:${sessionId}`, {
        max: config.abuseGuard.sessionHourlyMax,
        windowMs: 60 * 60 * 1000,
      });
      if (!sessionUsage.allowed) return { allowed: false, reason: "session_cap" };
    }

    const dailyUsage = rateLimit.checkLimit(`client-daily-msgs:${client.id}`, {
      max: config.abuseGuard.clientDailyMax,
      windowMs: DAILY_WINDOW_MS,
    });
    usageAnomaly.checkAndAlert(client, dailyUsage);
    if (!dailyUsage.allowed) return { allowed: false, reason: "daily_cap" };

    permit = signPermit(client.id, sessionId);
  }

  const cap = voiceCapSeconds(client);
  if (cap == null) return { allowed: true, permit, capSeconds: null };

  const usageLedger = require("./usageLedger");
  const credits = require("./credits");

  if (client.ownerUid && client.plan !== "trial") {
    const accountEntitlements = require("./accountEntitlements").createAccountEntitlements();
    const shared = await accountEntitlements.reserveVoice(client.ownerUid, durationSec, operationId);
    if (shared.allowed) {
      return { allowed: true, permit, capSeconds: cap, reservation: { kind: "account", id: shared.reservationId } };
    }
    if (shared.reason === "voice_cap") {
      const creditRes = await accountEntitlements.reserveCredit(client.ownerUid, operationId);
      if (creditRes?.allowed) return { allowed: true, permit, capSeconds: cap, usedCredit: true, reservation: { kind: "account-credit", id: creditRes.reservationId } };
      return { allowed: false, reason: "voice_cap", capSeconds: cap };
    }
  }
  
  try {
    const res = await usageLedger.reserve(`voice-seconds-monthly:${client.id}`, {
      max: cap,
      windowMs: MONTHLY_WINDOW_MS,
      amount: durationSec,
      operationId: operationId
    });
    if (res.allowed) {
      return { allowed: true, permit, capSeconds: cap, reservation: { kind: 'ledger', id: res.reservationId } };
    }
  } catch (e) {
    if (e.message !== "conflict" && e.message !== "duplicate") {
      console.warn("Reserve voice error", e);
    }
  }

  // Fallback to top-up
  const creditRes = await credits.reserveOne(client.id, operationId);
  if (creditRes && creditRes.allowed) {
    return { allowed: true, permit, capSeconds: cap, usedCredit: true, reservation: { kind: 'credit', id: creditRes.reservationId } };
  }

  return { allowed: false, reason: "voice_cap", capSeconds: cap };
}

async function commitVoiceReservation(client, reservation) {
  if (!reservation) return;
  if (reservation.kind === 'account') {
    const accountEntitlements = require("./accountEntitlements").createAccountEntitlements();
    await accountEntitlements.commitVoiceReservation(reservation.id);
  } else if (reservation.kind === 'account-credit') {
    const accountEntitlements = require("./accountEntitlements").createAccountEntitlements();
    await accountEntitlements.commitCreditReservation(reservation.id);
  } else if (reservation.kind === 'ledger') {
    const usageLedger = require("./usageLedger");
    await usageLedger.commitReservation(reservation.id);
  } else if (reservation.kind === 'credit') {
    const credits = require("./credits");
    await credits.commitReservation(client.id, reservation.id);
  }
}

async function refundVoiceReservation(client, reservation) {
  if (!reservation) return;
  if (reservation.kind === 'account') {
    const accountEntitlements = require("./accountEntitlements").createAccountEntitlements();
    await accountEntitlements.refundVoiceReservation(reservation.id);
  } else if (reservation.kind === 'account-credit') {
    const accountEntitlements = require("./accountEntitlements").createAccountEntitlements();
    await accountEntitlements.refundCreditReservation(reservation.id);
  } else if (reservation.kind === 'ledger') {
    const usageLedger = require("./usageLedger");
    await usageLedger.refundReservation(reservation.id);
  } else if (reservation.kind === 'credit') {
    const credits = require("./credits");
    await credits.refundReservation(client.id, reservation.id);
  }
}

module.exports = { evaluateStatic, meterAndCap, preflightAbuse, meterVoice, commitVoiceReservation, refundVoiceReservation, voiceCapSeconds };
