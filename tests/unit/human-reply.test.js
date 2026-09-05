const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("human replies are idempotent and unknown provider delivery cannot auto-retry", async () => {
  const files = new Map(); let sends = 0;
  const safeWrite = { dataDir: () => "/data", safeReadJSON: (p, fallback) => files.has(p) ? JSON.parse(files.get(p)) : fallback, rawWriteDataFile: (_id, f, body) => files.set(path.join("/data", f), body), withClientLock: async (_id, fn) => fn() };
  const source = fs.readFileSync(path.join(__dirname, "../../src/services/humanReply.js"), "utf8");
  const context = { module: { exports: {} }, require(name) { if (name === "path") return path; if (name === "./safeWrite") return safeWrite; if (name === "./customers") return { saveTurn: async () => {}, getProfile: () => ({ lastMessageAt: new Date().toISOString() }) }; throw new Error(name); }, Date, JSON, String, RegExp, Object };
  vm.runInNewContext(source, context);
  const service = context.module.exports;
  const client = { id: "bot", whatsappPhoneNumberId: "phone" };
  const providers = { whatsapp: { sendTextMessage: async () => { sends++; } } };
  assert.equal((await service.sendHumanReply({ client, userId: "u", channel: "whatsapp", message: "hi", operationId: "op", providers })).status, "sent");
  assert.equal((await service.sendHumanReply({ client, userId: "u", channel: "whatsapp", message: "hi", operationId: "op", providers })).status, "sent");
  assert.equal(sends, 1);
  const failing = { whatsapp: { sendTextMessage: async () => { throw new Error("provider timeout"); } } };
  await assert.rejects(() => service.sendHumanReply({ client, userId: "u2", channel: "whatsapp", message: "hi", operationId: "uncertain", providers: failing }));
  await assert.rejects(() => service.sendHumanReply({ client, userId: "u2", channel: "whatsapp", message: "hi", operationId: "uncertain", providers: failing }), /unknown/);
  const expired = { ...client, id: "expired" };
  context.require = (name) => name === "./customers" ? { saveTurn: async () => {}, getProfile: () => ({ lastMessageAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }) } : (name === "path" ? path : (name === "./safeWrite" ? safeWrite : (() => { throw new Error(name); })()));
  const expiredServiceContext = { module: { exports: {} }, require: context.require, Date, JSON, String, RegExp, Object };
  vm.runInNewContext(source, expiredServiceContext);
  await assert.rejects(() => expiredServiceContext.module.exports.sendHumanReply({ client: expired, userId: "u3", channel: "whatsapp", message: "hi", operationId: "expired", providers }), (error) => error.code === "whatsapp_window_expired");
});
