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

test("account payment extends from the farther existing expiry and is idempotent", async () => {
  let data = { plan: "starter", expiresAt: "2030-01-01T00:00:00.000Z" };
  const ref = {};
  const firestore = {
    collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ref }) }) }),
    runTransaction: async (fn) => fn({
      get: async () => ({ exists: true, data: () => data }),
      set: (_ref, next) => { data = next; },
    }),
  };
  const entitlements = createAccountEntitlements({ firestore });
  const first = await entitlements.recordPayment("uid-1", { operationId: "pay-1", tier: "growth", now: Date.parse("2029-01-01T00:00:00.000Z") });
  const replay = await entitlements.recordPayment("uid-1", { operationId: "pay-1", tier: "growth", now: Date.parse("2029-01-01T00:00:00.000Z") });
  assert.equal(first.nextExpiry, "2030-01-31T00:00:00.000Z");
  assert.deepEqual(replay, first);
  assert.equal(data.plan, "growth");
});

test("account entitlement ensure creates once without granting again", async () => {
  let data = null;
  const ref = {};
  const firestore = {
    collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ref }) }) }),
    runTransaction: async (fn) => fn({
      get: async () => ({ exists: data !== null, data: () => data }),
      set: (_ref, next) => { data = next; },
    }),
  };
  const service = createAccountEntitlements({ firestore });
  const first = await service.ensure("uid-1", { remainingMessages: 120, remainingVoiceSeconds: 300, now: 1 });
  const second = await service.ensure("uid-1", { remainingMessages: 999, remainingVoiceSeconds: 999, now: 2 });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(data.remainingMessages, 120);
  assert.equal(data.remainingVoiceSeconds, 300);
});

test("campaign offer reads only matching discount state and server plan prices", async () => {
  const docs = new Map([
    ["users/uid-1/billing/entitlements", { discountCampaignCode: "other-campaign", discountStatus: "active", discountPercent: 90 }],
    ["marketingCampaigns/clinics-launch-2026", { claimedCount: 2, claims: {} }],
  ]);
  function ref(path) {
    return {
      path,
      collection: (name) => ({ doc: (id) => ref(`${path}/${name}/${id}`) }),
      get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    };
  }
  const firestore = { collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }) };
  const offer = await createAccountEntitlements({ firestore }).getCampaignOffer(
    "uid-1",
    "clinics-launch-2026",
    { starter: { price: 29 }, invalid: { price: "free" } }
  );

  assert.deepEqual(offer, {
    campaignCode: "clinics-launch-2026",
    discountPercent: 20,
    status: "eligible",
    discountedPrices: { starter: 23.2 },
    graceUntil: null,
    remainingSpots: 3,
  });
});

function createCampaignFirestore(initial = {}) {
  const store = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
  let queue = Promise.resolve();
  function docRef(path) {
    return {
      path,
      collection(name) { return { doc: (id) => docRef(`${path}/${name}/${id}`) }; },
    };
  }
  const firestore = {
    collection(name) { return { doc: (id) => docRef(`${name}/${id}`) }; },
    runTransaction(fn) {
      const run = queue.then(async () => {
        const writes = [];
        const snapshot = (ref) => ({
          exists: store.has(ref.path),
          data: () => structuredClone(store.get(ref.path)),
        });
        const tx = {
          get: async (ref) => snapshot(ref),
          getAll: async (...refs) => refs.map(snapshot),
          set: (ref, value) => writes.push([ref.path, structuredClone(value)]),
        };
        const result = await fn(tx);
        for (const [path, value] of writes) store.set(path, value);
        return result;
      });
      queue = run.catch(() => {});
      return run;
    },
  };
  return { firestore, read: (path) => structuredClone(store.get(path)) };
}

test("clinics launch discount is claimed atomically on the first payment", async () => {
  const now = Date.parse("2026-09-06T12:00:00.000Z");
  const { firestore, read } = createCampaignFirestore({
    "users/uid-1/billing/entitlements": { plan: "starter", expiresAt: "2026-09-07T12:00:00.000Z" },
  });
  const service = createAccountEntitlements({ firestore });
  const result = await service.recordPayment("uid-1", {
    operationId: "payment-1",
    tier: "starter",
    amountUsd: 29,
    campaignCode: "clinics-launch-2026",
    now,
  });

  assert.equal(result.chargedAmountUsd, 23.2);
  assert.equal(result.discountApplied, true);
  assert.equal(result.discountStatus, "active");
  assert.equal(read("marketingCampaigns/clinics-launch-2026").claimedCount, 1);
  const entitlement = read("users/uid-1/billing/entitlements");
  assert.equal(entitlement.discountPercent, 20);
  assert.equal(entitlement.discountCampaignCode, "clinics-launch-2026");
  assert.equal(entitlement.discountGraceUntil, "2026-10-14T12:00:00.000Z");
});

