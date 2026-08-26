// اختبارات وحدة لـassertValidClientId (حماية path traversal) — بدون لمس القرص
const { test } = require("node:test");
const assert = require("node:assert");
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-only";
const safeWrite = require("../../src/services/safeWrite");

test("معرّفات عميل سليمة بتمرّ", () => {
  for (const ok of ["acme", "client-7f4311", "dukkanatek-2", "Example_Co-1"]) {
    assert.doesNotThrow(() => safeWrite.assertValidClientId(ok));
  }
});

test("معرّفات traversal/غريبة بترفض", () => {
  for (const bad of ["../data", "..", "a/b", "a\\b", "with space", "", null, undefined, 42, ".hidden"]) {
    assert.throws(() => safeWrite.assertValidClientId(bad), undefined, `لازم يرفض: ${bad}`);
  }
});
