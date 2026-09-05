const test = require("node:test");
const assert = require("node:assert/strict");
const { comparePlan } = require("../../scripts/firestore-migration");

test("migration comparison is repeatable and marks missing or changed documents", () => {
  const plan = [{ clientId: "a", firestoreHash: "one" }, { clientId: "b", firestoreHash: "two" }];
  assert.deepEqual(comparePlan(plan, [{ clientId: "a", firestoreHash: "one" }, { clientId: "b", firestoreHash: "old" }]).map((x) => x.state), ["equal", "different"]);
  assert.equal(comparePlan(plan, [])[0].state, "missing");
});
