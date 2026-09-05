// سجل تدقيق append-only لكل تعديل يصير من لوحة تحكم المشغّل — قرار مجلس LLM (Tier 2):
// مع أكتر من عميل بتصير تنسى مين غيّرت شو وإيمتى، وهاد الملف هو الوحيد اللي بينقذك وقتها.
// بسقف تلقائي (jsonlLog.js) حتى ما ينمو للأبد — نحتفظ بآخر 1000 عملية، والقديم بيروح.
const path = require("path");
const jsonlLog = require("./jsonlLog");

const LOG_PATH = path.join(__dirname, "..", "..", "data", "admin-audit.log");

function record(action, clientId, details = {}) {
  const entry = {
    at: new Date().toISOString(),
    action, // "create_client" | "update_config" | "update_knowledge" | "renew" | "login" | "login_failed"
    clientId: clientId || null,
    details,
  };
  jsonlLog.appendCapped(LOG_PATH, entry, { maxBytes: 256 * 1024, keepLast: 1000 });
}

function readRecent(limit = 100) {
  return jsonlLog.readRecent(LOG_PATH, limit);
}

function readPage(options = {}) {
  return jsonlLog.readPage(LOG_PATH, options);
}

module.exports = { record, readRecent, readPage };
