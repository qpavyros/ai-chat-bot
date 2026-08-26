// تحويل الرسائل الصوتية لنص — عبر أي مزود بواجهة متوافقة مع OpenAI
// (Groq Whisper هو الموصى به: أرخص/أسرع بكثير، نفس الشكل بالضبط).
//
// بدون TRANSCRIBE_API_KEY الخدمة مطفية — isConfigured() بيرجع false والمستدعي (ويبهوك
// واتساب) بيرد برسالة مهذبة بدل ما يكسر شي.
const axios = require("axios");
const config = require("../config");

function isConfigured() {
  return Boolean(config.transcription?.apiKey);
}

/**
 * @param {Buffer} audioBuffer محتوى الملف الصوتي (ogg/opus من واتساب عادة)
 * @param {string} [filename] اسم يليح للمزود — بيحدد الاستنتاج عن الصيغة
 * @returns {Promise<string>} النص المستخرج
 */
async function transcribeAudioBuffer(audioBuffer, filename = "audio.ogg") {
  if (!isConfigured()) throw new Error("خدمة التحويل الصوتي غير مفعّلة (TRANSCRIBE_API_KEY ناقص)");

  // FormData/Blob مدمجين بـNode 18+ — بدون أي تبعية multipart إضافية
  const form = new FormData();
  form.append("file", new Blob([audioBuffer]), filename);
  form.append("model", config.transcription.model);
  if (config.transcription.language) {
    form.append("language", config.transcription.language); // ISO 639-1، "ar" افتراضيًا
  }
  form.append("response_format", "json");

  const response = await axios.post(
    `${config.transcription.baseUrl}/audio/transcriptions`,
    form,
    {
      headers: { Authorization: `Bearer ${config.transcription.apiKey}` },
      timeout: 60_000, // الصوتيات الطويلة بتاخد وقت
      maxContentLength: Infinity,
    }
  );

  return String(response.data?.text || "");
}

module.exports = { isConfigured, transcribeAudioBuffer };
