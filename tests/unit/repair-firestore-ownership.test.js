const test = require("node:test");
const assert = require("node:assert/strict");
const { validateRepairMap } = require("../../scripts/repair-firestore-ownership");

test("ownership repair map must cover only missing bots and reject duplicates", () => {
  assert.deepEqual(validateRepairMap([{ botId: "a", uid: "u" }, { botId: "b", uid: "u" }], ["a", "b"]), { complete: true, assigned: 2, owners: 1 });
  assert.throws(() => validateRepairMap([{ botId: "a", uid: "u" }, { botId: "a", uid: "v" }], ["a"]), /duplicate/);
  assert.throws(() => validateRepairMap([{ botId: "other", uid: "u" }], ["a"]), /not missing/);
});
