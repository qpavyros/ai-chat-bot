// اختبارات وحدة للاسترجاع المعجمي للمعرفة الكبيرة (RAG أولي بدون embeddings)
const { test } = require("node:test");
const assert = require("node:assert");
const { selectKnowledge, splitIntoChunks, normalizeArabic } = require("../../src/services/knowledgeRetrieval");

function bigKnowledge() {
  const sections = [];
  for (let i = 0; i < 40; i++) {
    sections.push(`# قسم رقم ${i}\n\nمعلومات عن خدمة رقم ${i}. أسعار الخدمة ${i} تبدأ من ${i * 10} دولار. ` +
      "نص حشو عام عن الشركة سياسات الضمان والتوصيل والدفع لملء الفقرة بحجم واقعي.".repeat(8));
  }
  // قسم واحد فيه كلمة مميزة ("بطاريات لابتوب") وسط المعرفة الكبيرة
  sections[23] = "# البطاريات\n\nعندنا بطاريات لابتوب أصلية بضمان سنة كاملة، السعر 45 دولار.\n" + "حشو. ".repeat(300);
  return sections.join("\n\n");
}

test("normalizeArabic بوحدّة الهمزات والتاء المربوطة والتشكيل", () => {
  assert.strictEqual(normalizeArabic("أَحْمَد"), "احمد");
  assert.strictEqual(normalizeArabic("مُحَمَّد"), "محمد");
  assert.strictEqual(normalizeArabic("مدرسة"), "مدرسه");
});

test("splitIntoChunks بيحترم الحد الأقصى التقريبي وبيرجع أجزاء غير فاضية", () => {
  const chunks = splitIntoChunks(bigKnowledge());
  assert.ok(chunks.length > 10, `المفروض يتقسم لأجزاء كتيرة، طلع ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 2600, "ما في جزء عملاق خارج السيطرة");
  }
});

test("معرفة صغيرة تنحقن كاملة (بدون أي تغيير سلوك)", () => {
  const client = { knowledge: "ساعات الدوام من 9 لـ5. العنوان بيروت." };
  const out = selectKnowledge(client, "شو ساعات الدوام؟");
  assert.strictEqual(out, client.knowledge);
});

test("معرفة كبيرة: الجزء المناسب بسؤال الزبون هو يلي بينحقن", () => {
  const knowledge = bigKnowledge();
  const client = { knowledge };
  assert.ok(knowledge.length > 12000, "الاختبار محتاج معرفة كبيرة");

  const out = selectKnowledge(client, "بدور على بطاريات لابتوب بضمان");
  assert.ok(out.includes("بطاريات لابتوب"), "لازم يشمل جزء البطاريات");
  assert.ok(out.length < knowledge.length / 2, `لازم يكون مختار مش كامل (${out.length} من ${knowledge.length})`);
});

test("معرفة كبيرة وصياغة مختلفة تمامًا: عينة موزعة ضمن الميزانية", () => {
  const client = { knowledge: bigKnowledge() };
  const out = selectKnowledge(client, "xyzabc qqq zzzz");
  assert.ok(out.length > 0 && out.length <= 11000, "في سياق عام ضمن الحد");
});
