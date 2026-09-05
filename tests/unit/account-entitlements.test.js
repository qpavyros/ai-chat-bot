const test = require("node:test");
const assert = require("node:assert/strict");
const { settleEntitlements } = require("../../src/services/accountEntitlements");

test("account settlement picks the highest plan, farthest expiry, and sums remaining balances", () => {
  const out = settleEntitlements([
    { tier: "starter", subscriptionExpiresAt: "2030-01-02T00:00:00.000Z", messageQuotaRemaining: 4, voiceSecondsRemaining: 30, topUpCreditsRemaining: 2 },
    { tier: "growth", subscriptionExpiresAt: "2030-01-03T00:00:00.000Z", messageQuotaRemaining: 6, voiceSecondsRemaining: 20, topUpCreditsRemaining: 1 },
  ], { starter: { rank: 1 }, growth: { rank: 2 } }, Date.parse("2029-01-01T00:00:00.000Z"));
  assert.deepEqual(out, { plan: "growth", expiresAt: "2030-01-03T00:00:00.000Z", remainingMessages: 10, remainingVoiceSeconds: 50, remainingCredits: 3, settledAt: "2029-01-01T00:00:00.000Z" });
});
