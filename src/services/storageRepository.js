const { pickClientConfigFields, validateClientConfig } = require("./clientConfigSchema");

// Firestore representation for bot configuration. Credentials stay in the local
// auth/config files until an explicit secret migration is performed.
const SECRET_FIELDS = new Set(["telegramBotToken", "discordBotToken", "telegramWebhookSecret", "whatsappRegistrationPin"]);
const KNOWLEDGE_CHUNK_SIZE = 32 * 1024;
const hydratedBusinessData = new Map();

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

function splitKnowledge(text, size = KNOWLEDGE_CHUNK_SIZE) {
  const value = String(text || "");
  const chunks = [];
  for (let i = 0; i < value.length; i += size) chunks.push(value.slice(i, i + size));
  return chunks;
}

async function mirrorBotConfig(config) {
  if (process.env.FIRESTORE_MIRROR_WRITES !== "true" || !config?.id) return { mirrored: false, reason: "disabled" };
  const { db } = require("./firebaseAdmin");
  const repository = createRepository({ db });
  await repository.setBotConfig(config);
  return { mirrored: true, id: config.id };
}

async function mirrorBusinessData(clientId, name, value) {
  if (process.env.FIRESTORE_MIRROR_WRITES !== "true") return { mirrored: false, reason: "disabled" };
  if (!clientId || !name) throw new Error("business data identity required");
  const { db } = require("./firebaseAdmin");
  const crypto = require("crypto");
  const payload = JSON.stringify(value);
  await db.collection("bots").doc(clientId).collection("businessData").doc(name).set({
    schemaVersion: 1,
    digest: crypto.createHash("sha256").update(payload).digest("hex"),
    value,
    updatedAt: new Date().toISOString(),
  }, { merge: false });
  let clientCache = hydratedBusinessData.get(clientId);
  if (!clientCache) hydratedBusinessData.set(clientId, (clientCache = new Map()));
  clientCache.set(name, value);
  return { mirrored: true, id: clientId, name };
}

async function hydrateBusinessData(clientId, { db } = {}) {
  if (!clientId) throw new Error("client id required");
  if (!db) db = require("./firebaseAdmin").db;
  const snapshot = await db.collection("bots").doc(clientId).collection("businessData").get();
  const values = new Map();
  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    if (Object.prototype.hasOwnProperty.call(data, "value")) values.set(doc.id, data.value);
  }
  hydratedBusinessData.set(clientId, values);
  return { clientId, count: values.size };
}

function readHydratedBusinessData(clientId, name, fallback) {
  if (process.env.FIRESTORE_SOURCE_OF_TRUTH !== "true") return fallback;
  const values = hydratedBusinessData.get(clientId);
  return values && values.has(name) ? values.get(name) : fallback;
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
    async setKnowledge(clientId, knowledge, { version = new Date().toISOString() } = {}) {
      const chunks = splitKnowledge(knowledge);
      const crypto = require("crypto");
      const digest = crypto.createHash("sha256").update(String(knowledge || "")).digest("hex");
      const existing = await bots.doc(clientId).collection("knowledge").orderBy("createdAt", "desc").limit(1).get();
      if (!existing.empty && existing.docs[0].data().digest === digest) {
        const prior = existing.docs[0].data();
        return { version: prior.version, digest, chunkCount: prior.chunkCount };
      }
      const versionRef = bots.doc(clientId).collection("knowledge").doc(version.replace(/[^a-zA-Z0-9_-]/g, "_"));
      await versionRef.set({ version, digest, chunkCount: chunks.length, createdAt: new Date().toISOString() });
      const batch = db.batch();
      chunks.forEach((content, index) => batch.set(versionRef.collection("chunks").doc(String(index).padStart(8, "0")), { index, content, digest }));
      await batch.commit();
      return { version, digest, chunkCount: chunks.length };
    },
    async getKnowledge(clientId, version) {
      const versions = bots.doc(clientId).collection("knowledge");
      const snapshot = version ? await versions.doc(version).collection("chunks").orderBy("index").get() : await versions.orderBy("createdAt", "desc").limit(1).get();
      if (version) return snapshot.docs.map((doc) => doc.data().content).join("");
      if (snapshot.empty) return null;
      const chunks = await snapshot.docs[0].ref.collection("chunks").orderBy("index").get();
      return chunks.docs.map((doc) => doc.data().content).join("");
    },
  };
}

module.exports = { SECRET_FIELDS, KNOWLEDGE_CHUNK_SIZE, splitKnowledge, toFirestoreBot, fromFirestoreBot, createRepository, mirrorBotConfig, mirrorBusinessData, hydrateBusinessData, readHydratedBusinessData };
