// رصيد رسائل شحن إضافية (top-up) — العميل يعبّي عدد محادثات إضافية بسعر أعلى من سعر
// الرسالة داخل الباقات عمدًا ($0.080/$0.070 مقابل $0.058/$0.039/$0.020) حتى يبقى
// الاشتراك الدوري الخيار الاقتصادي الأذكى.
//
// التخزين: config.json تبع العميل (topUpCreditsRemaining) جوا قفل safeWrite — بسيط
// ومتسق مع كل شي تاني. الاستهلاك بيصير فقط لما السقف الشهري/التجريبي يبلش يمنع:
// الرصيد overflow احتياطي، مش بديل عن الباقة.
//
// ⚠️ الحد اليومي (abuseGuard.clientDailyMax) ما بينتجزع منه الرصيد عمدًا — هاد حماية
// إساءة مش فاتورة.
const safeWrite = require("./safeWrite");
const config = require("../config");

function packDef(packKey) {
  return config.topUpPacks?.[packKey] || null;
}

/** يضيف رصيد باقة شحن + يسجلها بتاريخ المدفوعات (type:"topup"). بيرجع الرصيد الجديد. */
async function addCredits(clientId, packKey) {
  const pack = packDef(packKey);
  if (!pack) throw new Error(`باقة شحن غير معروفة: ${packKey}`);

  return safeWrite.withClientLock(clientId, () => {
    const file = require("path").join(safeWrite.clientDir(clientId), "config.json");
    const cfg = safeWrite.safeReadJSON(file, null);
    if (!cfg) throw new Error(`عميل غير موجود: ${clientId}`);

    const before = cfg.topUpCreditsRemaining || 0;
    cfg.topUpCreditsRemaining = before + pack.credits;
    cfg.paymentHistory = [
      ...(cfg.paymentHistory || []),
      {
        at: new Date().toISOString(),
        type: "topup",
        pack: packKey,
        credits: pack.credits,
        amountUsd: pack.priceUsd,
      },
    ];

    safeWrite.rawWriteClientFile(clientId, "config.json", JSON.stringify(cfg, null, 2));
    return { balance: cfg.topUpCreditsRemaining, added: pack.credits };
  });
}

/** يحاول يخصم رسالة وحدة من الرصيد. true = انخصم وخليك تكمل. */
async function consumeOne(clientId) {
  return safeWrite.withClientLock(clientId, () => {
    const file = require("path").join(safeWrite.clientDir(clientId), "config.json");
    const cfg = safeWrite.safeReadJSON(file, null);
    if (!cfg || !(cfg.topUpCreditsRemaining > 0)) return false;

    // قراءة-تعديل-كتابة بنفس القفل؛ ما منعمل نسخة احتياطية منفصلة لأن safeWrite.rawWrite
    // بيعملها تلقائيًا
    cfg.topUpCreditsRemaining -= 1;
    safeWrite.rawWriteClientFile(clientId, "config.json", JSON.stringify(cfg, null, 2));
    return true;
  });
}

module.exports = { addCredits, consumeOne, packDef };
