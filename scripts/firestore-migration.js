#!/usr/bin/env node
// Migration planning only. It never writes Firestore unless the caller supplies
// an explicit apply implementation after reviewing the exported plan.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const registry = require("../src/clients/registry");
const { toFirestoreBot, splitKnowledge } = require("../src/services/storageRepository");

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function buildPlan(clients) {
  return clients.map((client) => {
    const projected = toFirestoreBot(client);
    const knowledge = String(client.knowledge || "");
    return { clientId: client.id, sourceHash: fingerprint(client), firestoreHash: fingerprint(projected), document: projected, knowledge: { digest: fingerprint(knowledge), chars: knowledge.length, chunks: splitKnowledge(knowledge).length } };
  }).sort((a, b) => a.clientId.localeCompare(b.clientId));
}

function comparePlan(plan, existing) {
  const current = new Map((existing || []).map((row) => [row.clientId, row.firestoreHash]));
  return plan.map((row) => ({ ...row, state: current.get(row.clientId) === row.firestoreHash ? "equal" : current.has(row.clientId) ? "different" : "missing" }));
}

if (require.main === module) {
  const output = process.argv[2] || path.join(process.cwd(), "firestore-migration-plan.json");
  const plan = buildPlan(registry.getAllClients());
  fs.writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(), mode: "dry-run", plan }, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output, bots: plan.length, mode: "dry-run" }));
}

module.exports = { fingerprint, buildPlan, comparePlan };
