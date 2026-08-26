// استرجاع معجمي خفيف للمعرفة الكبيرة — الخطوة الأولى نحو RAG بدون أي تبعية أو API إضافي.
//
// المشكلة: قاعدة المعرفة كاملة كانت تنحقن بكل رسالة (سقف 60 ألف حرف) — غالية وبطيئة، و
// sanityCheck كان يرفض عملاء أكبر من هيك أصلاً.
//
// الحل هنا: لو المعرفة صغيرة (≤ FULL_INJECT_CHARS) تنحقن كاملة زي قبل — صفر تغيير للأغلبية.
// لو كبيرة: تتقسم chunks عند حدود الفقرات (memoized لكل نسخة عميل)، وكل رسالة بتقيّم
// الأجزاء بتطابق معجمي بعد تطبيع عربي (همزات/تاء مربوطة/تشكيل)، وبينحقن أعلى الأجزاء فقط
// ضمن ميزانية أحرف. لو ما في أي تطابق (صياغة مختلفة تمامًا) بنأخذ عينة موزعة من الأجزاء
// حتى يضل للبوت سياق عام عن الشركة.
const knowledgeChunks = new WeakMap(); // client object -> [{ text, tokens:Set }]

const FULL_INJECT_CHARS = 12_000; // تحتها الحقن الكامل أرخص وأدق من أي اختيار
const CHUNK_TARGET_CHARS = 1_200;
const SELECT_BUDGET_CHARS = 10_000;
const MAX_CHUNKS_SELECTED = 8;

function normalizeArabic(text) {
  return String(text)
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "") // تشكيل + تطويل
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
}

function tokenize(text) {
  const normalized = normalizeArabic(text);
  const tokens = normalized.split(/[^a-z0-9\u0600-\u06FF]+/).filter((t) => t.length >= 2);
  return new Set(tokens);
}

// التقسيم عند حدود فقرات/أسطر حتى ما ينقطع سياق المنتصف
function splitIntoChunks(knowledge) {
  const paragraphs = String(knowledge).split(/\n\s*\n/);
  const chunks = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (current && (current + "\n\n" + paragraph).length > CHUNK_TARGET_CHARS) {
      chunks.push(current.trim());
      current = paragraph;
    } else {
      current = current ? current + "\n\n" + paragraph : paragraph;
    }
    // فقرة وحيدة عملاقة (جداول PDF مستخرجة مثلاً) — نقسمها قسراً بالأسطر
    while (current.length > CHUNK_TARGET_CHARS * 2) {
      let cut = current.lastIndexOf("\n", CHUNK_TARGET_CHARS * 2);
      if (cut < CHUNK_TARGET_CHARS / 2) cut = CHUNK_TARGET_CHARS * 2;
      chunks.push(current.slice(0, cut).trim());
      current = current.slice(cut);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

function getIndexedChunks(client) {
  let indexed = knowledgeChunks.get(client);
  if (indexed) return indexed;

  indexed = splitIntoChunks(client.knowledge || "").map((text) => ({ text, tokens: tokenize(text) }));
  knowledgeChunks.set(client, indexed);
  return indexed;
}

/**
 * بيرجع نص المعرفة المناسب حقن بالنظام-برومبت لهالرسالة.
 * @param {object} client عميل من registry (نسخة جديدة عند أي تعديل ملف — WeakMap بينضيف حالها)
 * @param {string} userMessage رسالة الزبون الحالية
 */
function selectKnowledge(client, userMessage) {
  const knowledge = client.knowledge || "";
  if (!knowledge.trim()) return "";
  if (knowledge.length <= FULL_INJECT_CHARS) return knowledge; // المسار الحالي للأغلبية

  const chunks = getIndexedChunks(client);
  if (chunks.length === 0) return knowledge.slice(0, SELECT_BUDGET_CHARS);

  const queryTokens = tokenize(userMessage);

  // تقييم كل جزء: عدد كلمات السؤال الموجودة فيه (كل كلمة تحتسب مرة) + إشباع نسبي بحجم الجزء
  const scored = chunks.map((chunk, index) => {
    let hits = 0;
    for (const token of queryTokens) {
      if (chunk.tokens.has(token)) hits += 1;
    }
    const score = queryTokens.size > 0 ? hits / Math.sqrt(chunk.tokens.size || 1) : 0;
    return { index, score };
  });

  const relevant = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CHUNKS_SELECTED);

  let selected = relevant;

  // لا تطابق إطلاقًا — عينة موزعة (البدايات عادة فيها نظرة عامة عن الشركة)
  if (selected.length === 0) {
    const step = Math.max(1, Math.floor(chunks.length / MAX_CHUNKS_SELECTED));
    selected = [];
    for (let i = 0; i < chunks.length && selected.length < MAX_CHUNKS_SELECTED; i += step) {
      selected.push({ index: i, score: 0 });
    }
  }

  // تجميع ضمن ميزانية الأحرف مع الحفاظ على ترتيب النص الأصلي (سياق أنظف للنموذج)
  const pickedIndexes = [];
  let budget = SELECT_BUDGET_CHARS;
  for (const item of selected) {
    const size = chunks[item.index].text.length;
    if (size <= budget) {
      pickedIndexes.push(item.index);
      budget -= size;
    }
  }

  if (pickedIndexes.length === 0) return knowledge.slice(0, SELECT_BUDGET_CHARS);
  return pickedIndexes.sort((a, b) => a - b).map((i) => chunks[i].text).join("\n\n");
}

module.exports = { selectKnowledge, normalizeArabic, splitIntoChunks };
