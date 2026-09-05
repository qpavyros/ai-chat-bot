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
  };
}

module.exports = { settleEntitlements, createAccountEntitlements };
