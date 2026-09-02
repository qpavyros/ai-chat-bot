const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../../src/services/userAccounts.js"), "utf8");

function service(decoded) {
  const context = { module: { exports: {} }, require(name) {
    if (name === "./firebaseAdmin") return { db: {}, auth: { verifyIdToken: async () => decoded } };
    throw new Error(`Unexpected dependency: ${name}`);
  } };
  vm.runInNewContext(source, context);
  return context.module.exports;
}

test("recent identity proof requires the same user and a fresh auth_time", async () => {
  const now = 1_800_000_000_000;
  const ok = service({ uid: "owner", auth_time: Math.floor((now - 4 * 60_000) / 1000) });
  assert.equal(await ok.verifyRecentIdentity("token", "owner", { now, maxAgeMs: 5 * 60_000 }), true);
  assert.equal(await ok.verifyRecentIdentity("token", "other", { now, maxAgeMs: 5 * 60_000 }), false);
  const stale = service({ uid: "owner", auth_time: Math.floor((now - 6 * 60_000) / 1000) });
  assert.equal(await stale.verifyRecentIdentity("token", "owner", { now, maxAgeMs: 5 * 60_000 }), false);
});
