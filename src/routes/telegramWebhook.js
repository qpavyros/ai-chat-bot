// ويبهوك قناة Telegram — أرقى قناة من ناحية الإعداد: العميل يصنع بوت من BotFather بدقيقة
// ويعطي التوكن للأدمن، والتسجيل عند الإطلاق بيتم تلقائيًا.
//
// التحقق: Telegram بيبعت X-Telegram-Bot-Api-Secret-Token اللي إحنا حددناه بـsetWebhook
// (مخزن per-client بـtelegramWebhookSecret) — أي طلب بدون مطابقة بينرفض فورًا، حتى ما
// ينستهلك DeepSeek بطلبات مزورة.
const express = require("express");
const registry = require("../clients/registry");
const telegram = require("../services/telegram");
const messageGate = require("../services/messageGate");
const conversationEngine = require("../services/conversationEngine");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

router.post(
  "/webhook/telegram/:clientId",
  express.json(),
  asyncHandler(async (req, res) => {
    // Ack فوري — المعالجة بعدها (Telegram بيعيد الإرسال لو ما رددنا 200 بسريعة)
    res.sendStatus(200);

    try {
      const client = registry.getClientById(req.params.clientId);
      if (!client?.telegramBotToken) return;

      const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
      if (!client.telegramWebhookSecret || secretHeader !== client.telegramWebhookSecret) {
        console.warn(`[telegram] طلب بسرّ غير مطابق للبوت "${req.params.clientId}" — تجاهلنا`);
        return;
      }

      const message = req.body?.message;
      if (!message || typeof message.text !== "string" || !message.chat?.id) return; // صور/ملفات لسا غير مدعومة

      const chatId = String(message.chat.id);
      const gate = messageGate.evaluateStatic(client, "telegram");
      if (!gate.allowed) {
        // نفس أسلوب واتساب: رد مهذب للموقوف/المطفية، وسقوف بدون رسالة (تجنب سبام)
        if (gate.reason === "bot_paused") {
          await telegram.sendMessage(
            client.telegramBotToken,
            chatId,
            `عذرًا، ${client.displayName} متوقف مؤقتًا عن الرد الآلي حاليًا. للتواصل المباشر: ${client.escalation.contactMethod} (${client.escalation.phone})`
          );
        } else if (gate.reason === "channel_off") {
          await telegram.sendMessage(
            client.telegramBotToken,
            chatId,
            `عذرًا، ${client.displayName} أوقف الرد عبر تلغرام مؤقتًا. للتواصل المباشر: ${client.escalation.contactMethod} (${client.escalation.phone})`
          );
        }
        return;
      }

      const result = await conversationEngine.handleInbound({
        client,
        channel: "telegram",
        endUserId: chatId,
        userText: message.text,
      });

      if (result.kind === "blocked") {
        console.warn(`[telegram] "${client.id}" منع بالسقف (${result.reason}) — تجاهلنا`);
        return;
      }

      await telegram.sendMessage(client.telegramBotToken, chatId, result.reply);
    } catch (err) {
      console.error("telegram webhook error:", err.response?.data || err.message);
    }
  })
);

module.exports = router;
