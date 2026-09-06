function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const {
  CLINICS_LAUNCH_CODE,
  CLINICS_LAUNCH_DISCOUNT_PERCENT,
  CLINICS_LAUNCH_LIMIT,
  CLINICS_LAUNCH_GRACE_DAYS,
  normalizeCampaignCode,
} = require("./launchCampaign");

const DAY_MS = 24 * 60 * 60 * 1000;

function roundedUsd(value) {
  return Number.isFinite(value) ? Math.round((value + Number.EPSILON) * 100) / 100 : null;
}

function settleEntitlements(bots, planCatalog, now = Date.now()) {
  const rows = Array.isArray(bots) ? bots : [];
  let topPlan = null;
  let topRank = -1;
  let farthestExpiry = null;
  let remainingMessages = 0;
  let remainingVoiceSeconds = 0;
  let remainingCredits = 0;
  for (const bot of rows) {
    const plan = bot?.tier && planCatalog?.[bot.tier] ? bot.tier : null;
    const rank = plan ? finiteNumber(planCatalog[plan].rank || planCatalog[plan].monthlyMessageCap) : -1;
    if (rank > topRank) { topRank = rank; topPlan = plan; }
    const expiry = Date.parse(bot?.subscriptionExpiresAt || bot?.trialExpiresAt || "");
    if (Number.isFinite(expiry) && (!farthestExpiry || expiry > farthestExpiry)) farthestExpiry = expiry;
    remainingMessages += Math.max(0, finiteNumber(bot?.messageQuotaRemaining));
    remainingVoiceSeconds += Math.max(0, finiteNumber(bot?.voiceSecondsRemaining));
    remainingCredits += Math.max(0, finiteNumber(bot?.topUpCreditsRemaining));
  }
  return {
    plan: topPlan,
    expiresAt: farthestExpiry && farthestExpiry > now ? new Date(farthestExpiry).toISOString() : null,
    remainingMessages,
    remainingVoiceSeconds,
    remainingCredits,
    settledAt: new Date(now).toISOString(),
  };
}

