const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8188') throw Error('This test requires the local Firestore emulator at 127.0.0.1:8188');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const app = initializeApp({ projectId: 'demo-ai-chat-bot' }, 'reservation-test-' + crypto.randomUUID());
const db = getFirestore(app);
test.after(async () => { await db.terminate(); await deleteApp(app); });
function ledger() {
  const filename = path.resolve(__dirname, '../../src/services/usageLedger.js');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalLoad = Module._load;
  Module._load = (request, parent, isMain) =>
    request === './firebaseAdmin' && parent === loaded ? { db } : originalLoad(request, parent, isMain);
  try {
    loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
    return loaded.exports;
  } finally {
    Module._load = originalLoad;
  }
}
const key = () => 'synthetic-reservation-' + crypto.randomUUID();
test('concurrent reservations cannot exceed the counter quota', async () => {
  const l = ledger(), k = key();
  const rows = await Promise.all(Array.from({ length: 12 }, (_, i) => l.reserve(k, { max: 5, windowMs: 60000, amount: 1, operationId: 'op-' + i })));
  assert.equal(rows.filter(r => r.allowed).length, 5);
  assert.equal((await l.peek(k)).count, 5);
});
test('concurrent duplicate reservation has one successful claim and one debit', async () => {
  const l = ledger(), k = key();
  const rows = await Promise.all(Array.from({ length: 8 }, () => l.reserve(k, { max: 50, windowMs: 60000, amount: 2, operationId: 'same-message' })));
  assert.equal(rows.filter(r => r.allowed).length, 1);
  assert.equal((await l.peek(k)).count, 2);
});
test('refund survives module reload, refunds once, and cannot refund committed work', async () => {
  const l = ledger(), k = key();
  const r = await l.reserve(k, { max: 50, windowMs: 60000, amount: 2, operationId: 'failed-message' });
  assert.equal(r.allowed, true); assert.ok(r.reservationId);
  await ledger().refundReservation(r.reservationId);
  await ledger().refundReservation(r.reservationId);
  assert.equal((await l.peek(k)).count, 0);
  const success = await l.reserve(k, { max: 50, windowMs: 60000, amount: 3, operationId: 'successful-message' });
  await l.commitReservation(success.reservationId);
  await l.refundReservation(success.reservationId);
  assert.equal((await l.peek(k)).count, 3);
});
test('refunding an old window cannot subtract usage from a new window', async () => {
  const l = ledger(), k = key();
  const old = await l.reserve(k, { max: 50, windowMs: 60000, amount: 2, operationId: 'old-message' });
  await db.collection('usageCounters').doc(k).update({ resetAt: Date.now() - 1 });
  await l.checkAndIncrement(k, { max: 50, windowMs: 60000, amount: 1 });
  await l.refundReservation(old.reservationId);
  assert.equal((await l.peek(k)).count, 1);
});
