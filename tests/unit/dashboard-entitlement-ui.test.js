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

test("billing UI contains founders offer logic and RTL design", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../src/public/billing.html"), "utf8");
  assert.match(html, /dir="rtl"/);
  assert.match(html, /IBM Plex Sans Arabic/);
  assert.match(html, /state\.campaignOffer/);
  assert.match(html, /foundersBanner/);
  assert.match(html, /discountedPrices/);
  assert.match(html, /line-through/);
});

test("admin client detail identifies campaign accounts and payment discount result", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../src/admin-pages/admin-client-detail.html"), "utf8");
  assert.match(html, /cfg\.acquisition\?\.campaignCode === "clinics-launch-2026"/);
  assert.match(html, /res\.discountApplied/);
  assert.match(html, /res\.discountStatus === "unavailable"/);
  assert.match(html, /res\.discountStatus === "lapsed"/);
});