function createAccountEntitlements({ firestore } = {}) {
  if (!firestore) firestore = require("./firebaseAdmin").db;
  return {
    async ensure(uid, initial = {}) {
      if (!uid) throw new Error("uid required");
      const ref = firestore.collection("users").doc(uid).collection("billing").doc("entitlements");
      return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists) return { created: false, entitlement: snap.data() || {} };
        const now = initial.now || Date.now();
        const entitlement = {
          plan: initial.plan || null,
          expiresAt: initial.expiresAt || null,
          remainingMessages: Math.max(0, finiteNumber(initial.remainingMessages)),
          remainingVoiceSeconds: Math.max(0, finiteNumber(initial.remainingVoiceSeconds)),
          remainingCredits: Math.max(0, finiteNumber(initial.remainingCredits)),
          settledAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        };
        tx.set(ref, entitlement, { merge: false });
        return { created: true, entitlement };
      });
    },
    async settle(uid, bots, planCatalog, now) {
      if (!uid) throw new Error("uid required");
      const ref = firestore.collection("users").doc(uid).collection("billing").doc("entitlements");
      const settled = settleEntitlements(bots, planCatalog, now);
      await ref.set(settled, { merge: false });
      return settled;
    },
    async update(uid, updater) {
      const ref = firestore.collection("users").doc(uid).collection("billing").doc("entitlements");
      return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const next = await updater(snap.exists ? snap.data() : null);
        tx.set(ref, next, { merge: false });
        return next;
      });
    },
    async consumeMessage(uid) {
      if (!uid) throw new Error("uid required");
      const ref = firestore.collection("users").doc(uid).collection("billing").doc("entitlements");
      return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return { available: false, reason: "missing_entitlement" };
        const data = snap.data() || {};
        if (data.unbounded === true) return { available: false, reason: "missing_entitlement" };
        const remaining = Number.isFinite(data.remainingMessages) ? data.remainingMessages : 0;
        if (remaining <= 0) return { available: false, reason: "message_cap" };
        const next = { ...data, remainingMessages: remaining - 1, updatedAt: new Date().toISOString() };
        tx.set(ref, next, { merge: false });
        return { available: true, remainingMessages: next.remainingMessages };
      });
    },
    async consumeCredit(uid) {
      if (!uid) throw new Error("uid required");
      const ref = firestore.collection("users").doc(uid).collection("billing").doc("entitlements");
      return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return { available: false, reason: "missing_entitlement" };
        const data = snap.data() || {};
        if (data.unbounded === true) return { available: false, reason: "missing_entitlement" };
        const remaining = Number.isFinite(data.remainingCredits) ? data.remainingCredits : 0;
        if (remaining <= 0) return { available: false, reason: "credit_empty" };
        tx.set(ref, { ...data, remainingCredits: remaining - 1, updatedAt: new Date().toISOString() }, { merge: false });
        return { available: true, remainingCredits: remaining - 1 };
      });
    },
    async addCredits(uid, amount, operationId, metadata = {}) {
      if (!uid || !Number.isFinite(amount) || amount <= 0 || !operationId) throw new Error("invalid credit grant");
      const ref = firestore.collection("users").doc(uid).collection("billing").doc("entitlements");
      return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return { ok: false, reason: "missing_entitlement" };
        const data = snap.data() || {};
        if (data.unbounded === true) return { ok: false, reason: "missing_entitlement" };
        const operations = data.creditOperations || {};
        const prior = operations[operationId];
        if (prior) return prior.result;
        const result = { ok: true, added: amount, balance: (Number(data.remainingCredits) || 0) + amount };
        tx.set(ref, { ...data, remainingCredits: result.balance, creditOperations: { ...operations, [operationId]: { result, metadata, at: new Date().toISOString() } }, updatedAt: new Date().toISOString() }, { merge: false });
        return result;
      });
    },
    async recordPayment(uid, { operationId, tier, now = Date.now(), amountUsd = null, campaignCode = null } = {}) {
      if (!uid || !operationId) throw new Error("invalid payment");
      const ref = firestore.collection("users").doc(uid).collection("billing").doc("entitlements");
      const normalizedCampaign = normalizeCampaignCode(campaignCode);
      const campaignRef = normalizedCampaign
        ? firestore.collection("marketingCampaigns").doc(CLINICS_LAUNCH_CODE)
        : null;
      return firestore.runTransaction(async (tx) => {
        let snap;
        let campaignSnap = null;
        if (campaignRef) {
          [snap, campaignSnap] = await tx.getAll(ref, campaignRef);
        } else {
          snap = await tx.get(ref);
        }
        if (!snap.exists) return { ok: false, reason: "missing_entitlement" };
        const data = snap.data() || {};
        if (data.unbounded === true) return { ok: false, reason: "missing_entitlement" };
        const operations = data.paymentOperations || {};
        if (operations[operationId]) return operations[operationId].result;

        const firstPayment = Object.keys(operations).length === 0;
        const previousGrace = Date.parse(data.discountGraceUntil || "");
        let discountStatus = data.discountStatus || null;
        let discountApplied = false;
        let newlyClaimed = false;
        let campaignData = null;

        if (discountStatus === "active") {
          if (Number.isFinite(previousGrace) && now <= previousGrace) {
            discountApplied = true;
          } else {
            discountStatus = "lapsed";
          }
        } else if (!discountStatus && firstPayment && normalizedCampaign && campaignSnap) {
          campaignData = campaignSnap.exists ? campaignSnap.data() || {} : {};
          const claims = campaignData.claims && typeof campaignData.claims === "object" ? campaignData.claims : {};
          const claimedCount = Math.max(Number(campaignData.claimedCount) || 0, Object.keys(claims).length);
          if (claimedCount < CLINICS_LAUNCH_LIMIT) {
            discountStatus = "active";
            discountApplied = true;
            newlyClaimed = true;
            campaignData = {
              ...campaignData,
              code: CLINICS_LAUNCH_CODE,
              limit: CLINICS_LAUNCH_LIMIT,
              discountPercent: CLINICS_LAUNCH_DISCOUNT_PERCENT,
              claimedCount: claimedCount + 1,
              claims: { ...claims, [uid]: { claimedAt: new Date(now).toISOString() } },
              updatedAt: new Date(now).toISOString(),
            };
          }
        }

        const current = Date.parse(data.expiresAt || "");
        const base = Number.isFinite(current) && current > now ? current : now;
        const nextExpiry = new Date(base + 30 * DAY_MS).toISOString();
        const originalAmountUsd = roundedUsd(amountUsd);
        const chargedAmountUsd = discountApplied && originalAmountUsd !== null
          ? roundedUsd(originalAmountUsd * (1 - CLINICS_LAUNCH_DISCOUNT_PERCENT / 100))
          : originalAmountUsd;
        const graceUntil = discountStatus === "active"
          ? new Date(Date.parse(nextExpiry) + CLINICS_LAUNCH_GRACE_DAYS * DAY_MS).toISOString()
          : data.discountGraceUntil || null;
        const result = {
          ok: true,
          nextExpiry,
          plan: tier || data.plan || null,
          amountUsd: chargedAmountUsd,
          originalAmountUsd,
          chargedAmountUsd,
          discountApplied,
          discountPercent: discountApplied ? CLINICS_LAUNCH_DISCOUNT_PERCENT : 0,
          discountStatus: normalizedCampaign && !discountStatus ? "unavailable" : discountStatus,
          campaignCode: discountApplied ? CLINICS_LAUNCH_CODE : null,
        };
        const next = {
          ...data,
          plan: result.plan,
          expiresAt: nextExpiry,
          ...(discountStatus ? {
            discountPercent: CLINICS_LAUNCH_DISCOUNT_PERCENT,
            discountCampaignCode: CLINICS_LAUNCH_CODE,
            discountClaimedAt: newlyClaimed ? new Date(now).toISOString() : data.discountClaimedAt,
            discountStatus,
            discountGraceUntil: graceUntil,
          } : {}),
          paymentOperations: { ...operations, [operationId]: { result, at: new Date(now).toISOString() } },
          updatedAt: new Date(now).toISOString(),
        };
        tx.set(ref, next, { merge: false });
        if (newlyClaimed) tx.set(campaignRef, campaignData, { merge: false });
        return result;
      });
    },
    async reserveCredit(uid, operationId) {
      if (!uid || !operationId) throw new Error("invalid credit reservation");
      const entRef = firestore.collection("users").doc(uid).collection("billing").doc("entitlements");
      const reservationId = require("crypto").createHash("sha256").update(`${uid}:credit:${operationId}`).digest("hex");
      const resRef = firestore.collection("accountCreditReservations").doc(reservationId);
      return firestore.runTransaction(async (tx) => {
        const [entSnap, resSnap] = await tx.getAll(entRef, resRef);
        if (resSnap.exists) return { allowed: false, reason: "duplicate", reservationId };
        if (!entSnap.exists) return { allowed: false, reason: "missing_entitlement" };
        const data = entSnap.data() || {};
        if (data.unbounded === true) return { allowed: false, reason: "missing_entitlement" };
        const remaining = Number.isFinite(data.remainingCredits) ? data.remainingCredits : 0;
        if (remaining <= 0) return { allowed: false, reason: "credit_empty" };
        tx.set(entRef, { ...data, remainingCredits: remaining - 1, updatedAt: new Date().toISOString() }, { merge: false });
        tx.set(resRef, { uid, status: "pending", createdAtUTC: new Date().toISOString() });
        return { allowed: true, reservationId };
      });
    },
    async commitCreditReservation(reservationId) {
      const ref = firestore.collection("accountCreditReservations").doc(reservationId);
      return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists && snap.data().status === "pending") tx.update(ref, { status: "committed" });
      });
    },
    async refundCreditReservation(reservationId) {
      const ref = firestore.collection("accountCreditReservations").doc(reservationId);
      return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists || snap.data().status !== "pending") return;
        const data = snap.data();
        const entRef = firestore.collection("users").doc(data.uid).collection("billing").doc("entitlements");
        const entSnap = await tx.get(entRef);
        if (!entSnap.exists) return;
        const ent = entSnap.data() || {};
        tx.update(ref, { status: "refunded" });
        tx.set(entRef, { ...ent, remainingCredits: (Number(ent.remainingCredits) || 0) + 1, updatedAt: new Date().toISOString() }, { merge: false });
      });
    },
    async reserveVoice(uid, amount, operationId) {
      if (!uid || !Number.isFinite(amount) || amount <= 0 || !operationId) throw new Error("invalid voice reservation");
      const entRef = firestore.collection("users").doc(uid).collection("billing").doc("entitlements");
      const reservationId = require("crypto").createHash("sha256").update(`${uid}:voice:${operationId}`).digest("hex");
      const resRef = firestore.collection("accountVoiceReservations").doc(reservationId);
      return firestore.runTransaction(async (tx) => {
        const [entSnap, resSnap] = await tx.getAll(entRef, resRef);
        if (resSnap.exists) return { allowed: false, reason: "duplicate", reservationId };
        if (!entSnap.exists) return { allowed: false, reason: "missing_entitlement" };
        const data = entSnap.data() || {};
        if (data.unbounded === true) return { allowed: false, reason: "missing_entitlement" };
        const remaining = Number.isFinite(data.remainingVoiceSeconds) ? data.remainingVoiceSeconds : 0;
        if (remaining < amount) return { allowed: false, reason: "voice_cap" };
        tx.set(entRef, { ...data, remainingVoiceSeconds: remaining - amount, updatedAt: new Date().toISOString() }, { merge: false });
        tx.set(resRef, { uid, amount, status: "pending", createdAtUTC: new Date().toISOString() });
        return { allowed: true, reservationId, remainingVoiceSeconds: remaining - amount };
      });
    },
    async commitVoiceReservation(reservationId) {
      const ref = firestore.collection("accountVoiceReservations").doc(reservationId);
      return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists && snap.data().status === "pending") tx.update(ref, { status: "committed" });
      });
    },
    async refundVoiceReservation(reservationId) {
      const ref = firestore.collection("accountVoiceReservations").doc(reservationId);
      return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists || snap.data().status !== "pending") return;
        const data = snap.data();
        const entRef = firestore.collection("users").doc(data.uid).collection("billing").doc("entitlements");
        const entSnap = await tx.get(entRef);
        if (!entSnap.exists) return;
        const ent = entSnap.data() || {};
        tx.update(ref, { status: "refunded" });
        tx.set(entRef, { ...ent, remainingVoiceSeconds: (Number(ent.remainingVoiceSeconds) || 0) + data.amount, updatedAt: new Date().toISOString() }, { merge: false });
      });
    },
    async getCampaignOffer(uid, campaignCode, planCatalog) {
      const normalizedCampaign = normalizeCampaignCode(campaignCode);
      if (!normalizedCampaign) return null;
      const ref = firestore.collection("users").doc(uid).collection("billing").doc("entitlements");
      const campaignRef = firestore.collection("marketingCampaigns").doc(normalizedCampaign);
      const [snap, campaignSnap] = await Promise.all([ref.get(), campaignRef.get()]);

      const data = snap.exists ? snap.data() || {} : {};
      const campaignData = campaignSnap.exists ? campaignSnap.data() || {} : {};

      const claims = campaignData.claims && typeof campaignData.claims === "object" ? campaignData.claims : {};
      const claimedCount = Math.max(Number(campaignData.claimedCount) || 0, Object.keys(claims).length);
      const remainingSpots = Math.max(0, CLINICS_LAUNCH_LIMIT - claimedCount);

      let status = "unavailable";
      let discountPercent = 0;
      let graceUntil = null;

      if (data.discountCampaignCode === normalizedCampaign && data.discountStatus) {
        status = data.discountStatus;
        if (status === "active" || status === "lapsed") {
          discountPercent = data.discountPercent || CLINICS_LAUNCH_DISCOUNT_PERCENT;
        }
        graceUntil = data.discountGraceUntil || null;
      } else if (remainingSpots > 0) {
        status = "eligible";
        discountPercent = CLINICS_LAUNCH_DISCOUNT_PERCENT;
      }

      const discountedPrices = {};
      if (planCatalog) {
        for (const [planId, plan] of Object.entries(planCatalog)) {
          if (typeof plan.price === "number") {
            discountedPrices[planId] = status === "eligible" || status === "active"
              ? Math.round((plan.price * (1 - discountPercent / 100) + Number.EPSILON) * 100) / 100
              : plan.price;
          }
        }
      }

      return {
        campaignCode: normalizedCampaign,
        discountPercent,
        status,
        discountedPrices,
        graceUntil,
        remainingSpots,
      };
    },
  };
}

module.exports = { settleEntitlements, createAccountEntitlements };
