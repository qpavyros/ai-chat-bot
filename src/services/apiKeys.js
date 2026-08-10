// توليد/تشفير مفاتيح API. نوعين مختلفين تمامًا بالغرض الأمني:
//
//   pk_ (عام)  — بيروح بالودجت المُضمّن بموقع الشركة، ظاهر لأي حدا يفتح devtools بمصدر
//                 الصفحة. حمايته مش بالسرية، بحصر الأصل (allowedOrigins) وحد المعدل.
//   sk_ (سري)  — سيرفر-لسيرفر بس (شركة بتجيب مواعيدها/استخدامها مثلاً)، بيقرا بيانات
//                 زبائن حقيقية. يُخزّن مُشفّر (hash)، أبدًا نص صريح.

const crypto = require("crypto");

function generatePublicKey() {
  return `pk_${crypto.randomBytes(18).toString("base64url")}`;
}

function generateSecretKey() {
  return `sk_${crypto.randomBytes(32).toString("base64url")}`;
}

// SHA-256 بدون salt — قرار مقصود، مو إهمال: المفتاح نفسه 32 بايت عشوائية (256 بت entropy)،
// يعني ما في أي قاموس هجوم (dictionary attack) عملي عليه أصلاً، فالـ salt ما بيضيف حماية
// حقيقية هون ويبرر تعقيد إضافي (bcrypt/argon2 + تبعية جديدة) بلا داعي. والمقارنة عند التحقق
// هي بحث بـ Map مفهرسة بالـ hash (lookup)، مو مقارنة نص بنص بلوب — ما في سطح لهجوم توقيت
// (timing attack) لازم تحسبله. ⚠️ لا "تحسّنها" لمقارنة يدوية بحلقة == — هيك بترجع تفتح
// سطح هجوم التوقيت يلي أصلاً مسكّر.
function hashKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

function parseKeyType(rawKey) {
  if (typeof rawKey !== "string") return null;
  if (rawKey.startsWith("pk_")) return "public";
  if (rawKey.startsWith("sk_")) return "secret";
  return null;
}

module.exports = { generatePublicKey, generateSecretKey, hashKey, parseKeyType };
