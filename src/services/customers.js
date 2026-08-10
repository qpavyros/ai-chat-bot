// ذاكرة دائمة لكل زبون نهائي (لكل عميل) — بملف JSON، تنجو من إعادة تشغيل السيرفر.
// بعكس conversation.js (حالة "موقوف مؤقتًا" بعد تصعيد — RAM فقط، مقصود، مو مهم تنجو من إعادة تشغيل).
// نفس فلسفة appointments.js: ملف بسيط بدل قاعدة بيانات لحد ما يصير عندك حجم يبرر SQLite.
//
// saveTurn/addFact بيصيروا جوا safeWrite.withClientLock (قفل لكل عميل، مو لكل زبون — أبسط
// وكافي، التصادم المتوقع نادر: نفس الزبون بيبعت رسالتين بنفس الميلي ثانية) — كانوا قبل
// fs.writeFileSync عاري بدون أي حماية تزامن ولا نسخة احتياطية ولا مقاومة تلف.

const path = require("path");
const safeWrite = require("./safeWrite");
const { safeId } = require("./safe-id");

const MAX_TURNS = 8; // عدد الرسائل (مستخدم+بوت) المحفوظة بالسياق، لضبط تكلفة كل رد
const MAX_FACTS = 20; // حد أقصى للتفضيلات المحفوظة عن الزبون، حتى ما ينتفخ الـ system prompt بلا حدود

function profileRelativePath(userId) {
  return path.join("customers", `${safeId(userId)}.json`);
}

function profileAbsolutePath(clientId, userId) {
  return path.join(safeWrite.dataDir(clientId), profileRelativePath(userId));
}

function emptyProfile(userId) {
  return {
    userId,
    firstSeenAt: new Date().toISOString(),
    lastMessage: null,
    lastMessageAt: null,
    history: [],
    facts: [],
  };
}

function getProfile(clientId, userId) {
  return safeWrite.safeReadJSON(profileAbsolutePath(clientId, userId), emptyProfile(userId));
}

function saveTurn(clientId, userId, userMessage, botReply) {
  return safeWrite.withClientLock(clientId, () => {
    const profile = getProfile(clientId, userId);
    profile.history.push({ role: "user", content: userMessage });
    profile.history.push({ role: "assistant", content: botReply });
    profile.history = profile.history.slice(-MAX_TURNS * 2);
    profile.lastMessage = userMessage;
    profile.lastMessageAt = new Date().toISOString();
    safeWrite.rawWriteDataFile(clientId, profileRelativePath(userId), JSON.stringify(profile, null, 2));
  });
}

function addFact(clientId, userId, factText) {
  const trimmed = String(factText || "").trim();
  if (!trimmed) return;

  return safeWrite.withClientLock(clientId, () => {
    const profile = getProfile(clientId, userId);
    if (profile.facts.some((f) => f.text === trimmed)) return; // تفادي تكرار نفس المعلومة بالضبط

    profile.facts.push({ text: trimmed, savedAt: new Date().toISOString() });
    profile.facts = profile.facts.slice(-MAX_FACTS);
    safeWrite.rawWriteDataFile(clientId, profileRelativePath(userId), JSON.stringify(profile, null, 2));
  });
}

// النص يُحقن بالـ system prompt — null لو ما في شي محفوظ بعد (زبون جديد)
function formatProfileForPrompt(profile) {
  if (!profile.facts.length && !profile.lastMessage) return null;

  const lines = [];
  if (profile.facts.length) {
    lines.push("معلومات محفوظة عن هالزبون من محادثات سابقة:");
    for (const f of profile.facts) lines.push(`- ${f.text}`);
  }
  if (profile.lastMessage) {
    lines.push(`آخر سؤال طرحه سابقًا (بمحادثة سابقة، مش هلق): "${profile.lastMessage}"`);
  }
  return lines.join("\n");
}

module.exports = { getProfile, saveTurn, addFact, formatProfileForPrompt };
