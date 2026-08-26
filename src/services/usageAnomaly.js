// تنبيه للمشغّل لو عميل قارب/تجاوز سقفه اليومي من الرسائل (config.abuseGuard.clientDailyMax) —
// إشارة استهلاك غير معتاد (بوت مهجور بحلقة، إساءة استخدام مفتاح pk_ مسروق، أو نمو حقيقي
// يستاهل تهنئة). مبني فوق rateLimit.js الموجود أصلاً، بدون تخزين تاريخي إضافي — بس نفس
// النافذة اليومية يلي webChat.js/whatsappWebhook.js أصلاً بيحسبوها لكل رسالة.
const config = require("../config");
const whatsapp = require("./whatsapp");

const ALERT_THRESHOLD_RATIO = 0.8; // نبّه لما يوصل العميل لـ80% من سقفه اليومي

// clientId -> resetAt يلي انبعت فيه آخر تنبيه — حتى ما نكرر نفس التنبيه بكل رسالة لاحقة
// بنفس نافذة اليوم، بس نبعت تاني تلقائيًا لما تبلش نافذة يوم جديد (resetAt جديد).
const lastAlertedWindow = new Map();

// dailyUsageResult = ناتج rateLimit.checkLimit لنفس مفتاح client-daily-msgs:<clientId> —
// بنعيد استخدامه بدل ما نحسب استهلاك منفصل، تفاديًا لمصدرين مختلفين ممكن يتعارضوا.
function checkAndAlert(client, dailyUsageResult) {
  const max = config.abuseGuard.clientDailyMax;
  const used = max - dailyUsageResult.remaining;
  if (used / max < ALERT_THRESHOLD_RATIO) return;

  if (lastAlertedWindow.get(client.id) === dailyUsageResult.resetAt) return;
  lastAlertedWindow.set(client.id, dailyUsageResult.resetAt);

  const operatorNumber = config.provisioning.operatorWhatsapp;
  const senderPhoneNumberId = config.whatsapp.notifySenderPhoneNumberId;
  if (!operatorNumber || !senderPhoneNumberId) return;

  // Fire-and-forget عمدًا (نفس نمط notifyBusinessOwner بـorders.js/handoff.js) — تنبيه
  // إداري ثانوي، ما لازم يعطّل أو يبطّئ رد البوت على الزبون الحقيقي يلي مستنيه.
  whatsapp
    .sendTextMessage(
      operatorNumber,
      senderPhoneNumberId,
      `⚠️ استهلاك غير معتاد: "${client.displayName}" (${client.id}) وصل لـ${used}/${max} رسالة اليوم — راجع الاستخدام.`
    )
    .catch((err) => console.error("[usageAnomaly] فشل إرسال تنبيه الاستهلاك:", err.response?.data || err.message));
}

module.exports = { checkAndAlert };
