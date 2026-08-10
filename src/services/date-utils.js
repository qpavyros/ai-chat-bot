// نقطة مرجعية وحيدة لـ "اليوم" بتوقيت بيروت — يستخدمها deepseek.js (بيخبر الذكاء الاصطناعي شو التاريخ)
// وappointments.js (بيرفض حجز بالماضي) حتى ما يختلفوا قرب منتصف الليل، لما توقيت UTC ولبنان يختلفوا بيوم كامل.
function todayInBeirut() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Beirut" });
}

module.exports = { todayInBeirut };
