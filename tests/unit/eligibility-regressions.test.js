const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "../..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");

function equalJson(actual, expected) { assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected); }

function load(file, stubs = {}, extra = {}) {
  const context = {
    module: { exports: {} },
    __dirname: path.dirname(path.join(root, file)),
    Buffer,
    URL,
    process: extra.process || process,
    Date: extra.Date || Date,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (["path", "crypto"].includes(name)) return require(name);
      if (name === "./clientEligibility" || name === "../services/clientEligibility") {
        return load("src/services/clientEligibility.js", stubs, extra);
      }
      throw Error("Unexpected import: " + name);
    },
    ...extra,
  };
  vm.runInNewContext(source(file), context, { filename: file });
  return context.module.exports;
}

function getClientEligibility() {
  if (fs.existsSync(path.join(root, "src/services/clientEligibility.js"))) {
    return load("src/services/clientEligibility.js", {});
  }
  return require("../../src/services/clientEligibility");
}

function createRegistry(fixedNow = null) {
  const extra = {};
  if (fixedNow !== null) {
    const RealDate = Date;
    class MockDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(fixedNow);
        else super(...args);
      }
      static now() {
        return fixedNow;
      }
    }
    extra.Date = MockDate;
  }
  return load(
    "src/clients/registry.js",
    {
      fs: { readdirSync: () => [] },
      "../services/apiKeys": { hashKey: (k) => `hash:${k}` },
    },
    extra
  );
}

function loadMessageGate(fixedNow = null, extra = {}) {
  const dateContext = {};
  if (fixedNow !== null) {
    const RealDate = Date;
    class MockDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(fixedNow);
        else super(...args);
      }
      static now() {
        return fixedNow;
      }
    }
    dateContext.Date = MockDate;
  }
  return load(
    "src/services/messageGate.js",
    {
      "../config": {
        plans: {
          starter: { allowWidget: false },
          growth: { allowWidget: true },
          pro: { allowWidget: true },
        },
        provisioning: { trialVoiceMinutes: 5 },
      },
      "./rateLimit": { checkLimit: () => ({ allowed: true }) },
      "./usageLedger": {},
      "./usageAnomaly": { checkAndAlert() {} },
      "./credits": { consumeOne: async () => false },
      "./handoff": { notifyCapReached: async () => {} },
    },
    { ...dateContext, ...extra }
  );
}

// ---------------------------------------------------------------------------
// 1. Pure parseExpiry tests (Asia/Beirut timezone, DST, ISO timestamps, errors)
// ---------------------------------------------------------------------------

test("parseExpiry parses summer date-only as Beirut end of day (21:00 UTC)", () => {
  const { parseExpiry } = getClientEligibility();
  const expected = Date.parse("2026-09-02T21:00:00.000Z");
  assert.equal(parseExpiry("2026-09-02"), expected);
});

test("parseExpiry parses winter date-only as Beirut end of day (22:00 UTC)", () => {
  const { parseExpiry } = getClientEligibility();
  const expected = Date.parse("2026-01-15T22:00:00.000Z");
  assert.equal(parseExpiry("2026-01-15"), expected);
});

test("parseExpiry respects Beirut DST spring boundary (UTC+2 to UTC+3 transition)", () => {
  const { parseExpiry } = getClientEligibility();
  // 2026-03-28 is before spring DST: end of day is 22:00 UTC
  assert.equal(parseExpiry("2026-03-28"), Date.parse("2026-03-28T22:00:00.000Z"));
  // 2026-03-29 is DST transition date: next day midnight in Beirut is in UTC+3 (21:00 UTC)
  assert.equal(parseExpiry("2026-03-29"), Date.parse("2026-03-29T21:00:00.000Z"));
});

test("parseExpiry respects Beirut DST autumn boundary (UTC+3 to UTC+2 transition)", () => {
  const { parseExpiry } = getClientEligibility();
  // 2026-10-24 repeats 23:00 during rollback; the next local date begins at 22:00 UTC
  assert.equal(parseExpiry("2026-10-24"), Date.parse("2026-10-24T22:00:00.000Z"));
  // 2026-10-25 is autumn DST change date: next day midnight is winter UTC+2 (22:00 UTC)
  assert.equal(parseExpiry("2026-10-25"), Date.parse("2026-10-25T22:00:00.000Z"));
});

