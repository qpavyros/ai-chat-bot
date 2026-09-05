const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("dashboard renders the shared account entitlement block", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../src/public/dashboard.html"), "utf8");
  assert.match(html, /استحقاق الحساب المشترك/);
  assert.match(html, /remainingMessages/);
  assert.match(html, /remainingCredits/);
});
