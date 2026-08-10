const express = require("express");
const config = require("../config");
const registry = require("../clients/registry");
const deepseek = require("../services/deepseek");
const whatsapp = require("../services/whatsapp");
const customers = require("../services/customers");
const handoff = require("../services/handoff");
const replyCache = require("../services/replyCache");

const router = express.Router();

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

    const phoneNumberId = value.metadata.phone_number_id;
    const client = registry.getClientByWhatsappPhoneNumberId(phoneNumberId);
    if (!client) {
      console.warn(`لا يوجد عميل مسجّل لـ phone_number_id=${phoneNumberId}`);
      return;
    }

    const fromNumber = message.from;
    const userText = message.text.body;

    if (handoff.isConversationPaused(client.id, fromNumber)) {
      await whatsapp.sendTextMessage(fromNumber, phoneNumberId, handoff.buildStillWaitingReply(client));
      return;
    }

    if (handoff.checkKeywordEscalation(userText)) {
      const reply = handoff.buildEscalationReply(client);
      await whatsapp.sendTextMessage(fromNumber, phoneNumberId, reply);
      customers.saveTurn(client.id, fromNumber, userText, reply);
      await handoff.handleEscalation(client, { channel: "whatsapp", endUserId: fromNumber, lastMessage: userText });
      return;
    }

    const profile = customers.getProfile(client.id, fromNumber);
    const cacheable = profile.history.length === 0 && profile.facts.length === 0;

    const cachedReply = cacheable ? replyCache.get(client.id, userText) : null;
    if (cachedReply) {
      customers.saveTurn(client.id, fromNumber, userText, cachedReply);
      await whatsapp.sendTextMessage(fromNumber, phoneNumberId, cachedReply);
      return;
    }

    const { text: rawReply, toolsUsed } = await deepseek.getReply(client, profile, userText);
    const { escalated, cleanText } = handoff.extractEscalationMarker(rawReply);

    customers.saveTurn(client.id, fromNumber, userText, cleanText);
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