test("campaign payment replay returns the original result without a second claim", async () => {
  const now = Date.parse("2026-09-06T12:00:00.000Z");
  const { firestore, read } = createCampaignFirestore({
    "users/uid-1/billing/entitlements": { plan: "starter" },
  });
  const service = createAccountEntitlements({ firestore });
  const input = { operationId: "same-payment", tier: "starter", amountUsd: 29, campaignCode: "clinics-launch-2026", now };
  const first = await service.recordPayment("uid-1", input);
  const replay = await service.recordPayment("uid-1", input);

  assert.deepEqual(replay, first);
  assert.equal(read("marketingCampaigns/clinics-launch-2026").claimedCount, 1);
  assert.equal(Object.keys(read("users/uid-1/billing/entitlements").paymentOperations).length, 1);
});

test("only five concurrent campaign accounts receive the founders discount", async () => {
  const now = Date.parse("2026-09-06T12:00:00.000Z");
  const initial = {};
  for (let i = 1; i <= 6; i += 1) initial[`users/uid-${i}/billing/entitlements`] = { plan: "starter" };
  const { firestore, read } = createCampaignFirestore(initial);
  const service = createAccountEntitlements({ firestore });
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => service.recordPayment(`uid-${index + 1}`, {
    operationId: `payment-${index + 1}`,
    tier: "starter",
    amountUsd: 29,
    campaignCode: "clinics-launch-2026",
    now,
  })));

  assert.equal(results.filter((result) => result.discountApplied).length, 5);
  assert.equal(results.filter((result) => result.discountStatus === "unavailable").length, 1);
  assert.equal(read("marketingCampaigns/clinics-launch-2026").claimedCount, 5);
});

test("active founders discount follows plan changes and renews through the exact grace boundary", async () => {
  const grace = "2026-09-13T12:00:00.000Z";
  const now = Date.parse(grace);
  const { firestore, read } = createCampaignFirestore({
    "users/uid-1/billing/entitlements": {
      plan: "starter",
      expiresAt: "2026-09-06T12:00:00.000Z",
      discountPercent: 20,
      discountCampaignCode: "clinics-launch-2026",
      discountClaimedAt: "2026-08-01T12:00:00.000Z",
      discountStatus: "active",
      discountGraceUntil: grace,
      paymentOperations: { old: { result: { ok: true } } },
    },
  });
  const service = createAccountEntitlements({ firestore });
  const result = await service.recordPayment("uid-1", { operationId: "renew", tier: "pro", amountUsd: 99, now });

  assert.equal(result.chargedAmountUsd, 79.2);
  assert.equal(result.plan, "pro");
  assert.equal(result.discountStatus, "active");
  assert.equal(read("users/uid-1/billing/entitlements").discountGraceUntil, "2026-10-20T12:00:00.000Z");
});

test("late renewal permanently lapses the founders discount and charges full price", async () => {
  const { firestore, read } = createCampaignFirestore({
    "users/uid-1/billing/entitlements": {
      plan: "starter",
      expiresAt: "2026-09-06T12:00:00.000Z",
      discountPercent: 20,
      discountCampaignCode: "clinics-launch-2026",
      discountClaimedAt: "2026-08-01T12:00:00.000Z",
      discountStatus: "active",
      discountGraceUntil: "2026-09-13T12:00:00.000Z",
      paymentOperations: { old: { result: { ok: true } } },
    },
  });
  const service = createAccountEntitlements({ firestore });
  const result = await service.recordPayment("uid-1", {
    operationId: "late-renewal",
    tier: "growth",
    amountUsd: 59,
    campaignCode: "clinics-launch-2026",
    now: Date.parse("2026-09-13T12:00:00.001Z"),
  });

  assert.equal(result.chargedAmountUsd, 59);
  assert.equal(result.discountApplied, false);
  assert.equal(result.discountStatus, "lapsed");
  assert.equal(read("users/uid-1/billing/entitlements").discountStatus, "lapsed");
});
