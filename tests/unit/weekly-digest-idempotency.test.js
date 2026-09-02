const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");

function load(stubs) {
  const context = {
    module: { exports: {} },
    console: { log() {}, error() {} },
    require(name) {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/services/weeklyDigest.js"), "utf8"), context);
  return context.module.exports;
}

test("weekly digest keeps a durable per-client week marker across service reload", async () => {
  const markers = new Map();
  const base = {
    "../clients/registry": { getAllClients: () => [{ id: "bot", plan: "manual", escalation: { notifyWhatsapp: "x" }, whatsappPhoneNumberId: "sender" }], isServable: () => true },
    "./whatsapp": { sendTextMessage: async () => {} },
    "./usageLedger": { peek: async () => ({ count: 0 }) },
    "./escalationLog": { readRecent: () => [] },
    "./escalationHandled": { getHandledIds: () => [] },
    "../config": { plans: {}, provisioning: { publicBaseUrl: "https://example.test" }, whatsapp: {} },
    "./safeWrite": {
      async updateClientConfig(id, updater) {
        const cfg = markers.get(id) || { id };
        markers.set(id, await updater(cfg));
      },
      safeReadJSON() { return null; },
    },
  };
  const first = load(base);
  assert.equal((await first.sendScheduledDigestsOnce(new Date("2026-09-06T09:00:00Z"))).sent, 1);
  const afterRestart = load(base);
  assert.equal((await afterRestart.sendScheduledDigestsOnce(new Date("2026-09-06T09:30:00Z"))).sent, 0);
});

test("concurrent scheduled digest runs reserve one provider send", async () => {
  const config = { id: "bot" };
  let sends = 0;
  let lock = Promise.resolve();
  const service = load({
    "../clients/registry": { getAllClients: () => [{ id: "bot", plan: "manual", escalation: { notifyWhatsapp: "x" }, whatsappPhoneNumberId: "sender" }], isServable: () => true },
    "./whatsapp": { sendTextMessage: async () => { sends++; } },
    "./usageLedger": { peek: async () => ({ count: 0 }) },
    "./escalationLog": { readRecent: () => [] }, "./escalationHandled": { getHandledIds: () => [] },
    "../config": { plans: {}, provisioning: { publicBaseUrl: "https://example.test" }, whatsapp: {} },
    "./safeWrite": { updateClientConfig: (_id, updater) => {
      const run = lock.then(async () => Object.assign(config, await updater(config)));
      lock = run.catch(() => {});
      return run;
    } },
  });
  await Promise.all([service.sendScheduledDigestsOnce(new Date("2026-09-06T09:00:00Z")), service.sendScheduledDigestsOnce(new Date("2026-09-06T09:00:00Z"))]);
  assert.equal(sends, 1);
});
