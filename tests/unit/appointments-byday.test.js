// اختبارات وحدة لساعات العمل لكل يوم (byDay) وتوليد الخانات
const { test } = require("node:test");
const assert = require("node:assert");

// appointments.js بيتطلب safeWrite (قرص فقط عند الاستدعاء) — الاستيراد آمن
const { getFreeSlots } = require("../../src/services/appointments");

function clientWith(workingHours, offDays = []) {
  return {
    id: "test-clinic",
    appointments: { workingHours, slotMinutes: 30, offDays },
  };
}

function nextFriday() {
  // نولّد تاريخ جمعة قادم بصيغة YYYY-MM-DD (getDay=5)
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

test("ساعات عامة start/end بتشتغل زي قبل", () => {
  const client = clientWith({ start: "09:00", end: "11:00" });
  const date = "2030-01-14"; // إثنين
  const slots = getFreeSlots(client, date);
  assert.deepStrictEqual(slots, ["09:00", "09:30", "10:00", "10:30"]);
});

test("byDay بيستخدم ساعات اليوم المطلوب تحديداً", () => {
  const client = clientWith({
    byDay: {
      "1": { start: "09:00", end: "11:00" }, // إثنين
      "2": { start: "10:00", end: "12:00" }, // ثلاثا — يوم الاختبار الحقيقي للفرق
    },
  });
  const tuesday = "2030-01-15";
  assert.deepStrictEqual(getFreeSlots(client, tuesday), ["10:00", "10:30", "11:00", "11:30"]);
});

test("يوم بدون مدخل بـbyDay أو closed=true = مغلق", () => {
  const client = clientWith({
    byDay: {
      "1": { start: "09:00", end: "17:00" },
      "5": { closed: true },
    },
  });
  assert.deepStrictEqual(getFreeSlots(client, "2030-01-15"), []); // ثلاثا غير معرف
  assert.deepStrictEqual(getFreeSlots(client, nextFriday()), []); // جمعة closed
});

test("offDays بتطبق فوق byDay كمان", () => {
  const monday = "2030-01-14";
  const client = clientWith({ byDay: { "1": { start: "09:00", end: "17:00" } } }, [1]);
  assert.deepStrictEqual(getFreeSlots(client, monday), []);
});
