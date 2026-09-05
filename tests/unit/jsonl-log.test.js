// اختبارات وحدة لسجل JSONL بسقف تلقائي — بتشتغل بمجلد مؤقت وبتنضيف بعد حالها
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { appendCapped, readRecent, readPage } = require("../../src/services/jsonlLog");

function tempLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-test-")), "log.jsonl");
}

test("appendCapped بيحفظ وreadRecent بيرجع الأحدث أولاً", () => {
  const logPath = tempLog();
  try {
    appendCapped(logPath, { i: 1 });
    appendCapped(logPath, { i: 2 });
    appendCapped(logPath, { i: 3 });
    const entries = readRecent(logPath);
    assert.deepStrictEqual(entries.map((e) => e.i), [3, 2, 1]);
  } finally {
    fs.rmSync(path.dirname(logPath), { recursive: true, force: true });
  }
});

test("السقف بيمنع النمو اللانهائي ويحافظ على الأحدث", () => {
  const logPath = tempLog();
  try {
    for (let i = 1; i <= 300; i++) {
      appendCapped(logPath, { i, pad: "x".repeat(20) }, { maxBytes: 2048, keepLast: 100 });
    }
    const size = fs.statSync(logPath).size;
    assert.ok(size < 4096, `الحجم المفروض يكون مقيد، طلع ${size}`);
    const newest = readRecent(logPath, 1)[0];
    assert.strictEqual(newest.i, 300, "أحدث سجل لازم يضل موجود");
  } finally {
    fs.rmSync(path.dirname(logPath), { recursive: true, force: true });
  }
});

test("السجلات القديمة تُؤرشف ويمكن تصفحها بصفحات", () => {
  const logPath = tempLog();
  try {
    for (let i = 1; i <= 8; i++) appendCapped(logPath, { i, pad: "x".repeat(20) }, { maxBytes: 120, keepLast: 3 });
    const archivePath = `${logPath}.archive.jsonl`;
    assert.ok(fs.existsSync(archivePath), "لازم ينحفظ أرشيف بدل حذف السجلات القديمة");
    assert.deepStrictEqual(readPage(logPath, { limit: 3 }).entries.map((e) => e.i), [8, 7, 6]);
    const older = readPage(logPath, { limit: 3, cursor: "3" });
    assert.deepStrictEqual(older.entries.map((e) => e.i), [5, 4, 3]);
    assert.strictEqual(older.nextCursor, "6");
  } finally {
    fs.rmSync(path.dirname(logPath), { recursive: true, force: true });
  }
});

test("readRecent على ملف غير موجود/سطر تالف بيرجع آمن", () => {
  const logPath = tempLog();
  try {
    assert.deepStrictEqual(readRecent(logPath), []);
    fs.writeFileSync(logPath, "{broken-json\n{\"ok\":true}\n", "utf8");
    const entries = readRecent(logPath);
    assert.deepStrictEqual(entries, [{ ok: true }]);
  } finally {
    fs.rmSync(path.dirname(logPath), { recursive: true, force: true });
  }
});
