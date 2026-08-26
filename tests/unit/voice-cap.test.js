// اختبارات سقف دقائق الصوت لكل نوع عميل
const { test } = require("node:test");
const assert = require("node:assert");
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-only";
const messageGate = require("../../src/services/messageGate");

test("باقات مدفوعة إلها سقف دقائق محدد", () => {
  const starter = messageGate.voiceCapSeconds({ tier: "starter" });
  const growth = messageGate.voiceCapSeconds({ tier: "growth" });
  const pro = messageGate.voiceCapSeconds({ tier: "pro" });
  assert.strictEqual(starter, 15 * 60);
  assert.strictEqual(growth, 45 * 60);
  assert.strictEqual(pro, 120 * 60);
});

test("التجربة عندها سقف صغير", () => {
  // config.provisioning.trialVoiceMinutes افتراضي 5 (من env أو default)
  const cap = messageGate.voiceCapSeconds({ plan: "trial" });
  assert.ok(cap > 0 && cap <= 10 * 60, `سقف التجربة مفروض صغير، طلع ${cap}`);
});

test("عميل يدوي بدون tier = بلا سقف صوتي (null)", () => {
  assert.strictEqual(messageGate.voiceCapSeconds({}), null);
});
