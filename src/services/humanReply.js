const path = require("path");
const safeWrite = require("./safeWrite");
const customers = require("./customers");

function validateOperationId(operationId) {
  if (typeof operationId !== "string" || !/^[\x20-\x7E]{1,128}$/.test(operationId)) throw new Error("invalid operation id");
}

async function sendHumanReply({ client, userId, channel, message, operationId, providers }) {
  validateOperationId(operationId);
  if (!client?.id || !userId || !message) throw new Error("missing human reply fields");
  return safeWrite.withClientLock(client.id, async () => {
    const ledgerPath = path.join(safeWrite.dataDir(client.id), "human-replies.json");
    const localLedger = safeWrite.safeReadJSON(ledgerPath, {});
    let ledger = localLedger;
    if (typeof process !== "undefined" && process.env.FIRESTORE_SOURCE_OF_TRUTH === "true") {
      try { ledger = require("./storageRepository").readHydratedBusinessData(client.id, "human-replies", localLedger); } catch { ledger = localLedger; }
    }
    const prior = ledger[operationId];
    if (prior) {
      if (prior.channel !== channel || prior.userId !== userId || prior.message !== message) throw new Error("operation id reused with different reply");
      if (prior.status === "unknown") throw new Error("delivery status unknown; reconcile before retry");
      return prior;
    }
    ledger[operationId] = { status: "pending", channel, userId, message, createdAt: new Date().toISOString() };
    safeWrite.rawWriteDataFile(client.id, "human-replies.json", JSON.stringify(ledger, null, 2));
    const mirror = async () => {
      if (typeof process !== "undefined" && process.env.FIRESTORE_MIRROR_WRITES === "true") {
        await require("./storageRepository").mirrorBusinessData(client.id, "human-replies", ledger);
      }
    };
    await mirror();
    try {
      if (channel === "whatsapp") await providers.whatsapp.sendTextMessage(userId, client.whatsappPhoneNumberId, message);
      else if (channel === "telegram") await providers.telegram.sendMessage(client.telegramBotToken, userId, message);
      else if (channel === "discord") await providers.discord.sendReply(client.discordBotToken, userId, message);
      else if (channel === "web") await customers.saveTurn(client.id, userId, "[human]", message);
      else throw new Error("unsupported channel");
      ledger[operationId] = { ...ledger[operationId], status: "sent", sentAt: new Date().toISOString() };
      safeWrite.rawWriteDataFile(client.id, "human-replies.json", JSON.stringify(ledger, null, 2));
      await mirror();
      return ledger[operationId];
    } catch (error) {
      ledger[operationId] = { ...ledger[operationId], status: "unknown", errorAt: new Date().toISOString() };
      safeWrite.rawWriteDataFile(client.id, "human-replies.json", JSON.stringify(ledger, null, 2));
      await mirror();
      throw error;
    }
  });
}

module.exports = { sendHumanReply, validateOperationId };
