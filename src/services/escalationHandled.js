const path = require("path");
const safeWrite = require("./safeWrite");

function handledFilePath(clientId) {
  return path.join(safeWrite.dataDir(clientId), "escalations-handled.json");
}

function getHandledIds(clientId) {
  if (!clientId) return [];
  return safeWrite.safeReadJSON(handledFilePath(clientId), []);
}

async function markHandled(clientId, escalationId) {
  if (!clientId || !escalationId) return;
  return safeWrite.withClientLock(clientId, () => {
    const list = getHandledIds(clientId);
    if (!list.includes(escalationId)) {
      list.push(escalationId);
      safeWrite.rawWriteDataFile(clientId, "escalations-handled.json", JSON.stringify(list, null, 2));
    }
  });
}

async function unmarkHandled(clientId, escalationId) {
  if (!clientId || !escalationId) return;
  return safeWrite.withClientLock(clientId, () => {
    let list = getHandledIds(clientId);
    if (list.includes(escalationId)) {
      list = list.filter((id) => id !== escalationId);
      safeWrite.rawWriteDataFile(clientId, "escalations-handled.json", JSON.stringify(list, null, 2));
    }
  });
}

module.exports = {
  getHandledIds,
  markHandled,
  unmarkHandled,
};
