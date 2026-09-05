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
const jsonlLog = require("./jsonlLog");

const MAX_TURNS = 8; // عدد الرسائل (مستخدم+بوت) المحفوظة بالسياق، لضبط تكلفة كل رد
const MAX_FACTS = 20; // حد أقصى للتفضيلات المحفوظة عن الزبون، حتى ما ينتفخ الـ system prompt بلا حدود

function profileRelativePath(userId) {
  return path.join("customers", `${safeId(userId)}.json`);
}

// النسخة الكاملة الدائمة للمحادثة — السياق المرسل للنموذج مقصوص بـMAX_TURNES عمدًا، بس
// صاحب العمل بحاجة يشوف/يصدّر كل شي قيل. jsonl سطر لكل تبادل (سؤال+جواب)، بسقف حجم
// سخي حتى ما ينفجر القرص (2000 تبادل أخير لكل زبون).
function transcriptPath(clientId, userId) {
  return path.join(safeWrite.dataDir(clientId), "transcripts", `${safeId(userId)}.jsonl`);
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

async function saveTurn(clientId, userId, userMessage, botReply) {
  const profile = await safeWrite.withClientLock(clientId, () => {
    const profile = getProfile(clientId, userId);
    profile.history.push({ role: "user", content: userMessage });
    profile.history.push({ role: "assistant", content: botReply });
    profile.history = profile.history.slice(-MAX_TURNS * 2);
    profile.lastMessage = userMessage;
    profile.lastMessageAt = new Date().toISOString();
    safeWrite.rawWriteDataFile(clientId, profileRelativePath(userId), JSON.stringify(profile, null, 2));

    // النسخة الكاملة الدائمة — داخل نفس القفل حتى ما ينقلب ترتيب الأسطر بمحادثات متزامنة
    jsonlLog.appendCapped(
      transcriptPath(clientId, userId),
      { at: profile.lastMessageAt, user: userMessage, bot: botReply },
      { maxBytes: 512 * 1024, keepLast: 2000 }
    );
    return profile;
  });
  if (process.env.FIRESTORE_MIRROR_WRITES === "true") {
    await require("./storageRepository").mirrorBusinessData(clientId, `customer-${safeId(userId)}`, profile);
    await require("./storageRepository").mirrorBusinessData(clientId, `transcript-${safeId(userId)}`, readTranscript(clientId, userId, 2000));
  }
  return profile;
}

function readTranscript(clientId, userId, limit = 500) {
  return jsonlLog.readRecent(transcriptPath(clientId, userId), limit);
}

async function addFact(clientId, userId, factText) {
  const trimmed = String(factText || "").trim();
  if (!trimmed) return;

  const profile = await safeWrite.withClientLock(clientId, () => {
    const profile = getProfile(clientId, userId);
    if (profile.facts.some((f) => f.text === trimmed)) return profile; // تفادي تكرار نفس المعلومة بالضبط

    profile.facts.push({ text: trimmed, savedAt: new Date().toISOString() });
    profile.facts = profile.facts.slice(-MAX_FACTS);
    safeWrite.rawWriteDataFile(clientId, profileRelativePath(userId), JSON.stringify(profile, null, 2));
    return profile;
  });
  if (profile && process.env.FIRESTORE_MIRROR_WRITES === "true") {
    await require("./storageRepository").mirrorBusinessData(clientId, `customer-${safeId(userId)}`, profile);
  }
  return profile;
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

module.exports = { getProfile, saveTurn, addFact, formatProfileForPrompt, readTranscript, transcriptPath };
