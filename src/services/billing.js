const safeWrite = require("./safeWrite");
const config = require("../config");
const { validateClientConfig } = require("./clientConfigSchema");
const clientEligibility = require("./clientEligibility");
const path = require("path");

function validateIdempotencyKey(operationId) {
  if (!operationId || typeof operationId !== "string" || operationId.length < 1 || operationId.length > 128) {
    const err = new Error("Invalid operationId");
    err.status = 400;
    throw err;
  }
  if (!/^[\x20-\x7E]+$/.test(operationId)) {
    const err = new Error("Invalid operationId");
    err.status = 400;
    throw err;
  }
  if (['__proto__', 'constructor', 'prototype'].includes(operationId)) {
    const err = new Error("Invalid operationId");
    err.status = 400;
    throw err;
  }
}

function parseExpiry(dateStr) {
  if (dateStr === undefined || dateStr === null || (typeof dateStr === 'string' && dateStr.trim() === '')) {
    return null;
  }
  if (dateStr instanceof Date) {
    if (isNaN(dateStr.getTime())) {
      const err = new Error("Invalid explicit expiry");
      err.status = 400;
      throw err;
    }
    return dateStr;
  }
  const parsedMs = clientEligibility.parseExpiry(dateStr);
  if (parsedMs === null) {
    const err = new Error("Invalid explicit expiry");
    err.status = 400;
    throw err;
  }
  return new Date(parsedMs);
}

function parseRecordTimestamp(at) {
  if (typeof at === 'string') {
    return clientEligibility.parseExpiry(at);
  }
  if (at instanceof Date && !isNaN(at.getTime())) {
    return at.getTime();
  }
  if (typeof at === 'number' && Number.isFinite(at)) {
    return at;
  }
  return null;
}

function hasConsecutivePayments(paymentHistory, count = 2, toleranceDays = 35) {
  if (!Array.isArray(paymentHistory)) return false;

  const validRecords = [];
  for (const p of paymentHistory) {
    if (!p || typeof p !== 'object') continue;
    if (p.type && p.type !== 'subscription') continue;
    const ts = parseRecordTimestamp(p.at);
    if (ts !== null) {
      validRecords.push({ ...p, _ts: ts });
    }
  }

  if (count <= 0 || validRecords.length < count) return false;

  validRecords.sort((a, b) => a._ts - b._ts);

  const recent = validRecords.slice(-count);
  for (let i = 1; i < recent.length; i++) {
    const gapDays = (recent[i]._ts - recent[i - 1]._ts) / (24 * 60 * 60 * 1000);
    if (gapDays < 0 || gapDays > toleranceDays) return false;
  }
  return true;
}

function isDeepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!isDeepEqual(a[key], b[key])) return false;
  }
  return true;
}

async function withSortedLocks(ids, fn) {
  const sorted = [...new Set(ids)].sort();
  const take = (i) => {
    if (i === sorted.length) return fn();
    return safeWrite.withClientLock(sorted[i], () => take(i + 1));
  };
  return take(0);
}

