const express = require("express");
const config = require("../config");
const deepseek = require("../services/deepseek");
const customers = require("../services/customers");
const handoff = require("../services/handoff");
const rateLimit = require("../services/rateLimit");
const replyCache = require("../services/replyCache");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

// ودجت الموقع بتستدعي هالـ endpoint. sessionId يجيء من الودجت (مولّد بالمتصفح ومحفوظ بـ localStorage).
// المصادقة (pk_/sk_/الوضع القديم) بتصير بـ authenticate middleware — بترتب req.client جاهز هون.
router.post("/chat/:clientId", authenticate({ allow: ["public", "secret"] }), async (req, res) => {
  try {
    const client = req.client;
    const { message, sessionId } = req.body;

    if (!message || !sessionId) {
      return res.status(400).json({ error: { code: "missing_fields", message: "message و sessionId مطلوبين" } });
    }

    // سقف رسائل خلال الفترة التجريبية — يحدّ كلفة أي بوت مهجور/معطّل تلقائيًا من عملاء
    // التسجيل الذاتي. عملاء يدويين (plan غير "trial") ما بينطبق عليهم هالسقف.
    if (client.plan === "trial") {
      const trialUsage = rateLimit.checkLimit(`trial-msgs:${client.id}`, {
        max: config.provisioning.trialMessageCap,
        windowMs: config.provisioning.trialDays * 24 * 60 * 60 * 1000,
      });
      if (!trialUsage.allowed) {
        return res.status(403).json({ error: { code: "trial_limit_reached", message: "وصلت لسقف رسائل الفترة التجريبية" } });
      }
    }

    // سقف عام لكل الخطط (مش بس trial) — يحمي من إساءة استخدام حقيقية (loop عالـendpoint،
    // مفتاح pk_ مسروق من كود الصفحة) بغض النظر عن نوع العميل. حدّين: لكل جلسة (ساعة)، ولكل عميل (يوم).
    const sessionUsage = rateLimit.checkLimit(`session-msgs:${client.id}:${sessionId}`, {
      max: config.abuseGuard.sessionHourlyMax,
      windowMs: 60 * 60 * 1000,
    });
    if (!sessionUsage.allowed) {
      return res.status(429).json({ error: { code: "rate_limited", message: "رسائل كتير بوقت قصير — جرب بعد شوي" } });
    }
    const clientDailyUsage = rateLimit.checkLimit(`client-daily-msgs:${client.id}`, {
      max: config.abuseGuard.clientDailyMax,
      windowMs: 24 * 60 * 60 * 1000,
    });
    if (!clientDailyUsage.allowed) {
      return res.status(429).json({ error: { code: "rate_limited", message: "وصلنا لسقف الرسائل اليومي — جرب بكرا" } });
    }

    if (handoff.isConversationPaused(client.id, sessionId)) {
      return res.json({ reply: handoff.buildStillWaitingReply(client) });
    }

    if (handoff.checkKeywordEscalation(message)) {
      const reply = handoff.buildEscalationReply(client);
      await customers.saveTurn(client.id, sessionId, message, reply);
      await handoff.handleEscalation(client, { channel: "web", endUserId: sessionId, lastMessage: message });
      return res.json({ reply });
    }

    const profile = customers.getProfile(client.id, sessionId);
    // "زبون أول-تواصل" بس — بدون تاريخ محادثة ولا معلومات محفوظة عنه. هاد الشرط الوحيد
    // اللي بيضمن رد الكاش ما محتوى شخصي/سياقي مرتبط بمحادثة سابقة (راجع replyCache.js).
    const cacheable = profile.history.length === 0 && profile.facts.length === 0;

    const cachedReply = cacheable ? replyCache.get(client.id, message) : null;
    if (cachedReply) {
      await customers.saveTurn(client.id, sessionId, message, cachedReply);
      return res.json({ reply: cachedReply });
    }

    const { text: rawReply, toolsUsed } = await deepseek.getReply(client, profile, message);
    const { escalated, cleanText } = handoff.extractEscalationMarker(rawReply);

    await customers.saveTurn(client.id, sessionId, message, cleanText);

    // ما نخزّن إلا رد "نظيف": زبون أول-تواصل + بدون استخدام أداة (حجز/فحص توفر/تذكّر معلومة) +
    // بدون تصعيد — أي واحدة من هالثلاثة بتعني الرد مرتبط بلحظة/زبون معيّن، مو جواب FAQ عام.
    if (cacheable && !toolsUsed && !escalated) {
      replyCache.set(client.id, message, cleanText);
    }

    if (escalated) {
      await handoff.handleEscalation(client, { channel: "web", endUserId: sessionId, lastMessage: message });
    }

    res.json({ reply: cleanText });
  } catch (err) {
    console.error("web chat error:", err.response?.data || err.message);
    res.status(500).json({ error: { code: "internal_error", message: "صار خطأ، جرب كمان شوي" } });
  }
});

module.exports = router;
