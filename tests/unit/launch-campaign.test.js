const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { normalizeCampaignCode } = require("../../src/services/launchCampaign");
const provisioning = require("../../src/services/provisioning");

test("Launch Campaign - normalizeCampaignCode", async (t) => {
  await t.test("accepts exact allowlisted code", () => {
    assert.strictEqual(normalizeCampaignCode("clinics-launch-2026"), "clinics-launch-2026");
  });

  await t.test("rejects unknown code", () => {
    assert.strictEqual(normalizeCampaignCode("unknown-code"), null);
  });

  await t.test("rejects empty, null, and undefined", () => {
    assert.strictEqual(normalizeCampaignCode(""), null);
    assert.strictEqual(normalizeCampaignCode(null), null);
    assert.strictEqual(normalizeCampaignCode(undefined), null);
  });

  await t.test("handles whitespace around correct code", () => {
    assert.strictEqual(normalizeCampaignCode(" clinics-launch-2026 "), "clinics-launch-2026");
  });
});

test("Launch Campaign - signups.createPending", async (t) => {
  let pendingRecords = [];
  const fakeDb = {
    collection: () => ({
      where: () => ({
        where: () => ({
          limit: () => ({
            get: async () => ({ empty: true, docs: [] })
          })
        })
      }),
      doc: (id) => ({
        set: async (record) => { pendingRecords.push(record); }
      })
    })
  };

  const stubs = {
    "./firebaseAdmin": { db: fakeDb },
    crypto: require("node:crypto"),
  };

  const context = {
    module: { exports: {} },
    require: (name) => {
      if (stubs[name]) return stubs[name];
      throw Error("Unexpected dependency: " + name);
    }
  };

  const root = path.resolve(__dirname, "../..");
  const code = fs.readFileSync(path.join(root, "src/services/signups.js"), "utf8");
  vm.runInNewContext(code, context);
  const signups = context.module.exports;

  await t.test("pending signup stores campaign code", async () => {
    pendingRecords = [];
    const pending = await signups.createPending("test-owner-uid", {
      companyName: "Campaign Clinic",
      contactEmail: "clinic@example.com",
      notifyWhatsapp: "1234567",
      escalationPhone: "7654321",
      websiteUrl: "https://example.com",
      campaignCode: "clinics-launch-2026",
    });

    assert.strictEqual(pending.campaignCode, "clinics-launch-2026");
    assert.strictEqual(pendingRecords[0].campaignCode, "clinics-launch-2026");
  });
});

test("Launch Campaign - provisioning", async (t) => {
  await t.test("buildConfig creates client config with acquisition", async () => {
    const config = provisioning.buildConfig({
      slug: "acquisition-clinic",
      companyName: "Acquisition Clinic",
      contactEmail: "acq@example.com",
      notifyWhatsapp: "1111111",
      escalationPhone: "2222222",
      websiteUrl: "https://acq.example.com",
      source: { type: "website", value: "https://acq.example.com", ingestedAt: new Date().toISOString() },
      ownerUid: "owner-123",
      campaignCode: "clinics-launch-2026",
    });

    assert.ok(config.acquisition);
    assert.strictEqual(config.acquisition.campaignCode, "clinics-launch-2026");
    assert.ok(config.acquisition.capturedAt);
  });

  await t.test("buildConfig creates client config without acquisition for non-campaign", async () => {
    const config = provisioning.buildConfig({
      slug: "standard-clinic",
      companyName: "Standard Clinic",
      contactEmail: "std@example.com",
      notifyWhatsapp: "3333333",
      escalationPhone: "4444444",
      websiteUrl: "https://std.example.com",
      source: { type: "website", value: "https://std.example.com", ingestedAt: new Date().toISOString() },
      ownerUid: "owner-123",
    });

    assert.strictEqual(config.acquisition, undefined);
  });
});

test("signup page forwards only the campaign query parameter", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../src/public/signup.html"), "utf8");
  assert.match(html, /urlParams\.get\("campaign"\)/);
  assert.doesNotMatch(html, /urlParams\.get\("campaignCode"\)/);
});
