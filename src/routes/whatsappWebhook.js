const express = require("express");
const config = require("../config");
const registry = require("../clients/registry");
const deepseek = require("../services/deepseek");
const whatsapp = require("../services/whatsapp");
const customers = require("../services/customers");
const handoff = require("../services/handoff");
const replyCache = require("../services/replyCache");
const rateLimit = require("../services/rateLimit");

const router = express.Router();

// منع معالجة نفس الرسالة مرتين — Meta بتعيد إرسال الحدث أحيانًا (لو سيرفرنا تأخر بالرد أو
// أعاد تشغيل بنص المعالجة). بدون هيك، إعادة إرسال ممكن تولّد رد مكرر أو حتى طلبية مكرّرة
// (create_order). بالذاكرة بس، كافي لنافذة إعادة إرسال Meta (دقايق، مش أيام).
const processedMessageIds = new Map(); // messageId -> processedAt
const MESSAGE_ID_TTL_MS = 10 * 60 * 1000;

function alreadyProcessed(messageId) {
  const now = Date.now();
  for (const [id, at] of processedMessageIds) {
    if (now - at > MESSAGE_ID_TTL_MS) processedMessageIds.delete(id);
  }
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.set(messageId, now);
  return false;
}

// Meta بتستدعي هالـ endpoint مرة وحدة للتحقق من الويبهوك لما تربطه بلوحة التحكم.
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.whatsapp.verifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// كل رسالة واردة من واتساب بتوصل هون
router.post("/webhook", async (req, res) => {
  // نرجّع 200 فورًا — Meta بتعيد الإرسال لو تأخرنا، ومعالجة الرد ممكن تاخد وقت (استدعاء DeepSeek)
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    if (!message || message.type !== "text") return;
    if (message.id && alreadyProcessed(message.id)) {
      console.warn(`[whatsapp] رسالة مكررة (id=${message.id}) — تجاهلناها`);
      return;
    }

    const phoneNumberId = value.metadata.phone_number_id;
    const client = registry.getClientByWhatsappPhoneNumberId(phoneNumberId);
    if (!client) {
      console.warn(`لا يوجد عميل مسجّل لـ phone_number_id=${phoneNumberId}`);
      return;
    }

    const fromNumber = message.from;
    const userText = message.text.body;

    const dailyUsage = rateLimit.checkLimit(`client-daily-msgs:${client.id}`, {
      max: config.abuseGuard.clientDailyMax,
      windowMs: 24 * 60 * 60 * 1000,
    });
    if (!dailyUsage.allowed) {
      console.warn(`[whatsapp] عميل "${client.id}" وصل لسقف الرسائل اليومي — تجاهلنا هالرسالة`);
      return;
    }

    if (handoff.isConversationPaused(client.id, fromNumber)) {
      await whatsapp.sendTextMessage(fromNumber, phoneNumberId, handoff.buildStillWaitingReply(client));
      return;
    }

    if (handoff.checkKeywordEscalation(userText)) {
      const reply = handoff.buildEscalationReply(client);
      await whatsapp.sendTextMessage(fromNumber, phoneNumberId, reply);
      await customers.saveTurn(client.id, fromNumber, userText, reply);
      await handoff.handleEscalation(client, { channel: "whatsapp", endUserId: fromNumber, lastMessage: userText });
      return;
    }

    const profile = customers.getProfile(client.id, fromNumber);
    const cacheable = profile.history.length === 0 && profile.facts.length === 0;

    const cachedReply = cacheable ? replyCache.get(client.id, userText) : null;
    if (cachedReply) {
      await customers.saveTurn(client.id, fromNumber, userText, cachedReply);
      await whatsapp.sendTextMessage(fromNumber, phoneNumberId, cachedReply);
      return;
    }

    const { text: rawReply, toolsUsed } = await deepseek.getReply(client, profile, userText);
    const { escalated, cleanText } = handoff.extractEscalationMarker(rawReply);

    await customers.saveTurn(client.id, fromNumber, userText, cleanText);
    await whatsapp.sendTextMessage(fromNumber, phoneNumberId, cleanText);

    if (cacheable && !toolsUsed && !escalated) {
      replyCache.set(client.id, userText, cleanText);
    }

    if (escalated) {
      await handoff.handleEscalation(client, { channel: "whatsapp", endUserId: fromNumber, lastMessage: userText });
    }
  } catch (err) {
    console.error("whatsapp webhook error:", err.response?.data || err.message);
  }
});

module.exports = router;
