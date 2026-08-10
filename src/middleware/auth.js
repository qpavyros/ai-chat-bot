// مصادقة موحّدة لأي route بيخص عميل معيّن. بتقبل:
//   Authorization: Bearer pk_...   → عام، للودجت المُضمّن بموقع الشركة
//   Authorization: Bearer sk_...   → سري، سيرفر-لسيرفر بس
//   x-widget-key: <WEB_WIDGET_KEY>  → وضع قديم مؤقت (ALLOW_LEGACY_WIDGET_KEY)، بيتحدد
//                                     العميل من الـ URL مباشرة بدل المفتاح
//
// allow: ["public","secret"] — أي نوع مفاتيح مسموح لهالـ route (مثلاً /appointments لاحقًا
// لازم يكون ["secret"] بس، لأنه بيرجّع بيانات زبائن حقيقية).

const config = require("../config");
const registry = require("../clients/registry");

function authenticate({ allow = ["public", "secret"] } = {}) {
  return (req, res, next) => {
    const authHeader = req.get("authorization");
    const bearerKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    const legacyKey = req.get("x-widget-key");

    let client = null;
    let keyType = null;

    if (bearerKey?.startsWith("pk_") && allow.includes("public")) {
      client = registry.getClientByPublicKey(bearerKey);
      keyType = "public";
    } else if (bearerKey?.startsWith("sk_") && allow.includes("secret")) {
      client = registry.getClientBySecretKey(bearerKey);
      keyType = "secret";
    } else if (!bearerKey && legacyKey && config.allowLegacyWidgetKey && legacyKey === config.webWidgetKey) {
      // الوضع القديم: مفتاح واحد مشترك لكل العملاء، العميل بيتحدد من الـ URL مش من المفتاح
      const clientId = req.params.clientId;
      client = clientId ? registry.getClientById(clientId) : null;
      keyType = "legacy";
      if (client) {
        console.warn(`[auth] عميل "${clientId}" لسا عم يستخدم WEB_WIDGET_KEY القديم — صدّرله مفتاح pk_ ورحّله (npm run key -- issue).`);
      }
    }

    if (!client) {
      return res.status(401).json({ error: { code: "invalid_api_key", message: "مفتاح API غير صحيح أو ناقص" } });
    }

    if (req.params.clientId && req.params.clientId !== client.id) {
      return res.status(403).json({ error: { code: "client_mismatch", message: "المفتاح مو تبع هالعميل" } });
    }

    if (!registry.isServable(client)) {
      return res.status(403).json({ error: { code: "client_not_active", message: "هالعميل مو مفعّل حاليًا (preview/منتهي/موقوف)" } });
    }

    // حصر الأصل بس للمفتاح العام — هو يلي ظاهر بصفحة الموقع، فحصره بمصدر الطلب هو خط
    // الدفاع الحقيقي (المفتاح نفسه ما بيقدر يكون سرًا). عملاء بدون allowedOrigins (يدويين
    // قدامى) ما بينفحصوا، حفاظًا على التوافق.
    if (keyType === "public" && client.allowedOrigins?.length) {
      const origin = req.get("origin");
      if (!origin || !client.allowedOrigins.includes(origin)) {
        return res.status(403).json({ error: { code: "origin_not_allowed", message: "الطلب جاي من موقع غير مسموح له" } });
      }
    }

    req.client = client;
    req.auth = { type: keyType };
    next();
  };
}

module.exports = { authenticate };
