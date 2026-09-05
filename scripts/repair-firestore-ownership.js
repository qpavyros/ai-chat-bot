#!/usr/bin/env node
function validateRepairMap(entries, missingIds) {
  const missing = new Set(missingIds || []);
  const seenBots = new Set();
  const seenOwners = new Set();
  for (const entry of entries || []) {
    if (!entry || typeof entry.botId !== "string" || typeof entry.uid !== "string" || !entry.botId || !entry.uid) throw new Error("invalid ownership entry");
    if (!missing.has(entry.botId)) throw new Error(`bot is not missing ownership: ${entry.botId}`);
    if (seenBots.has(entry.botId)) throw new Error(`duplicate bot: ${entry.botId}`);
    seenBots.add(entry.botId);
    seenOwners.add(entry.uid);
  }
  return { complete: seenBots.size === missing.size, assigned: seenBots.size, owners: seenOwners.size };
}

if (require.main === module) {
  const input = process.argv[2];
  if (!input) throw new Error("usage: node repair-firestore-ownership.js map.json");
  const map = require(require("path").resolve(input));
  console.log(JSON.stringify(validateRepairMap(map.entries, map.missingIds), null, 2));
}

module.exports = { validateRepairMap };