async function recordPayment(clientId, operationId, arg3, arg4) {
  validateIdempotencyKey(operationId);

  let now = Date.now();
  let payload = undefined;

  if (typeof arg3 === 'number') {
    now = arg3;
    payload = arg4;
  } else if (arg3 instanceof Date) {
    now = arg3.getTime();
    payload = arg4;
  } else if (arg3 !== undefined && arg3 !== null && typeof arg3 === 'object') {
    if (typeof arg4 === 'number') {
      now = arg4;
      payload = arg3;
    } else if (arg4 instanceof Date) {
      now = arg4.getTime();
      payload = arg3;
    } else {
      payload = arg3;
      if (typeof arg3.now === 'number') {
        now = arg3.now;
      }
    }
  } else {
    payload = arg3;
    if (typeof arg4 === 'number') {
      now = arg4;
    }
  }

  const normalizedPayload = payload !== undefined ? JSON.parse(JSON.stringify(payload)) : null;

  return safeWrite.withClientLock(clientId, async () => {
    const file = path.join(safeWrite.clientDir(clientId), "config.json");
    const cfg = safeWrite.safeReadJSON(file, null);
    if (!cfg) {
      const err = new Error(`عميل غير موجود: ${clientId}`);
      err.status = 404;
      throw err;
    }

    cfg.billingOperations = cfg.billingOperations || {};
    if (cfg.billingOperations[operationId]) {
      const op = cfg.billingOperations[operationId];
      if (op.kind !== 'payment') {
        const err = new Error("Idempotency key reused with different kind");
        err.status = 409;
        throw err;
      }
      const existingPayload = op.payload !== undefined ? op.payload : null;
      if (!isDeepEqual(existingPayload, normalizedPayload)) {
        const err = new Error("Idempotency key reused with different payload");
        err.status = 409;
        throw err;
      }
      return op.result;
    }

    const currentExpiryStr = cfg.plan === "trial" ? cfg.trialExpiresAt : cfg.subscriptionExpiresAt;
    let base = now;
    const currentExpiry = parseExpiry(currentExpiryStr);
    if (currentExpiry && currentExpiry.getTime() > now) {
      base = currentExpiry.getTime();
    }

    const nextExpiry = new Date(base + 30 * 24 * 60 * 60 * 1000).toISOString();

    if (cfg.plan === "trial") {
      cfg.plan = "manual";
      delete cfg.trialExpiresAt;
    }
    cfg.subscriptionExpiresAt = nextExpiry;
    cfg.status = "active";

    const paymentAmount = (payload && (payload.amountUsd ?? payload.amount)) !== undefined
      ? (payload.amountUsd ?? payload.amount)
      : (cfg.tier && config.plans[cfg.tier] ? config.plans[cfg.tier].price : null);

    cfg.paymentHistory = cfg.paymentHistory || [];
    cfg.paymentHistory.push({
      at: new Date(now).toISOString(),
      type: "subscription",
      amountUsd: paymentAmount
    });

    const referralEligible = Boolean(cfg.referredByClientId) && !cfg.referralRewarded && hasConsecutivePayments(cfg.paymentHistory);

    const result = {
      ok: true,
      nextExpiry,
      referralEligible,
      referredByClientId: cfg.referredByClientId || null,
      amountUsd: paymentAmount
    };

    cfg.billingOperations[operationId] = {
      kind: 'payment',
      payload: normalizedPayload,
      result
    };

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

async function applyReferralReward(clientId, now = Date.now()) {
  const referredFilePre = path.join(safeWrite.clientDir(clientId), "config.json");
  const referredCfgPre = safeWrite.safeReadJSON(referredFilePre, null);
  if (!referredCfgPre) {
      const err = new Error("عميل غير موجود");
      err.status = 404;
      throw err;
  }
  const referrerId = referredCfgPre.referredByClientId;
  if (!referrerId) {
      const err = new Error("هالعميل ما إله عميل مُحيل مسجّل");
      err.status = 400;
      throw err;
  }
  if (referrerId === clientId) {
      const err = new Error("Self referral not allowed");
      err.status = 400;
      throw err;
  }

  const ids = [clientId, referrerId];

  return withSortedLocks(ids, async () => {
    const referredFile = path.join(safeWrite.clientDir(clientId), "config.json");
    const referredCfg = safeWrite.safeReadJSON(referredFile, null);
    if (!referredCfg) {
        const err = new Error("عميل غير موجود");
        err.status = 404;
        throw err;
    }
    if (referredCfg.referredByClientId !== referrerId) {
        const err = new Error("Referred by client changed");
        err.status = 400;
        throw err;
    }

    const referrerFile = path.join(safeWrite.clientDir(referrerId), "config.json");
    const referrerCfg = safeWrite.safeReadJSON(referrerFile, null);
    if (!referrerCfg) {
        const err = new Error("عميل المُحيل غير موجود");
        err.status = 404;
        throw err;
    }

    const markerId = `referral:${clientId}`;
    let nextExpiryStr = null;

    if (referrerCfg.billingOperations && referrerCfg.billingOperations[markerId]) {
      nextExpiryStr = referrerCfg.billingOperations[markerId].result.nextExpiry;
    } else {
      if (referredCfg.referralRewarded) {
          return { ok: true, referrerId, nextExpiry: referrerCfg.plan === "trial" ? referrerCfg.trialExpiresAt : referrerCfg.subscriptionExpiresAt }; 
      }
      if (!hasConsecutivePayments(referredCfg.paymentHistory)) {
          const err = new Error("العميل المُحال لسا ما دفع شهرين متتاليين");
          err.status = 400;
          throw err;
      }

      const currentExpiryStr = referrerCfg.plan === "trial" ? referrerCfg.trialExpiresAt : referrerCfg.subscriptionExpiresAt;
      let base = now;
      const currentExpiry = parseExpiry(currentExpiryStr);
      if (currentExpiry && currentExpiry.getTime() > now) {
        base = currentExpiry.getTime();
      }
      
      const nextExpiry = new Date(base + config.referral.rewardMonths * 30 * 24 * 60 * 60 * 1000).toISOString();
      nextExpiryStr = nextExpiry;

      if (referrerCfg.plan === "trial") {
          referrerCfg.trialExpiresAt = nextExpiry;
      } else {
          referrerCfg.subscriptionExpiresAt = nextExpiry;
      }
      referrerCfg.billingOperations = referrerCfg.billingOperations || {};
      referrerCfg.billingOperations[markerId] = {
          kind: 'referral_reward',
          result: { nextExpiry }
      };

      const errRef = validateClientConfig(referrerCfg);
      if (errRef) {
          const e = new Error(errRef);
          e.status = 400;
          throw e;
      }
      safeWrite.rawWriteClientFile(referrerId, "config.json", JSON.stringify(referrerCfg, null, 2));
    }

    if (!referredCfg.referralRewarded) {
      referredCfg.referralRewarded = true;
      const errReferred = validateClientConfig(referredCfg);
      if (errReferred) {
          const e = new Error(errReferred);
          e.status = 400;
          throw e;
      }
      safeWrite.rawWriteClientFile(clientId, "config.json", JSON.stringify(referredCfg, null, 2));
    }

    return { ok: true, referrerId, nextExpiry: nextExpiryStr };
  });
}

module.exports = {
  validateIdempotencyKey,
  parseExpiry,
  hasConsecutivePayments,
  recordPayment,
  applyReferralReward
};
