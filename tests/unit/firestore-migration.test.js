const test = require("node:test");
const assert = require("node:assert/strict");
const { comparePlan } = require("../../scripts/firestore-migration");

test("migration comparison is repeatable and marks missing or changed documents", () => {
  const plan = [{ clientId: "a", firestoreHash: "one" }, { clientId: "b", firestoreHash: "two" }];
  assert.deepEqual(comparePlan(plan, [{ clientId: "a", firestoreHash: "one" }, { clientId: "b", firestoreHash: "old" }]).map((x) => x.state), ["equal", "different"]);
  assert.equal(comparePlan(plan, [])[0].state, "missing");
});

test("knowledge metadata is part of the migration record without exposing content", () => {
  const { buildPlan } = require("../../scripts/firestore-migration");
  const row = buildPlan([{ id: "bot", displayName: "Bot", escalation: { contactMethod: "x" }, knowledge: "secret knowledge" }])[0];
  assert.equal(row.knowledge.chunks, 1);
  assert.equal(row.document.knowledge, undefined);
});
