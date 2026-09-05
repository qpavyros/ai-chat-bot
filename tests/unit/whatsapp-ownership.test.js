const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyEmbeddedSignupOwnership } = require("../../src/services/whatsappOwnership");

test("embedded signup proves the phone and WABA with the exchanged user token", async () => {
  const calls = [];
  const client = {
    get: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/oauth/access_token")) return { data: { access_token: "user-token" } };
      if (url.endsWith("/phone-123")) return { data: { id: "phone-123", waba_id: "waba-9" } };
      if (url.endsWith("/waba-9")) return { data: { id: "waba-9" } };
      throw new Error(`unexpected ${url}`);
    },
  };

  const result = await verifyEmbeddedSignupOwnership({
    axios: client,
    graphVersion: "v20.0",
    appId: "app",
    appSecret: "secret",
    code: "oauth-code",
    phoneNumberId: "phone-123",
    wabaId: "waba-9",
  });

  assert.deepEqual(result, { accessToken: "user-token", phoneNumberId: "phone-123", wabaId: "waba-9" });
  assert.equal(calls[1].options.headers.Authorization, "Bearer user-token");
  assert.equal(calls[2].options.headers.Authorization, "Bearer user-token");
});

test("embedded signup rejects a phone returned for a different WABA", async () => {
  const client = {
    get: async (url) => {
      if (url.endsWith("/oauth/access_token")) return { data: { access_token: "user-token" } };
      if (url.endsWith("/phone-123")) return { data: { id: "phone-123", waba_id: "other-waba" } };
      throw new Error(`unexpected ${url}`);
    },
  };

  await assert.rejects(
    () => verifyEmbeddedSignupOwnership({ axios: client, graphVersion: "v20.0", appId: "app", appSecret: "secret", code: "code", phoneNumberId: "phone-123", wabaId: "waba-9" }),
    (error) => error.code === "whatsapp_ownership_mismatch"
  );
});
