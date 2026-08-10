// نقطة مرجعية وحيدة لـ "اليوم" بتوقيت بيروت — يستخدمها deepseek.js (بيخبر الذكاء الاصطناعي شو التاريخ)
// وappointments.js (بيرفض حجز بالماضي) حتى ما يختلفوا قرب منتصف الليل، لما توقيت UTC ولبنان يختلفوا بيوم كامل.
function todayInBeirut() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Beirut" });
}

// بيرجع {hours, minutes} — مو كائن Date، لأنه Date.getHours() بيستخدم توقيت السيرفر المحلي
// (UTC عادة عالـVPS)، مش بيروت. لازم نستخرج الساعة/الدقيقة من نص منسّق بتوقيت بيروت صراحة،
// وإلا بنقع بنفس فئة الباگ يلي وحّدنا هالملف بسببها أصلاً (راجع appointments.js).
function nowInBeirut() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Beirut",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const hours = Number(parts.find((p) => p.type === "hour").value);
  const minutes = Number(parts.find((p) => p.type === "minute").value);
  return { hours, minutes };
}

module.exports = { todayInBeirut, nowInBeirut };
