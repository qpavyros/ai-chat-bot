// اختبارات وحدة لطبقة تحقق config — node:test بدون أي تبعية خارجية
const { test } = require("node:test");
const assert = require("node:assert");
const { validateClientConfig, pickClientConfigFields } = require("../../src/services/clientConfigSchema");

function baseValidConfig() {
  return {
    id: "acme",
    displayName: "Acme",
    escalation: { phone: "+9613123456", contactMethod: "اتصل بنا", notifyWhatsapp: "" },
  };
}

test("validateClientConfig يقبل config سليم", () => {
  assert.strictEqual(validateClientConfig(baseValidConfig()), null);
});

test("validateClientConfig يرفض ناقص الحقول الحرجة", () => {
  assert.ok(validateClientConfig(null));
  assert.ok(validateClientConfig({ id: "", displayName: "x", escalation: { contactMethod: "y" } }));
  assert.ok(validateClientConfig({ id: "x", displayName: "", escalation: { contactMethod: "y" } }));
  assert.ok(validateClientConfig({ id: "x", displayName: "y", escalation: null }));
});

test("pickClientConfigFields ينشال الحقول غير المعروفة", () => {
  const out = pickClientConfigFields({
    displayName: "شركة",
    evilField: "http://attacker",
    anotherOne: { nested: true },
  });
  assert.deepStrictEqual(out, { displayName: "شركة" });
});

test("pickClientConfigFields ما بيقبل id من الجسم إطلاقًا", () => {
  const out = pickClientConfigFields({ id: "hijacked", displayName: "شركة" });
  assert.strictEqual(out.id, undefined);
});

test("pickClientConfigFields بينسخ الكائنات بنسخة عميقة", () => {
  const body = { appointments: { enabled: true, workingHours: { start: "09:00", end: "17:00" } } };
  const out = pickClientConfigFields(body);
  assert.deepStrictEqual(out, body);
  assert.notStrictEqual(out.appointments, body.appointments);
});

test("pickClientConfigFields بيقصر escalation على مفاتيحه الثلاثة", () => {
  const out = pickClientConfigFields({
    escalation: { phone: "+96131111", contactMethod: "هاتف", notifyWhatsapp: "+96132222", injected: "x" },
  });
  assert.deepStrictEqual(out.escalation, { phone: "+96131111", contactMethod: "هاتف", notifyWhatsapp: "+96132222" });
});

test("pickClientConfigFields يتسامح مع جسم فارغ/غير كائن", () => {
  assert.deepStrictEqual(pickClientConfigFields(undefined), {});
  assert.deepStrictEqual(pickClientConfigFields(null), {});
  assert.deepStrictEqual(pickClientConfigFields("نص"), {});
});