test("parseExpiry preserves exact instant for full ISO timestamps with Z or offset", () => {
  const { parseExpiry } = getClientEligibility();
  assert.equal(
    parseExpiry("2026-09-02T15:30:00.000Z"),
    Date.parse("2026-09-02T15:30:00.000Z")
  );
  assert.equal(
    parseExpiry("2026-09-02T18:30:00.000+03:00"),
    Date.parse("2026-09-02T15:30:00.000Z")
  );
  assert.equal(
    parseExpiry("2026-01-15T12:00:00.000-05:00"),
    Date.parse("2026-01-15T17:00:00.000Z")
  );
});

test("parseExpiry rejects impossible calendar dates", () => {
  const { parseExpiry } = getClientEligibility();
  assert.equal(parseExpiry("2026-02-30"), null);
  assert.equal(parseExpiry("2026-04-31"), null);
  assert.equal(parseExpiry("2025-02-29"), null);
  assert.equal(parseExpiry("2026-13-01"), null);
  assert.equal(parseExpiry("2026-00-10"), null);
});

test("parseExpiry rejects timestamps without timezone and malformed inputs", () => {
  const { parseExpiry } = getClientEligibility();
  assert.equal(parseExpiry("2026-09-02T12:00:00"), null);
  assert.equal(parseExpiry("2026-09-02 12:00:00"), null);
  assert.equal(parseExpiry("not-a-date"), null);
  assert.equal(parseExpiry(""), null);
  assert.equal(parseExpiry(null), null);
  assert.equal(parseExpiry(undefined), null);
  assert.equal(parseExpiry(NaN), null);
  assert.equal(parseExpiry(1725282000000), null);
  assert.equal(parseExpiry({}), null);
});

// ---------------------------------------------------------------------------
// 2. Pure evaluateClientEligibility tests
// ---------------------------------------------------------------------------

test("evaluateClientEligibility rejects missing client with client_not_active", () => {
  const { evaluateClientEligibility } = getClientEligibility();
  const now = Date.parse("2026-09-02T12:00:00.000Z");
  equalJson(evaluateClientEligibility(null, now), { allowed: false, reason: "client_not_active" });
  equalJson(evaluateClientEligibility(undefined, now), { allowed: false, reason: "client_not_active" });
});

test("evaluateClientEligibility rejects preview, disabled, expired, and unknown statuses", () => {
  const { evaluateClientEligibility } = getClientEligibility();
  const now = Date.parse("2026-09-02T12:00:00.000Z");
  for (const status of ["preview", "disabled", "expired", "unknown_status", "pending", "archived"]) {
    const res = evaluateClientEligibility({ id: "bot", status }, now);
    equalJson(res, { allowed: false, reason: "client_not_active" });
  }
});

test("evaluateClientEligibility allows active manual client without expiry date", () => {
  const { evaluateClientEligibility } = getClientEligibility();
  const now = Date.parse("2026-09-02T12:00:00.000Z");
  equalJson(evaluateClientEligibility({ id: "manual-1", status: "active" }, now), { allowed: true });
  equalJson(evaluateClientEligibility({ id: "manual-2", status: "active", plan: "manual" }, now), { allowed: true });
});

test("evaluateClientEligibility allows legacy manual client with undefined status when no expiry set", () => {
  const { evaluateClientEligibility } = getClientEligibility();
  const now = Date.parse("2026-09-02T12:00:00.000Z");
  equalJson(evaluateClientEligibility({ id: "legacy-bot" }, now), { allowed: true });
  equalJson(evaluateClientEligibility({ id: "legacy-bot", status: undefined }, now), { allowed: true });
});

