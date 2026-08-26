const axios = require("axios");
const config = require("../config");

function graphUrl(path) {
  return `https://graph.facebook.com/${config.whatsapp.graphVersion}/${path}`;
}

function authHeaders() {
  return { Authorization: `Bearer ${config.whatsapp.token}` };
}

async function sendTextMessage(toPhoneNumber, phoneNumberId, text) {
  await axios.post(
    graphUrl(`${phoneNumberId}/messages`),
    {
      messaging_product: "whatsapp",
      to: toPhoneNumber,
      type: "text",
      text: { body: text },
    },
    {
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      timeout: 15_000,
    }
  );
}

// رسالة قالب معتمد (Template) — الإرسال الوحيد المسموح خارج نافذة خدمة الـ24 ساعة.
// bodyParams بتتعبّى بالترتيب على {{1}}, {{2}}, ... بنص القالب المعتمد عند Meta.
async function sendTemplateMessage(toPhoneNumber, phoneNumberId, templateName, languageCode = "ar", bodyParams = []) {
  await axios.post(
    graphUrl(`${phoneNumberId}/messages`),
    {
      messaging_product: "whatsapp",
      to: toPhoneNumber,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components: bodyParams.length
          ? [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text: String(text) })) }]
          : [],
      },
    },
    {
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      timeout: 15_000,
    }
  );
}

// تنزيل ملف ميديا وارد (رسالة صوتية مثلاً): Graph API بيعطي رابط مؤقت، والتنزيل نفسه
// محمي بنفس التوكن. حد أقصى 25MB (واتساب نفسه بيسقف الصوتي بـ16MB — احتياط فقط).
async function downloadMedia(mediaId, maxBytes = 25 * 1024 * 1024) {
  const meta = await axios.get(graphUrl(mediaId), {
    headers: authHeaders(),
    timeout: 15_000,
  });
  const url = meta.data?.url;
  if (!url) throw new Error("Graph API ما رجّع رابط تنزيل للميديا");

  const response = await axios.get(url, {
    headers: authHeaders(),
    responseType: "arraybuffer",
    timeout: 60_000,
    maxContentLength: maxBytes,
  });
  return Buffer.from(response.data);
}

module.exports = { sendTextMessage, sendTemplateMessage, downloadMedia };
