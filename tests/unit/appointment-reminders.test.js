// اختبارات وحدة لمنطق استحقاق تذكير المواعيد — دالة نقية بالكامل (بدون قرص ولا شبكة)
const { test } = require("node:test");
const assert = require("node:assert");
const { computeDueReminders } = require("../../src/services/appointmentReminders");

// "الآن" ثابت للاختبار: 2026-08-20 الساعة 10:00 بتوقيت بيروت (إطار زائف متسق)
const NOW = { date: "2026-08-20", hhmm: "10:00" };

function appt(date, time, extra = {}) {
  return { id: `${date}-${time}`, date, time, status: "confirmed", customerPhone: "+96131111", ...extra };
}

test("موعد بعد ~24 ساعة بيستحق عتبة 24 وبس", () => {
  const list = [appt("2026-08-21", "10:00")];
  const due = computeDueReminders(list, NOW, [24, 2]);
  assert.strictEqual(due.length, 1);
  assert.strictEqual(due[0].hoursKey, "24");
});

test("موعد بعد ساعة ونص بيستحق عتبة 2 بس", () => {
  const due = computeDueReminders([appt("2026-08-20", "11:30")], NOW, [24, 2]);
  assert.strictEqual(due.length, 1);
  assert.strictEqual(due[0].hoursKey, "2");
});

test("موعد داخل آخر 30 دقيقة قبل وقته بيستحق عتبة 2 (ما فات)", () => {
  const due = computeDueReminders([appt("2026-08-20", "10:30")], NOW, [24, 2]);
  assert.strictEqual(due.length, 1);
});

test("موعد فات وقته أو بعيد جدًا ما يستحق شي", () => {
  assert.deepStrictEqual(computeDueReminders([appt("2026-08-20", "09:00")], NOW, [24, 2]), []);
  assert.deepStrictEqual(computeDueReminders([appt("2026-08-25", "10:00")], NOW, [24, 2]), []);
});

test("مواعيد ملغاة/غير مؤكدة تنتجّل", () => {
  const due = computeDueReminders(
    [
      appt("2026-08-21", "10:00", { status: "cancelled" }),
      appt("2026-08-21", "10:30", { status: "pending" }),
    ],
    NOW,
    [24]
  );
  assert.deepStrictEqual(due, []);
});

test("تذكير مرسل مسبقاً لنفس العتبة ما بيتكرر", () => {
  const a = appt("2026-08-21", "10:00", { remindersSent: { "24": "2026-08-19T09:00:00Z" } });
  assert.deepStrictEqual(computeDueReminders([a], NOW, [24]), []);
});

test("سجلات تالفة التاريخ/الوقت ما بتكسر المسح", () => {
  const due = computeDueReminders(
    [
      { date: "not-a-date", time: "99:99", status: "confirmed" },
      null,
      appt("2026-08-21", "10:00"),
    ],
    NOW,
    [24]
  );
  assert.strictEqual(due.length, 1);
});
