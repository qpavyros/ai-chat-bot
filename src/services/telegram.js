// عميل Telegram Bot API — أخف قناة إضافة: بوت مجاني لكل عميل من BotFather بدون أي
// موافقات أو مراجعات، ويبهوك HTTPS واحد مع secret token للتحقق.
const axios = require("axios");

const TELEGRAM_API = "https://api.telegram.org";

function botApi(token) {
  return `${TELEGRAM_API}/bot${token}`;
}

// تسجيل الويبهوك عند الإقلاع أو بعد ما الأدمن يحط توكن. Telegram يتطلب HTTPS صارم
// (PUBLIC_BASE_URL لازم يكون https وإلا الفحص عندهم برفض).
async function setWebhook(token, url, secretToken) {
  return axios.post(
    botApi(token) + "/setWebhook",
    {
      url,
      secret_token: secretToken,
      allowed_updates: ["message"], // رسائل فقط — لا callbacks ولا غيرها هالمرحلة
      drop_pending_updates: false,
    },
    { timeout: 15_000 }
  );
}

// حذف الويبهوك (فصل القناة)
async function deleteWebhook(token) {
  return axios.post(botApi(token) + "/deleteWebhook", {}, { timeout: 15_000 });
}

async function sendMessage(token, chatId, text) {
  return axios.post(
    botApi(token) + "/sendMessage",
    { chat_id: chatId, text },
    { timeout: 15_000 }
  );
}

// فحص صحة التوكن + جلب معلومات البوت (username يلي يشاركه العميل مع زبائنه)
async function getMe(token) {
  const res = await axios.get(botApi(token) + "/getMe", { timeout: 15_000 });
  return res.data?.result || null;
}

module.exports = { setWebhook, deleteWebhook, sendMessage, getMe };
