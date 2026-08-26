const crypto = require("crypto");
const express = require("express");
const config = require("../config");
const registry = require("../clients/registry");
const whatsapp = require("../services/whatsapp");
const transcribe = require("../services/transcribe");
const handoff = require("../services/handoff");
const messageGate = require("../services/messageGate");
const conversationEngine = require("../services/conversationEngine");

const router = express.Router();

// منع معالجة نفس الرسالة مرتين — Meta بتعيد إرسال الحدث أحيانًا (لو سيرفرنا تأخر بالرد أو
// أعاد تشغيل بنص المعالجة). بدون هيك، إعادة إرسال ممكن تولّد رد مكرر أو حتى طلبية مكرّرة
// (create_order). بالذاكرة بس، كافي لنافذة إعادة إرسال Meta (دقايق، مش أيام).
//
// ⚠️ دورة حياة العلامة مهمة: بتعليم "قيد المعالجة" فور الاستلام (يمنع إعادة إرسال متزامنة)،
// وبنحولها "منجزة" بس بعد نجاح كامل. لو فشلت المعالجة (DeepSeek/Meta وسط الطريق)، بينشال
// التعليم حتى ما يبتلع إعادة الإرسال التالي من Meta الرسالة للأبد (كان هالنقص يضيّع رسائل).
const processedMessageIds = new Map(); // messageId -> "processing" | "done"
const MESSAGE_ID_TTL_MS = 10 * 60 * 1000;

function alreadyClaimed(messageId, now) {
  for (const [id, entry] of processedMessageIds) {
    if (now - entry.at > MESSAGE_ID_TTL_MS) processedMessageIds.delete(id);
  }
  return processedMessageIds.has(messageId);
}

function claimMessage(messageId) {
  const now = Date.now();
  if (alreadyClaimed(messageId, now)) return false;
  processedMessageIds.set(messageId, { state: "processing", at: now });
  return true;
}

function markProcessed(messageId) {
  const entry = processedMessageIds.get(messageId);
  if (entry) {
    entry.state = "done";
    entry.at = Date.now();
  }
}

function releaseClaim(messageId) {
  // نمسح فقط إذا لسا "قيد المعالجة" — ما نلمس علامة "منجزة"
  const entry = processedMessageIds.get(messageId);
  if (entry?.state === "processing") processedMessageIds.delete(messageId);
}

// تحقق توقيع X-Hub-Signature-256 — بدون هالتحقق، أي حد يعرف رابط الويبهوك يقدر يزوّر رسائل
// واردة لأي عميل مسجّل (استهلاك DeepSeek، طلبات/حجوزات وهمية). Meta بتوقّع HMAC-SHA256 على
// الجسم الخام بـMETA_APP_SECRET. فشل مغلق: بدون سر مضبوط، بنرفض (403) — الويبهوك ما يشتغل
// أصلًا بدون ضبط السر.
function verifyMetaSignature(req, res, next) {
  const secret = config.meta.appSecret;
  if (!secret || typeof secret !== "string") {
    console.error(
      "[whatsapp] META_APP_SECRET غير مضبوط — رفضنا رسالة ويبهوك لأنه ما في إمكانية التحقق من التوقيع. عرّف المتغير بـ.env."
    );
    return res.sendStatus(403);
  }
  const header = req.get("x-hub-signature-256");
  if (!req.rawBody || typeof header !== "string" || !header.startsWith("sha256=")) {
    console.warn("[whatsapp] طلب ويبهوك بدون توقيع صالح الشكل — رفضناه");
    return res.sendStatus(403);
  }
  const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest();
  let received;
  try {
    received = Buffer.from(header.slice("sha256=".length), "hex");
  } catch {
    return res.sendStatus(403);
  }
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    console.warn("[whatsapp] توقيع X-Hub-Signature-256 غير مطابق — رفضنا الطلب (مصدر غير موثوق؟)");
    return res.sendStatus(403);
  }
  next();
}

// Meta بتستدعي هالـ endpoint مرة وحدة للتحقق من الويبهوك لما تربطه بلوحة التحكم.
// المقارنة بزمن ثابت حتى ما يتسرب الـverifyToken عبر قياس توقيت الرد حرفًا حرفًا.
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = String(req.query["hub.verify_token"] ?? "");
  const challenge = req.query["hub.challenge"];

  const expected = Buffer.from(String(config.whatsapp.verifyToken ?? ""));
  const received = Buffer.from(token);
  if (
    mode === "subscribe" &&
    expected.length > 0 &&
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received)
  ) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// كل رسالة واردة من واتساب بتوصل هون (نص أو صوتي)
