const test = require("node:test");
const assert = require("node:assert/strict");
const { auditOwnership } = require("../../scripts/firestore-ownership-audit");

test("ownership audit blocks missing and conflicting bot ownership", () => {
  const result = auditOwnership(["a", "b", "c"], [{ uid: "u1", bots: ["a", "b"] }, { uid: "u2", bots: ["b"] }]);
  assert.deepEqual(result.missing, ["c"]);
  assert.deepEqual(result.conflicts, [{ botId: "b", owners: ["u1", "u2"] }]);
  assert.equal(result.owned, 1);
});
