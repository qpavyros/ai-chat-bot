#!/usr/bin/env node
// Migration planning plus an explicit, guarded apply path. The default remains dry-run.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const registry = require("../src/clients/registry");
const { toFirestoreBot, splitKnowledge } = require("../src/services/storageRepository");

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function buildPlan(clients) {
  return clients.filter((client) => !client.migrationExcludedAt).map((client) => {
    const projected = toFirestoreBot(client);
    const knowledge = String(client.knowledge || "");
    return { clientId: client.id, sourceHash: fingerprint(client), firestoreHash: fingerprint(projected), document: projected, knowledge: { digest: fingerprint(knowledge), chars: knowledge.length, chunks: splitKnowledge(knowledge).length } };
  }).sort((a, b) => a.clientId.localeCompare(b.clientId));
}

function comparePlan(plan, existing) {
  const current = new Map((existing || []).map((row) => [row.clientId, row.firestoreHash]));
  return plan.map((row) => ({ ...row, state: current.get(row.clientId) === row.firestoreHash ? "equal" : current.has(row.clientId) ? "different" : "missing" }));
}

async function applyPlan(plan, { repository, backupFile, confirm = process.env.MIGRATION_APPLY, getKnowledgeSource = (id) => registry.getClientById(id)?.knowledge || "" } = {}) {
  if (confirm !== "YES") throw new Error("Migration apply requires MIGRATION_APPLY=YES");
  if (!repository || typeof repository.getBotConfig !== "function") throw new Error("Firestore repository required");
  const backup = [];
  for (const row of plan) {
    const current = await repository.getBotConfig(row.clientId);
    const knowledge = current ? await repository.getKnowledge(row.clientId) : null;
    backup.push({ clientId: row.clientId, config: current, knowledge });
  }
  if (backupFile) fs.writeFileSync(backupFile, JSON.stringify({ createdAt: new Date().toISOString(), backup }, null, 2), { flag: "wx" });
  for (const row of plan) {
    await repository.setBotConfig(row.document);
    await repository.setKnowledge(row.clientId, String(getKnowledgeSource(row.clientId) || ""));
  }
  return { applied: plan.length, backupFile: backupFile || null };
}

if (require.main === module) {
  const output = process.argv[2] || path.join(process.cwd(), "firestore-migration-plan.json");
  const plan = buildPlan(registry.getAllClients());
  if (process.argv.includes("--apply")) {
    const { db } = require("../src/services/firebaseAdmin");
    const { createRepository } = require("../src/services/storageRepository");
    const backupFile = process.argv[3] || `${output}.rollback.json`;
    applyPlan(plan, { repository: createRepository({ db }), backupFile }).then((result) => {
      console.log(JSON.stringify({ output, ...result, mode: "apply" }));
    }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  } else {
  fs.writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(), mode: "dry-run", plan }, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output, bots: plan.length, mode: "dry-run" }));
  }
}

module.exports = { fingerprint, buildPlan, comparePlan, applyPlan };
