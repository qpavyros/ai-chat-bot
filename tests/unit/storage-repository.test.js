const test = require("node:test");
const assert = require("node:assert/strict");
const { toFirestoreBot, fromFirestoreBot } = require("../../src/services/storageRepository");

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
