const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");

function load({ lookup, get }) {
  const context = { module: { exports: {} }, URL, require(name) {
    if (name === "dns") return { promises: { lookup } };
    if (name === "net") return require("net");
    if (name === "axios") return { get };
    throw new Error(`Unexpected dependency: ${name}`);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/services/urlGuard.js"), "utf8"), context);
  return context.module.exports;
}

test("safeGet pins a previously checked public DNS address for the request", async () => {
  let requestLookup;
  const guard = load({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    get: async (_url, options) => {
      requestLookup = options.lookup;
      return { status: 200, headers: { "content-type": "text/html" }, data: "ok" };
    },
  });
  await guard.safeGet("https://example.test/");
  assert.equal(typeof requestLookup, "function");
  const answer = await new Promise((resolve, reject) => requestLookup("example.test", { family: 0 }, (err, address, family) => err ? reject(err) : resolve({ address, family })));
  assert.deepEqual(answer, { address: "93.184.216.34", family: 4 });
});
