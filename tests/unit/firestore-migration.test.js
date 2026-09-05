const test = require("node:test");
const assert = require("node:assert/strict");
const { comparePlan, applyPlan } = require("../../scripts/firestore-migration");

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

test("migration plan excludes explicitly quarantined legacy bots", () => {
  const { buildPlan } = require("../../scripts/firestore-migration");
  assert.deepEqual(buildPlan([{ id: "old", migrationExcludedAt: "now" }, { id: "live", displayName: "Live", escalation: { contactMethod: "x" } }]).map((x) => x.clientId), ["live"]);
});

test("migration apply requires confirmation, writes config and knowledge, and captures rollback", async () => {
  const calls = [];
  const repository = {
    async getBotConfig() { return { id: "bot", displayName: "old" }; },
    async getKnowledge() { return "old knowledge"; },
    async setBotConfig(config) { calls.push(["config", config.id]); },
    async setKnowledge(id, text) { calls.push(["knowledge", id, text]); },
  };
  await assert.rejects(() => applyPlan([{ clientId: "bot", document: { id: "bot" } }], { repository, confirm: "NO" }), /MIGRATION_APPLY/);
  const backupFile = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "migration-test-")) + "/rollback.json";
  const result = await applyPlan([{ clientId: "bot", document: { id: "bot" } }], { repository, confirm: "YES", backupFile, getKnowledgeSource: () => "new knowledge" });
  assert.equal(result.applied, 1);
  assert.deepEqual(calls, [["config", "bot"], ["knowledge", "bot", "new knowledge"]]);
  assert.equal(require("node:fs").existsSync(backupFile), true);
});