test("evaluateClientEligibility applies explicit subscription expiration to legacy clients", () => {
  const { evaluateClientEligibility } = getClientEligibility();
  const now = Date.parse("2026-09-02T12:00:00.000Z");
  const past = evaluateClientEligibility(
    { id: "legacy-expired", subscriptionExpiresAt: "2026-09-01T12:00:00.000Z" },
    now
  );
  equalJson(past, { allowed: false, reason: "subscription_expired" });

  const future = evaluateClientEligibility(
    { id: "legacy-valid", subscriptionExpiresAt: "2026-09-03T12:00:00.000Z" },
    now
  );
  equalJson(future, { allowed: true });
});

test("evaluateClientEligibility fails closed on trial clients with missing or blank expiry", () => {
  const { evaluateClientEligibility } = getClientEligibility();
  const now = Date.parse("2026-09-02T12:00:00.000Z");
  equalJson(
    evaluateClientEligibility({ id: "t1", status: "active", plan: "trial" }, now),
    { allowed: false, reason: "invalid_expiry" }
  );
  equalJson(
    evaluateClientEligibility({ id: "t2", status: "active", plan: "trial", trialExpiresAt: "" }, now),
    { allowed: false, reason: "invalid_expiry" }
  );
  equalJson(
    evaluateClientEligibility({ id: "t3", status: "active", plan: "trial", trialExpiresAt: null }, now),
    { allowed: false, reason: "invalid_expiry" }
  );
});

test("evaluateClientEligibility rejects trial clients with invalid expiry string", () => {
  const { evaluateClientEligibility } = getClientEligibility();
  const now = Date.parse("2026-09-02T12:00:00.000Z");
  equalJson(
    evaluateClientEligibility({ id: "t4", status: "active", plan: "trial", trialExpiresAt: "2026-02-30" }, now),
    { allowed: false, reason: "invalid_expiry" }
  );
  equalJson(
    evaluateClientEligibility({ id: "t5", status: "active", plan: "trial", trialExpiresAt: "not-a-date" }, now),
    { allowed: false, reason: "invalid_expiry" }
  );
});

test("evaluateClientEligibility rejects non-trial client with invalid subscription expiry", () => {
  const { evaluateClientEligibility } = getClientEligibility();
  const now = Date.parse("2026-09-02T12:00:00.000Z");
  equalJson(
    evaluateClientEligibility({ id: "sub-inv", status: "active", plan: "manual", subscriptionExpiresAt: "invalid" }, now),
    { allowed: false, reason: "invalid_expiry" }
  );
});

test("evaluateClientEligibility blocks trial client at now >= expiry (exact instant and past)", () => {
  const { evaluateClientEligibility } = getClientEligibility();
  const expiry = Date.parse("2026-09-02T12:00:00.000Z");
  const client = { id: "trial-bot", status: "active", plan: "trial", trialExpiresAt: "2026-09-02T12:00:00.000Z" };

  equalJson(evaluateClientEligibility(client, expiry - 1), { allowed: true });
  equalJson(evaluateClientEligibility(client, expiry), { allowed: false, reason: "trial_expired" });
  equalJson(evaluateClientEligibility(client, expiry + 1), { allowed: false, reason: "trial_expired" });
});

test("evaluateClientEligibility blocks subscription client at now >= expiry", () => {
  const { evaluateClientEligibility } = getClientEligibility();
  const expiry = Date.parse("2026-09-02T12:00:00.000Z");
  const client = { id: "sub-bot", status: "active", plan: "manual", subscriptionExpiresAt: "2026-09-02T12:00:00.000Z" };

  equalJson(evaluateClientEligibility(client, expiry - 1), { allowed: true });
  equalJson(evaluateClientEligibility(client, expiry), { allowed: false, reason: "subscription_expired" });
  equalJson(evaluateClientEligibility(client, expiry + 1), { allowed: false, reason: "subscription_expired" });
});

test("evaluateClientEligibility handles date-only Beirut expiry boundary for subscriptions", () => {
  const { evaluateClientEligibility } = getClientEligibility();
  // 2026-09-02 in Beirut ends at 2026-09-02T21:00:00.000Z (UTC)
  const beirutEndOfDay = Date.parse("2026-09-02T21:00:00.000Z");
  const client = { id: "sub-date-only", status: "active", plan: "manual", subscriptionExpiresAt: "2026-09-02" };

  equalJson(evaluateClientEligibility(client, beirutEndOfDay - 1), { allowed: true });
  equalJson(evaluateClientEligibility(client, beirutEndOfDay), { allowed: false, reason: "subscription_expired" });
});

