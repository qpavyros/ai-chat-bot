// منطق ساعات الدوام المشترك — كان ب appointments.js بس، هلق صار يخدم كمان "الرد خارج
// الدوام" بالمحرك. صيغتان مدعومتان:
//   { start: "09:00", end: "17:00" }                     ساعات عامة لكل الأيام المفتوحة
//   { byDay: { "1": {start,end}, "5": {closed:true} } }   ساعات لكل يوم (0=أحد .. 6=سبت)
const { todayInBeirut } = require("./date-utils");

function dayOfWeek(dateStr) {
  // وقت ظهر UTC ثابت لتفادي انزياح التاريخ بالمناطق الزمنية
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

/**
 * ساعات يوم معيّن، أو null لو اليوم مغلق (بدون مدخل بـbyDay أو closed=true).
 * @param {{start?,end?,byDay?}} workingHours
 */
function hoursForDate(workingHours, dateStr) {
  if (!workingHours || typeof workingHours !== "object") return null;
  const byDay = workingHours.byDay;
  if (byDay && typeof byDay === "object") {
    const entry = byDay[String(dayOfWeek(dateStr))];
    if (!entry || entry.closed) return null;
    if (entry.start && entry.end) return entry;
  }
  if (workingHours.start && workingHours.end) return workingHours;
  return null;
}

function minutesSinceMidnight(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

/**
 * هل "الآن" (بتوقيت بيروت) ضمن ساعات دوام العميل؟
 * @param {{enabled:boolean, start?,end?,byDay?}} businessHours إعدادات config.businessHours
 */
function isWithinBusinessHours(businessHours) {
  if (!businessHours?.enabled) return true; // غير مفعّل = دايمًا مفتوح

  const today = todayInBeirut();
  const hours = hoursForDate(businessHours, today);
  if (!hours) return false; // يوم مغلق صراحةً

  const { hours: h, minutes } = require("./date-utils").nowInBeirut();
  const nowMinutes = h * 60 + minutes;
  const start = minutesSinceMidnight(hours.start);
  const end = minutesSinceMidnight(hours.end);
  if (end <= start) return false; // إعداد فاسد — نتعامل كأنه مغلق حتى ينتبه صاحب العمل

  return nowMinutes >= start && nowMinutes < end;
}

module.exports = { hoursForDate, isWithinBusinessHours };
