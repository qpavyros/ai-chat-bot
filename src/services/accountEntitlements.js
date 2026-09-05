function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
        const operations = data.creditOperations || {};
        const prior = operations[operationId];
        if (prior) return prior.result;
        const result = { ok: true, added: amount, balance: (Number(data.remainingCredits) || 0) + amount };
        tx.set(ref, { ...data, remainingCredits: result.balance, creditOperations: { ...operations, [operationId]: { result, metadata, at: new Date().toISOString() } }, updatedAt: new Date().toISOString() }, { merge: false });
        return result;
      });
    },
    async recordPayment(uid, { operationId, tier, now = Date.now(), amountUsd = null } = {}) {
      if (!uid || !operationId) throw new Error("invalid payment");
      const ref = firestore.collection("users").doc(uid).collection("billing").doc("entitlements");
      return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return { ok: false, reason: "missing_entitlement" };
        const data = snap.data() || {};
        const operations = data.paymentOperations || {};
        if (operations[operationId]) return operations[operationId].result;
        const current = Date.parse(data.expiresAt || "");
        const base = Number.isFinite(current) && current > now ? current : now;
        const nextExpiry = new Date(base + 30 * 24 * 60 * 60 * 1000).toISOString();
        const result = { ok: true, nextExpiry, plan: tier || data.plan || null, amountUsd };
        tx.set(ref, { ...data, plan: result.plan, expiresAt: nextExpiry, paymentOperations: { ...operations, [operationId]: { result, at: new Date(now).toISOString() } }, updatedAt: new Date().toISOString() }, { merge: false });
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
  };
}

module.exports = { settleEntitlements, createAccountEntitlements };