// ---------------------------------------------------------------------------
// 3. Prove registry.isServable delegates the same policy
// ---------------------------------------------------------------------------

test("registry.isServable delegates: rejects missing client", () => {
  const registry = createRegistry();
  assert.equal(registry.isServable(null), false);
  assert.equal(registry.isServable(undefined), false);
});

test("registry.isServable delegates: rejects preview, disabled, expired, and unknown statuses", () => {
  const registry = createRegistry();
  assert.equal(registry.isServable({ id: "p", status: "preview" }), false);
  assert.equal(registry.isServable({ id: "d", status: "disabled" }), false);
  assert.equal(registry.isServable({ id: "e", status: "expired" }), false);
  assert.equal(registry.isServable({ id: "u", status: "unknown_state" }), false);
});

test("registry.isServable delegates: fails closed on trial with missing or invalid expiry", () => {
  const registry = createRegistry();
  assert.equal(registry.isServable({ id: "t1", status: "active", plan: "trial" }), false);
  assert.equal(registry.isServable({ id: "t2", status: "active", plan: "trial", trialExpiresAt: "" }), false);
  assert.equal(registry.isServable({ id: "t3", status: "active", plan: "trial", trialExpiresAt: "invalid" }), false);
  assert.equal(registry.isServable({ id: "t4", status: "active", plan: "trial", trialExpiresAt: "2026-02-30" }), false);
});

test("registry.isServable delegates: rejects expired trial bots at now >= expiry", () => {
  const expiry = Date.parse("2026-09-02T12:00:00.000Z");
  const client = { id: "t-exp", status: "active", plan: "trial", trialExpiresAt: "2026-09-02T12:00:00.000Z" };

  const regBefore = createRegistry(expiry - 1);
  assert.equal(regBefore.isServable(client, expiry - 1), true);

  const regExact = createRegistry(expiry);
  assert.equal(regExact.isServable(client, expiry), false);

  const regAfter = createRegistry(expiry + 1000);
  assert.equal(regAfter.isServable(client, expiry + 1000), false);
});

test("registry.isServable delegates: enforces subscriptionExpiresAt for paid plans", () => {
  const expiry = Date.parse("2026-09-02T12:00:00.000Z");
  const client = { id: "pro-bot", status: "active", plan: "manual", subscriptionExpiresAt: "2026-09-02T12:00:00.000Z" };

  const regBefore = createRegistry(expiry - 1);
  assert.equal(regBefore.isServable(client, expiry - 1), true);

  const regExact = createRegistry(expiry);
  assert.equal(regExact.isServable(client, expiry), false);
});

test("registry.isServable delegates: enforces subscriptionExpiresAt on legacy clients with undefined status", () => {
  const expiry = Date.parse("2026-09-02T12:00:00.000Z");
  const client = { id: "legacy-exp", subscriptionExpiresAt: "2026-09-02T12:00:00.000Z" };

  const regBefore = createRegistry(expiry - 1);
  assert.equal(regBefore.isServable(client, expiry - 1), true);

  const regExact = createRegistry(expiry);
  assert.equal(regExact.isServable(client, expiry), false);
});

test("registry.isServable delegates: retains unbounded manual and legacy clients without expiry", () => {
  const registry = createRegistry();
  assert.equal(registry.isServable({ id: "manual-unbounded", status: "active", plan: "manual" }), true);
  assert.equal(registry.isServable({ id: "legacy-unbounded" }), true);
});

// ---------------------------------------------------------------------------
// 4. Prove messageGate.evaluateStatic rejects on all four channels
// ---------------------------------------------------------------------------

const CHANNELS = ["web", "whatsapp", "telegram", "discord"];

