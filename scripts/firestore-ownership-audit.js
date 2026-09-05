#!/usr/bin/env node
const fs = require("fs");
const registry = require("../src/clients/registry");

function auditOwnership(botIds, profiles) {
  const owners = new Map();
  for (const profile of profiles || []) {
    for (const botId of profile?.bots || []) {
      const list = owners.get(botId) || [];
      list.push(profile.uid);
      owners.set(botId, list);
    }
  }
  const conflicts = [...owners].filter(([, values]) => new Set(values).size > 1).map(([botId, values]) => ({ botId, owners: [...new Set(values)] }));
  const missing = botIds.filter((botId) => !owners.has(botId));
  return { conflicts, missing, owned: [...owners].filter(([, values]) => new Set(values).size === 1).length };
}

async function run() {
  const { db } = require("../src/services/firebaseAdmin");
  const snapshot = await db.collection("users").get();
  const profiles = snapshot.docs.map((doc) => doc.data());
  const result = { generatedAt: new Date().toISOString(), ...auditOwnership(registry.getAllClients().map((client) => client.id), profiles) };
  const output = process.argv[2] || "firestore-ownership-audit.json";
  fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output, conflicts: result.conflicts.length, missing: result.missing.length, owned: result.owned }));
}

if (require.main === module) run().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { auditOwnership };
