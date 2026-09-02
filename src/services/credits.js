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
const { validateClientConfig } = require("./clientConfigSchema");

function packDef(packKey) {
  return config.topUpPacks?.[packKey] || null;
}

/** يضيف رصيد باقة شحن + يسجلها بتاريخ المدفوعات (type:"topup"). بيرجع الرصيد الجديد. */
async function addCredits(clientId, packKey, operationId) {
  const pack = packDef(packKey);
  if (!pack) {
    const err = new Error(`باقة شحن غير معروفة: ${packKey}`);
    err.status = 400;
    throw err;
  }

  const { validateIdempotencyKey } = require("./billing");
  if (operationId !== undefined) {
    validateIdempotencyKey(operationId);
  }

  return safeWrite.withClientLock(clientId, () => {
    const file = require("path").join(safeWrite.clientDir(clientId), "config.json");
    const cfg = safeWrite.safeReadJSON(file, null);
    if (!cfg) {
      const err = new Error(`عميل غير موجود: ${clientId}`);
      err.status = 404;
      throw err;
    }

    if (operationId) {
      cfg.billingOperations = cfg.billingOperations || {};
      if (cfg.billingOperations[operationId]) {
        const op = cfg.billingOperations[operationId];
        if (op.kind !== 'topup' || op.pack !== packKey) {
          const err = new Error("Idempotency key reused with different kind or pack");
          err.status = 409;
          throw err;
        }
        return op.result;
      }
    }

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

    const result = { balance: cfg.topUpCreditsRemaining, added: pack.credits };

    if (operationId) {
      cfg.billingOperations = cfg.billingOperations || {};
      cfg.billingOperations[operationId] = {
        kind: 'topup',
        pack: packKey,
        result
      };
    }

    const err = validateClientConfig(cfg);
    if (err) {
      const e = new Error(err);
      e.status = 400;
      throw e;
    }

    safeWrite.rawWriteClientFile(clientId, "config.json", JSON.stringify(cfg, null, 2));
    return result;
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

/** يحجز رسالة وحدة من الرصيد بمعرف عملية (idempotent). بيرجع reservation object لو نجح، أو null. */
async function reserveOne(clientId, operationId) {
  if (!operationId) throw new Error("operationId required for reserveOne");
  return safeWrite.withClientLock(clientId, () => {
    const file = require("path").join(safeWrite.clientDir(clientId), "config.json");
    const cfg = safeWrite.safeReadJSON(file, null);
    if (!cfg) return null;

    cfg.billingOperations = cfg.billingOperations || {};
    const existing = cfg.billingOperations[operationId];
    if (existing) {
      if (existing.kind !== 'reserve_credit') return null; // conflict
      return { allowed: existing.status !== "refunded", reservationId: operationId, usedCredit: true };
    }

    if (!(cfg.topUpCreditsRemaining > 0)) return null;

    cfg.topUpCreditsRemaining -= 1;
    cfg.billingOperations[operationId] = {
      kind: 'reserve_credit',
      status: 'pending',
      at: new Date().toISOString()
    };
    
    safeWrite.rawWriteClientFile(clientId, "config.json", JSON.stringify(cfg, null, 2));
    return { allowed: true, reservationId: operationId, usedCredit: true };
  });
}

async function commitReservation(clientId, operationId) {
  return safeWrite.withClientLock(clientId, () => {
    const file = require("path").join(safeWrite.clientDir(clientId), "config.json");
    const cfg = safeWrite.safeReadJSON(file, null);
    if (!cfg || !cfg.billingOperations || !cfg.billingOperations[operationId]) return;

    const op = cfg.billingOperations[operationId];
    if (op.kind === 'reserve_credit' && op.status === 'pending') {
      op.status = 'committed';
      safeWrite.rawWriteClientFile(clientId, "config.json", JSON.stringify(cfg, null, 2));
    }
  });
}

async function refundReservation(clientId, operationId) {
  return safeWrite.withClientLock(clientId, () => {
    const file = require("path").join(safeWrite.clientDir(clientId), "config.json");
    const cfg = safeWrite.safeReadJSON(file, null);
    if (!cfg || !cfg.billingOperations || !cfg.billingOperations[operationId]) return;

    const op = cfg.billingOperations[operationId];
    if (op.kind === 'reserve_credit' && op.status === 'pending') {
      op.status = 'refunded';
      cfg.topUpCreditsRemaining = (cfg.topUpCreditsRemaining || 0) + 1;
      safeWrite.rawWriteClientFile(clientId, "config.json", JSON.stringify(cfg, null, 2));
    }
  });
}

module.exports = { addCredits, consumeOne, reserveOne, commitReservation, refundReservation, packDef };
