const path = require("path");
const crypto = require("crypto");
const safeWrite = require("./safeWrite");
const jsonlLog = require("./jsonlLog");

// سجل تصعيدات لكل عميل — JSONL بسقف تلقائي (راجع jsonlLog.js): كان بينمو للأبد وreadRecent
// كان يقرأ الملف كامل عند كل طلب أدمن/بورتال/تحليلات.
function logPath(clientId) {
  return path.join(safeWrite.dataDir(clientId), "escalations.log");
}

function record(clientId, { channel, endUserId, lastMessage }) {
  if (!clientId) return null;
  const entry = {
    id: crypto.randomBytes(8).toString("hex"),
    at: new Date().toISOString(),
    channel,
    endUserId,
    lastMessage,
  };
  jsonlLog.appendCapped(logPath(clientId), entry, { maxBytes: 256 * 1024, keepLast: 500 });
  if (typeof process !== "undefined" && process.env.FIRESTORE_MIRROR_WRITES === "true") {
    require("./storageRepository").mirrorBusinessData(clientId, "escalations", readRecent(clientId, 500)).catch((error) =>
      console.error("[firestore] escalation mirror failed:", error.message)
    );
  }
  return entry;
}

function readRecent(clientId, limit = 100) {
  if (!clientId) return [];
  const local = jsonlLog.readRecent(logPath(clientId), limit);
  return require("./storageRepository").readHydratedBusinessData(clientId, "escalations", local).slice(0, limit);
}

function readPage(clientId, options = {}) {
  if (!clientId) return { entries: [], nextCursor: null };
  return jsonlLog.readPage(logPath(clientId), options);
}

module.exports = { record, readRecent, readPage };
