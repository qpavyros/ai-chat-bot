const test = require("node:test");
const assert = require("node:assert/strict");
const { toFirestoreBot, fromFirestoreBot, splitKnowledge, mirrorBotConfig, mirrorBusinessData, hydrateBusinessData, readHydratedBusinessData } = require("../../src/services/storageRepository");

test("Firestore bot projection excludes channel credentials and round-trips public settings", () => {
  const data = toFirestoreBot({
    id: "bot-1", displayName: "Synthetic", telegramBotToken: "secret", discordBotToken: "secret2",
    escalation: { contactMethod: "phone", phone: "000" }, channels: { web: { enabled: true } },
  });
  assert.equal(data.telegramBotToken, undefined);
  assert.equal(data.discordBotToken, undefined);
  assert.equal(fromFirestoreBot(data).displayName, "Synthetic");
  assert.equal(fromFirestoreBot(data).schemaVersion, undefined);
});

test("knowledge is split into ordered bounded chunks", () => {
  assert.deepEqual(splitKnowledge("abcdef", 2), ["ab", "cd", "ef"]);
});

test("Firestore mirror is opt-in and stays inert by default", async () => {
  const previous = process.env.FIRESTORE_MIRROR_WRITES;
  delete process.env.FIRESTORE_MIRROR_WRITES;
  assert.deepEqual(await mirrorBotConfig({ id: "bot" }), { mirrored: false, reason: "disabled" });
  if (previous === undefined) delete process.env.FIRESTORE_MIRROR_WRITES;
  else process.env.FIRESTORE_MIRROR_WRITES = previous;
});

test("knowledge writes are idempotent when the latest digest is unchanged", async () => {
  const versionDoc = { version: "v1", digest: require("crypto").createHash("sha256").update("same").digest("hex"), chunkCount: 1 };
  let writes = 0;
  const versions = { orderBy: () => ({ limit: () => ({ get: async () => ({ empty: false, docs: [{ data: () => versionDoc }] }) }) }) };
  const db = { collection: () => ({ doc: () => ({ collection: () => versions }) }), batch: () => ({ set() {}, commit: async () => { writes += 1; } }) };
  const { createRepository } = require("../../src/services/storageRepository");
  const result = await createRepository({ db }).setKnowledge("bot", "same");
  assert.equal(result.version, "v1");
  assert.equal(writes, 0);
});

test("business data mirror is opt-in", async () => {
  const previous = process.env.FIRESTORE_MIRROR_WRITES;
  delete process.env.FIRESTORE_MIRROR_WRITES;
  assert.deepEqual(await mirrorBusinessData("bot", "orders", []), { mirrored: false, reason: "disabled" });
  if (previous === undefined) delete process.env.FIRESTORE_MIRROR_WRITES;
  else process.env.FIRESTORE_MIRROR_WRITES = previous;
});

test("source-of-truth hydration serves business data from Firestore cache", async () => {
  const previous = process.env.FIRESTORE_SOURCE_OF_TRUTH;
  process.env.FIRESTORE_SOURCE_OF_TRUTH = "true";
  const db = { collection: () => ({ doc: () => ({ collection: () => ({ get: async () => ({ docs: [{ id: "orders", data: () => ({ value: [{ id: "remote-order" }] }) }] }) }) }) }) };
  await hydrateBusinessData("bot", { db });
  assert.deepEqual(readHydratedBusinessData("bot", "orders", [{ id: "local-order" }]), [{ id: "remote-order" }]);
  if (previous === undefined) delete process.env.FIRESTORE_SOURCE_OF_TRUTH;
  else process.env.FIRESTORE_SOURCE_OF_TRUTH = previous;
});
