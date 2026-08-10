// سجل تدقيق append-only لكل تعديل يصير من لوحة تحكم المشغّل — قرار مجلس LLM (Tier 2):
// مع أكتر من عميل بتصير تنسى مين غيّرت شو وإيمتى، وهاد الملف هو الوحيد اللي بينقذك وقتها.
const fs = require("fs");
const path = require("path");

const LOG_PATH = path.join(__dirname, "..", "..", "data", "admin-audit.log");

function record(action, clientId, details = {}) {
  const entry = {
    at: new Date().toISOString(),
    action, // "create_client" | "update_config" | "update_knowledge" | "renew" | "login" | "login_failed"
    clientId: clientId || null,
    details,
  };
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
}

function readRecent(limit = 100) {
  if (!fs.existsSync(LOG_PATH)) return [];
  const lines = fs.readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).reverse().map((line) => JSON.parse(line));
}

module.exports = { record, readRecent };
