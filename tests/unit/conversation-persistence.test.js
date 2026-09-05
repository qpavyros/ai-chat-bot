const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("takeover state survives loading a fresh service instance", () => {
  const files = new Map();
  const safeWrite = {
    dataDir: () => "/data/bot",
    safeReadJSON: (file, fallback) => files.has(file) ? JSON.parse(files.get(file)) : fallback,
    rawWriteDataFile: (_id, file, content) => files.set(path.join("/data/bot", file), content),
  };
  const source = fs.readFileSync(path.join(__dirname, "../../src/services/conversation.js"), "utf8");
  const load = () => { const context = { module: { exports: {} }, require(name) { if (name === "path") return path; if (name === "./safeWrite") return safeWrite; throw new Error(name); }, Date, Number, Object, JSON }; vm.runInNewContext(source, context); return context.module.exports; };
  const first = load();
  first.pauseForHandoff("bot", "visitor", 60_000);
  assert.equal(load().isPaused("bot", "visitor"), true);
});
