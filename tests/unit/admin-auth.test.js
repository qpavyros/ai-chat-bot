// اختبارات وحدة لمقارنة كلمة سر الأدمن (timing-safe بعد الهاش — طول أي مدخل ما بيفشّل مبكرًا)
const { test } = require("node:test");
const assert = require("node:assert");
process.env.ADMIN_PASSWORD = "correct-horse-battery";
const adminAuth = require("../../src/services/adminAuth");

test("كلمة السر الصحيحة بتمرّ", () => {
  assert.strictEqual(adminAuth.checkPassword("correct-horse-battery"), true);
});

test("كلمة سر غلط (أي طول) برفض بدون رمي استثناء", () => {
  assert.strictEqual(adminAuth.checkPassword("wrong"), false);
  assert.strictEqual(adminAuth.checkPassword(""), false);
  assert.strictEqual(adminAuth.checkPassword("x".repeat(500)), false);
});

test("مدخلات غير نصية/ناقصة برفض", () => {
  assert.strictEqual(adminAuth.checkPassword(undefined), false);
  assert.strictEqual(adminAuth.checkPassword(null), false);
  assert.strictEqual(adminAuth.checkPassword(123), false);
});