test("messageGate.evaluateStatic rejects expired trial bots across all four channels", () => {
  const now = Date.parse("2026-09-02T12:00:00.000Z");
  const gate = loadMessageGate(now);
  const client = {
    id: "expired-trial",
    status: "active",
    plan: "trial",
    trialExpiresAt: "2026-09-01T12:00:00.000Z",
  };

  for (const ch of CHANNELS) {
    const res = gate.evaluateStatic(client, ch, now);
    equalJson(res, { allowed: false, reason: "trial_expired" });
  }
});

test("messageGate.evaluateStatic rejects expired subscription bots across all four channels", () => {
  const now = Date.parse("2026-09-02T12:00:00.000Z");
  const gate = loadMessageGate(now);
  const client = {
    id: "expired-sub",
    status: "active",
    tier: "growth",
    plan: "manual",
    subscriptionExpiresAt: "2026-09-01T12:00:00.000Z",
  };

  for (const ch of CHANNELS) {
    const res = gate.evaluateStatic(client, ch, now);
    equalJson(res, { allowed: false, reason: "subscription_expired" });
  }
});

test("messageGate.evaluateStatic rejects trial bot with missing or invalid expiry across all four channels", () => {
  const now = Date.parse("2026-09-02T12:00:00.000Z");
  const gate = loadMessageGate(now);
  const clientMissing = { id: "no-trial-date", status: "active", plan: "trial" };
  const clientInvalid = { id: "bad-trial-date", status: "active", plan: "trial", trialExpiresAt: "2026-02-30" };

  for (const ch of CHANNELS) {
    equalJson(gate.evaluateStatic(clientMissing, ch, now), { allowed: false, reason: "invalid_expiry" });
    equalJson(gate.evaluateStatic(clientInvalid, ch, now), { allowed: false, reason: "invalid_expiry" });
  }
});

test("messageGate.evaluateStatic rejects inactive statuses across all four channels", () => {
  const now = Date.parse("2026-09-02T12:00:00.000Z");
  const gate = loadMessageGate(now);

  for (const status of ["preview", "disabled", "expired", "unknown_status"]) {
    const client = { id: "inactive-bot", status };
    for (const ch of CHANNELS) {
      equalJson(gate.evaluateStatic(client, ch, now), { allowed: false, reason: "client_not_active" });
    }
  }
});

test("messageGate.evaluateStatic retains pause, channel off, and widget-tier constraints", () => {
  const now = Date.parse("2026-09-02T12:00:00.000Z");
  const gate = loadMessageGate(now);

  // Bot paused
  const pausedClient = { id: "p-bot", status: "active", botPaused: true };
  equalJson(gate.evaluateStatic(pausedClient, "web", now), { allowed: false, reason: "bot_paused" });
  equalJson(gate.evaluateStatic(pausedClient, "whatsapp", now), { allowed: false, reason: "bot_paused" });

  // Channel disabled
  const channelOffClient = {
    id: "ch-bot",
    status: "active",
    channels: { whatsapp: { enabled: false } },
  };
  equalJson(gate.evaluateStatic(channelOffClient, "whatsapp", now), { allowed: false, reason: "channel_off" });

  // Starter tier widget not included on web channel
  const starterClient = {
    id: "starter-bot",
    status: "active",
    tier: "starter",
    plan: "manual",
  };
  equalJson(gate.evaluateStatic(starterClient, "web", now), { allowed: false, reason: "widget_not_included" });
  equalJson(gate.evaluateStatic(starterClient, "whatsapp", now), { allowed: true });
});

test("messageGate.evaluateStatic allows compatible legacy manual and active bots", () => {
  const now = Date.parse("2026-09-02T12:00:00.000Z");
  const gate = loadMessageGate(now);

  const legacyClient = { id: "legacy-manual-bot" };
  for (const ch of CHANNELS) {
    equalJson(gate.evaluateStatic(legacyClient, ch, now), { allowed: true });
  }

  const activeManual = { id: "active-manual-bot", status: "active", plan: "manual" };
  for (const ch of CHANNELS) {
    equalJson(gate.evaluateStatic(activeManual, ch, now), { allowed: true });
  }
});
