// حالة التدخل البشري دائمة لكل بوت، حتى لا تعود الإجابة الآلية بعد إعادة تشغيل السيرفر.
// سجل JSON صغير لكل بوت؛ الكتابة محصورة بمجلد البيانات الآمن.
const path = require("path");
const safeWrite = require("./safeWrite");

function key(clientId, userId) {
  return `${clientId}:${userId}`;
}

const pausedUntil = new Map(); // hot cache; file remains source of truth after restart
function statePath(clientId) { return path.join(safeWrite.dataDir(clientId), "takeovers.json"); }
function loadClient(clientId) {
  const raw = safeWrite.safeReadJSON(statePath(clientId), {});
  const now = Date.now();
  for (const [userId, until] of Object.entries(raw || {})) {
    if (Number.isFinite(until) && until > now) pausedUntil.set(key(clientId, userId), until);
  }
}
function persistClient(clientId) {
  const prefix = `${clientId}:`;
  const now = Date.now();
  const state = {};
  for (const [k, until] of pausedUntil.entries()) {
    if (k.startsWith(prefix) && until > now) state[k.slice(prefix.length)] = until;
  }
  safeWrite.rawWriteDataFile(clientId, "takeovers.json", JSON.stringify(state, null, 2));
  if (typeof process !== "undefined" && process.env.FIRESTORE_MIRROR_WRITES === "true") {
    require("./storageRepository").mirrorBusinessData(clientId, "takeovers", state).catch((error) =>
      console.error("[firestore] takeover mirror failed:", error.message)
    );
  }
}

function pauseForHandoff(clientId, userId, ms = 24 * 60 * 60 * 1000) {
  loadClient(clientId);
  pausedUntil.set(key(clientId, userId), Date.now() + ms);
  persistClient(clientId);
}

function resumeFromHandoff(clientId, userId) {
  loadClient(clientId);
  pausedUntil.delete(key(clientId, userId));
  persistClient(clientId);
}

function isPaused(clientId, userId) {
  loadClient(clientId);
  const until = pausedUntil.get(key(clientId, userId));
  return typeof until === "number" && until > Date.now();
}

function getPausedConversations(clientId) {
  loadClient(clientId);
  const result = [];
  const prefix = `${clientId}:`;
  const now = Date.now();
  for (const [k, until] of pausedUntil.entries()) {
    if (k.startsWith(prefix) && until > now) {
      const endUserId = k.slice(prefix.length);
      result.push({ endUserId, pausedUntil: until, remainingMinutes: Math.ceil((until - now) / 60000) });
    }
  }
  return result;
}

module.exports = { pauseForHandoff, resumeFromHandoff, isPaused, getPausedConversations };
