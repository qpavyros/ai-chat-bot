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

test("account voice reservation debits and refunds atomically", async () => {
  let entitlement = { remainingVoiceSeconds: 90 };
  let reservation = null;
  const refs = { entitlement: {}, reservation: {} };
  const firestore = {
    collection: (name) => ({ doc: () => name === "users" ? { collection: () => ({ doc: () => refs.entitlement }) } : refs.reservation }),
    runTransaction: async (fn) => fn({
      get: async (ref) => ref === refs.entitlement ? { exists: true, data: () => entitlement } : { exists: Boolean(reservation), data: () => reservation },
      getAll: async (...wanted) => wanted.map(ref => ref === refs.entitlement ? { exists: true, data: () => entitlement } : { exists: Boolean(reservation), data: () => reservation }),
      set: (ref, next) => { if (ref === refs.entitlement) entitlement = next; else reservation = next; },
      update: (ref, next) => { reservation = { ...reservation, ...next }; },
    }),
  };
  const entitlements = createAccountEntitlements({ firestore });
  const held = await entitlements.reserveVoice("uid-1", 30, "op-1");
  assert.equal(held.allowed, true);
  assert.equal(entitlement.remainingVoiceSeconds, 60);
  await entitlements.refundVoiceReservation(held.reservationId);
  assert.equal(entitlement.remainingVoiceSeconds, 90);
});

test("account credits decrement once and refuse an empty balance", async () => {
  let data = { remainingCredits: 1 };
  const ref = {};
  const firestore = {
    collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ref }) }) }),
    runTransaction: async (fn) => fn({
      get: async () => ({ exists: true, data: () => data }),
      set: (_ref, next) => { data = next; },
    }),
  };
  const entitlements = createAccountEntitlements({ firestore });
  assert.equal((await entitlements.consumeCredit("uid-1")).available, true);
  assert.deepEqual(await entitlements.consumeCredit("uid-1"), { available: false, reason: "credit_empty" });
});

test("account credit grant is idempotent", async () => {
  let data = { remainingCredits: 2 };
  const ref = {};
  const firestore = {
    collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ref }) }) }),
    runTransaction: async (fn) => fn({
      get: async () => ({ exists: true, data: () => data }),
      set: (_ref, next) => { data = next; },
    }),
  };
  const entitlements = createAccountEntitlements({ firestore });
  const first = await entitlements.addCredits("uid-1", 5, "pay-1", { pack: "small" });
  const replay = await entitlements.addCredits("uid-1", 5, "pay-1", { pack: "small" });
  assert.deepEqual(first, { ok: true, added: 5, balance: 7 });
  assert.deepEqual(replay, first);
  assert.equal(data.remainingCredits, 7);
});