router.post("/webhook", verifyMetaSignature, async (req, res) => {
  // نرجّع 200 فورًا — Meta بتعيد الإرسال لو تأخرنا، ومعالجة الرد ممكن تاخد وقت (استدعاء DeepSeek)
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    if (!message) return;

    const isText = message.type === "text" && typeof message.text?.body === "string";
    const isAudio = (message.type === "audio" || message.type === "voice") && (message.audio?.id || message.voice?.id);
    if (!isText && !isAudio) return; // صور/ملفات/مواقع... غير مدعومة لسا

    if (message.id && !claimMessage(message.id)) {
      console.warn(`[whatsapp] رسالة مكررة أو قيد المعالجة حاليًا (id=${message.id}) — تجاهلناها`);
      return;
    }

    const phoneNumberId = value.metadata.phone_number_id;
    const client = registry.getClientByWhatsappPhoneNumberId(phoneNumberId);
    if (!client) {
      console.warn(`لا يوجد عميل مسجّل لـ phone_number_id=${phoneNumberId}`);
      return;
    }

    const fromNumber = message.from;

    // ===== تحويل الصوتي لنص (لو رسالة صوتية) — بعدها المسار مطابق للنص تمامًا =====
    let userText;
    if (isText) {
      userText = message.text.body;
    } else {
      if (client.voice?.enabled === false) {
        await whatsapp.sendTextMessage(
          fromNumber,
          phoneNumberId,
          "الرد على الرسائل الصوتية مو مفعّل عندنا حالياً — اكتبلي سؤالك نصيًا وبقدر أساعدك فوراً."
        );
        markProcessed(message.id);
        return;
      }

      if (!transcribe.isConfigured()) {
        await whatsapp.sendTextMessage(fromNumber, phoneNumberId, handoff.buildServiceIssueReply(client));
        markProcessed(message.id);
        return;
      }

      // Meta بتوفر مدة الصوت بالثواني — منفحص قبل ما ننزل ولا ندفع للمزود
      const durationSec = Math.ceil(message.audio?.duration || message.voice?.duration || 30);
      const voiceGate = await messageGate.meterVoice(client, durationSec);
      if (!voiceGate.allowed) {
        await whatsapp.sendTextMessage(fromNumber, phoneNumberId, handoff.buildServiceIssueReply(client));
        markProcessed(message.id);
        return;
      }

      try {
        const audioBuffer = await whatsapp.downloadMedia(mediaId);
        const transcript = await transcribe.transcribeAudioBuffer(audioBuffer);
        if (!transcript || !transcript.trim()) throw new Error("نص فارغ من التحويل");
        userText = `[رسالة صوتية]: ${transcript.trim()}`;
      } catch (err) {
        console.error("[whatsapp] فشل تحويل الصوتي:", err.response?.data || err.message);
        await whatsapp.sendTextMessage(fromNumber, phoneNumberId, handoff.buildServiceIssueReply(client));
        markProcessed(message.id);
        return;
      }
    }

    // حواجز ثابتة (موقوف/قناة/باقة) — راجع services/messageGate.js
    const gate = messageGate.evaluateStatic(client, "whatsapp");
    if (!gate.allowed) {
      switch (gate.reason) {
        case "bot_paused":
          await whatsapp.sendTextMessage(
            fromNumber,
            phoneNumberId,
            `عذرًا، ${client.displayName} متوقف مؤقتًا عن الرد الآلي حاليًا. للتواصل المباشر: ${client.escalation.contactMethod} (${client.escalation.phone})`
          );
          return;
        case "channel_off":
          await whatsapp.sendTextMessage(
            fromNumber,
            phoneNumberId,
            `عذرًا، ${client.displayName} أوقف الرد الآلي عبر واتساب مؤقتًا. للتواصل المباشر: ${client.escalation.contactMethod} (${client.escalation.phone})`
          );
          return;
      }
    }

    // الوسط المشترك بين كل القنوات (تصعيد معلّق → كلمات → كاش → عدادات → DeepSeek)
    const result = await conversationEngine.handleInbound({
      client,
      channel: "whatsapp",
      endUserId: fromNumber,
      userText,
    });

    if (result.kind === "blocked") {
      // سياسة موحدة: أي سقف/نقص — الزبون بيوصله رسالة تحويل محايدة بدون ذكر السبب
      console.warn(`[whatsapp] عميل "${client.id}" منع بالسقف (${result.reason}) — بعتنا رسالة تحويل`);
      await whatsapp.sendTextMessage(fromNumber, phoneNumberId, handoff.buildServiceIssueReply(client));
      markProcessed(message.id);
      return;
    }

    await whatsapp.sendTextMessage(fromNumber, phoneNumberId, result.reply);
    markProcessed(message.id);
  } catch (err) {
    // نحرّر العلامة حتى ما يبتلع إعادة الإرسال التالي من Meta الرسالة (نافذة فقدان سابقة)
    const failedMessageId = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id;
    if (failedMessageId) releaseClaim(failedMessageId);
    console.error("whatsapp webhook error:", err.response?.data || err.message);

    // نفس السياسة: الزبون ما بينبهدل بصمت ولا بتفاصيل تقنية — رسالة تحويل محايدة
    try {
      const c = req.body?.entry?.[0]?.changes?.[0]?.value;
      const m = c?.messages?.[0];
      const phoneNumberId2 = c?.metadata?.phone_number_id;
      const client2 = phoneNumberId2 ? registry.getClientByWhatsappPhoneNumberId(phoneNumberId2) : null;
      if (m?.from && client2) {
        await whatsapp.sendTextMessage(m.from, phoneNumberId2, handoff.buildServiceIssueReply(client2));
        markProcessed(m.id);
      }
    } catch {
      /* أفضل جهد — ما في شي أكتر منقدر تعمله هون */
    }
  }
});

module.exports = router;
