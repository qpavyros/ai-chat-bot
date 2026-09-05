const test = require("node:test");
const assert = require("node:assert/strict");
const { settleEntitlements, createAccountEntitlements } = require("../../src/services/accountEntitlements");

test("account settlement picks the highest plan, farthest expiry, and sums remaining balances", () => {
  const out = settleEntitlements([
    { tier: "starter", subscriptionExpiresAt: "2030-01-02T00:00:00.000Z", messageQuotaRemaining: 4, voiceSecondsRemaining: 30, topUpCreditsRemaining: 2 },
    { tier: "growth", subscriptionExpiresAt: "2030-01-03T00:00:00.000Z", messageQuotaRemaining: 6, voiceSecondsRemaining: 20, topUpCreditsRemaining: 1 },
  ], { starter: { rank: 1 }, growth: { rank: 2 } }, Date.parse("2029-01-01T00:00:00.000Z"));
  assert.deepEqual(out, { plan: "growth", expiresAt: "2030-01-03T00:00:00.000Z", remainingMessages: 10, remainingVoiceSeconds: 50, remainingCredits: 3, settledAt: "2029-01-01T00:00:00.000Z" });
});

test("account message consumption is atomic and refuses an exhausted entitlement", async () => {
  let data = { remainingMessages: 2, plan: "growth" };
  const ref = { set: async (next) => { data = next; } };
  const firestore = {
    collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ref }) }) }),
    runTransaction: async (fn) => fn({
      get: async () => ({ exists: true, data: () => data }),
      set: (_ref, next) => { data = next; },
    }),
  };
  const entitlements = createAccountEntitlements({ firestore });
  assert.deepEqual(await entitlements.consumeMessage("uid-1"), { available: true, remainingMessages: 1 });
  assert.deepEqual(await entitlements.consumeMessage("uid-1"), { available: true, remainingMessages: 0 });
  assert.deepEqual(await entitlements.consumeMessage("uid-1"), { available: false, reason: "message_cap" });
});
