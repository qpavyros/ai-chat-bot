const { pickClientConfigFields, validateClientConfig } = require("./clientConfigSchema");

// Firestore representation for bot configuration. Credentials stay in the local
// auth/config files until an explicit secret migration is performed.
const SECRET_FIELDS = new Set(["telegramBotToken", "discordBotToken", "telegramWebhookSecret", "whatsappRegistrationPin"]);

function toFirestoreBot(config) {
  const clean = pickClientConfigFields(config);
  for (const field of SECRET_FIELDS) delete clean[field];
  const error = validateClientConfig({ ...clean, id: config?.id, displayName: config?.displayName, escalation: config?.escalation });
  if (error) throw new Error(`invalid bot config: ${error}`);
  return { ...clean, id: config.id, schemaVersion: 1, updatedAt: new Date().toISOString() };
}

function fromFirestoreBot(snapshot) {
  const data = snapshot?.data ? snapshot.data() : snapshot;
  if (!data || typeof data !== "object") return null;
  const { schemaVersion, updatedAt, ...config } = data;
  return config;
}

function createRepository({ db }) {
  if (!db) throw new Error("Firestore database is required");
  const bots = db.collection("bots");
  return {
    async getBotConfig(clientId) {
      const snap = await bots.doc(clientId).get();
      return snap.exists ? fromFirestoreBot(snap) : null;
    },
    async setBotConfig(config) {
      const data = toFirestoreBot(config);
      await bots.doc(config.id).set(data, { merge: false });
      return fromFirestoreBot(data);
    },
    async updateBotConfig(clientId, patch) {
      return db.runTransaction(async (tx) => {
        const ref = bots.doc(clientId);
        const snap = await tx.get(ref);
        const current = snap.exists ? fromFirestoreBot(snap) : null;
        if (!current) throw new Error("bot config not found");
        const next = { ...current, ...patch, id: clientId };
        const data = toFirestoreBot(next);
        tx.set(ref, data, { merge: false });
        return fromFirestoreBot(data);
      });
    },
  };
}

module.exports = { SECRET_FIELDS, toFirestoreBot, fromFirestoreBot, createRepository };
