// تحقق بسيط ومقصود (مو مكتبة schema كاملة زي ajv — الحقول قليلة وثابتة، تحقق يدوي كافٍ
// وأوضح للقراءة). الهدف الوحيد: منع حفظ config.json ناقص/مكسور من الداشبورد يوقف البوت
// لحظة ما يجي طلب حقيقي (registry.js بيقرا هالملف بكل رسالة، بدون أي تحقق دفاعي هناك).
function validateClientConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return "config لازم يكون كائن";
  if (typeof cfg.id !== "string" || !cfg.id.trim()) return "id مطلوب";
  if (typeof cfg.displayName !== "string" || !cfg.displayName.trim()) return "displayName مطلوب";
  if (!cfg.escalation || typeof cfg.escalation !== "object") return "escalation مطلوب ككائن";
  if (typeof cfg.escalation.contactMethod !== "string" || !cfg.escalation.contactMethod.trim()) {
    return "escalation.contactMethod مطلوب";
  }
  if (cfg.appointments?.enabled) {
    if (!cfg.appointments.workingHours?.start || !cfg.appointments.workingHours?.end) {
      return "appointments.workingHours.start/end مطلوبين لو appointments.enabled=true";
    }
  }
  return null;
}

module.exports = { validateClientConfig };
