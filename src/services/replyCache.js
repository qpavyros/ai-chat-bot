// كاش ردود بالذاكرة — لأسئلة FAQ متكررة الصياغة بس، لتوفير استدعاء DeepSeek بالكامل عند تطابق.
//
// آمن عمدًا بنطاق ضيق — النطاق نفسه هو الحماية، مو منطق ذكي:
//   • بيُستخدم بس لزبون "أول تواصل" (بدون تاريخ محادثة ولا معلومات محفوظة عنه) — عشان رد
//     مُخزّن ما ينسرب لزبون تاني بمعلومات شخصية أو سياق مختلف.
//   • بيُستخدم بس لرد ما استخدم أي أداة (حجز، فحص توفر، تذكّر معلومة) — عشان ما نخزّن جواب
//     مرتبط بلحظة زمنية (توفر/مخزون) أو بزبون محدد.
//   • بيُستخدم بس لرد ما فيه تصعيد — عشان ما نعيد إطلاق إشعار/إيقاف تلقائي بكل cache hit.
// القرار شو بيُخزّن وشو لأ من مسؤولية الطرف المستدعي (webChat.js/whatsappWebhook.js)، هالملف
// بس تخزين/استرجاع + انتهاء صلاحية + حد أقصى للحجم.

const config = require("../config");

const store = new Map(); // key -> { reply, expiresAt }

// تطبيع بسيط (مش تشابه دلالي حقيقي) — بيلتقط نفس السؤال بصياغة شبه مطابقة (مسافات زيادة،
// علامات ترقيم بالنهاية، حالة أحرف لاتينية). لو الحاجة صارت لتشابه دلالي فعلي لاحقًا (embeddings)،
// هاي أول إشارة توسّع حقيقية — مو قبل.
function normalize(text) {
  return String(text)
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[؟?!.,،؛]+$/g, "")
    .toLowerCase();
}

function buildKey(clientId, message) {
  return `${clientId}:${normalize(message)}`;
}

function get(clientId, message) {
  if (!config.replyCache.enabled) return null;

  const key = buildKey(clientId, message);
  const entry = store.get(key);
  if (!entry) return null;

  if (entry.expiresAt < Date.now()) {
    store.delete(key);
    return null;
  }
  return entry.reply;
}

function set(clientId, message, reply) {
  if (!config.replyCache.enabled) return;

  if (store.size >= config.replyCache.maxEntries) {
    // إزالة أقدم عنصر إدخالًا (ترتيب Map بيحافظ على تسلسل الإدخال) — بسيط بدل LRU حقيقي،
    // كافي لهالحجم وهالغرض (كاش تكلفة، مش مصدر حقيقة).
    const oldestKey = store.keys().next().value;
    if (oldestKey) store.delete(oldestKey);
  }

  store.set(buildKey(clientId, message), {
    reply,
    expiresAt: Date.now() + config.replyCache.ttlHours * 60 * 60 * 1000,
  });
}

// بيمسح كل عناصر عميل معيّن — لازم يُستدعى من أي مكان بيعدّل knowledge.md أو config.json
// تبع العميل (راجع src/routes/admin.js). بدون هيك، تصحيح سعر غلط بالداشبورد كان ممكن يضل
// البوت يعطي الجواب القديم الغلط لغاية TTL كامل (افتراضيًا 12 ساعة) — ثغرة حقيقية اكتُشفت
// بمراجعة Opus (development-plan-20260809.md، طبقة 1، بند 8).
function clear(clientId) {
  const prefix = `${clientId}:`;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

// تنظيف دوري للعناصر منتهية الصلاحية — حتى ما تكبر الـMap بلا حدود بمفاتيح ميتة
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt < now) store.delete(key);
  }
}, 30 * 60 * 1000);
cleanupTimer.unref();

module.exports = { get, set, clear };
