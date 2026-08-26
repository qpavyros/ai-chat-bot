const config = require("../config");
const whatsapp = require("./whatsapp");
const conversation = require("./conversation");
const { ESCALATE_MARKER } = require("./handoff-marker");
const escalationLog = require("./escalationLog");

// كلمات بتخلي البوت يوقف ويصعّد فورًا بدون حتى ما يسأل الذكاء الاصطناعي — بتوفر وقت وتكلفة،
// وبتضمن التصعيد يصير حتى لو الرد الآلي غلط تقييم الموقف. عدّل القائمة حسب اللهجة/اللغة يلي متوقعها.
const ESCALATION_KEYWORDS = [
  "بدي احكي مع حدا",
  "بدي احكي مع انسان",
  "بدي موظف",
  "حدا يرد",
  "احكي مع مسؤول",
  "مو رح احكي مع بوت",
  "مش بوت",
  "human",
  "real person",
  "talk to someone",
  "speak to agent",
];

function matchesKeyword(text) {
  const lower = text.toLowerCase();
  return ESCALATION_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
}

// بيشيل الماركر يلي الذكاء الاصطناعي بيضيفه بآخر رده لما يقرر التصعيد بنفسه (تعليمات هالسلوك موجودة بالـ system prompt)
function extractEscalationMarker(aiReplyText) {
  const escalated = aiReplyText.includes(ESCALATE_MARKER);
  const cleanText = aiReplyText.replace(ESCALATE_MARKER, "").trim();
  return { escalated, cleanText };
}

async function notifyBusinessOwner(client, { channel, endUserId, lastMessage }) {
  const notifyTo = client.escalation?.notifyWhatsapp;
  const senderPhoneNumberId = client.whatsappPhoneNumberId || config.whatsapp.notifySenderPhoneNumberId;

  if (!notifyTo || !senderPhoneNumberId) {
    console.warn(
      `[handoff] تصعيد لعميل "${client.id}" بس ما في notifyWhatsapp أو رقم مرسل مُعرَّف — ` +
      `الزبون (${channel}: ${endUserId}) طلب إنسان. آخر رسالة: "${lastMessage}"`
    );
    return;
  }

  const text =
    `🔔 تصعيد لإنسان — ${client.displayName}\n` +
    `القناة: ${channel === "whatsapp" ? "واتساب" : "ودجت الموقع"}\n` +
    `الزبون: ${endUserId}\n` +
    `آخر رسالة: "${lastMessage}"`;

  try {
    await whatsapp.sendTextMessage(notifyTo, senderPhoneNumberId, text);
  } catch (err) {
    console.error("[handoff] فشل إرسال إشعار التصعيد:", err.response?.data || err.message);
  }
}

// يُستدعى قبل استدعاء DeepSeek — تصعيد فوري بكلمة مفتاحية بدون استهلاك API
function checkKeywordEscalation(userText) {
  return matchesKeyword(userText);
}

async function handleEscalation(client, { channel, endUserId, lastMessage }) {
  conversation.pauseForHandoff(client.id, endUserId, config.handoff.pauseHours * 60 * 60 * 1000);
  escalationLog.record(client.id, { channel, endUserId, lastMessage });
  await notifyBusinessOwner(client, { channel, endUserId, lastMessage });
}

function isConversationPaused(clientId, endUserId) {
  return conversation.isPaused(clientId, endUserId);
}

// ردود ثابتة (مو من الذكاء الاصطناعي) — أسرع، أرخص، ومضمونة لما نعرف أكيد إنه لازم تصعيد
function buildEscalationReply(client) {
  return `تمام، حوّلت طلبك لفريقنا وح يتواصلوا معك قريبًا. لأي إستعجال: ${client.escalation.contactMethod} (${client.escalation.phone})`;
}

function buildStillWaitingReply(client) {
  return `لسا بننتظر حدا من فريق ${client.displayName} يتواصل معك. لأي إستعجال: ${client.escalation.contactMethod} (${client.escalation.phone})`;
}

// رد محايد لأي عطل داخلي (خلص توكنز المزود، انقطاع، سقف...) — سياسة ثابتة:
// الزبون بيوصله رسالة تحويل بس، بدون ذكر السبب التقني أبداً. نفس الصياغة مستخدمة
// بdeepseek.js كاحتياط (نسخة متطابقة حتى ما في تبعية دائرية).
function buildServiceIssueReply(client) {
  return (
    `عذرًا، ما قدرنا نكمل خدمتك بهاللحظة. تم تحويل طلبك لفريقنا وبتتواصل معك بأقرب وقت. ` +
    `للتواصل الفوري: ${client.escalation.contactMethod} (${client.escalation.phone})`
  );
}

module.exports = {
  ESCALATE_MARKER,
  extractEscalationMarker,
  checkKeywordEscalation,
  handleEscalation,
  isConversationPaused,
  buildEscalationReply,
  buildStillWaitingReply,
  buildServiceIssueReply,
};
