const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
function load(file, stubs) {
  const context = { module: { exports: {} }, Date, Buffer, URL, __dirname: path.dirname(path.join(root, file)), console: { log() {}, warn() {}, error() {} }, require(name) {
    if (Object.hasOwn(stubs, name)) return stubs[name];
    if (['path', 'crypto'].includes(name)) return require(name);
    throw Error('Unexpected dependency: ' + name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  return context.module.exports;
}
function gate({ deniedAbuse, quotaAllowed = true } = {}) {
  const effects = [];
  const config = { plans: { growth: { monthlyMessageCap: 2000, monthlyVoiceMinutes: 45, allowWidget: true } }, provisioning: { trialDays: 7, trialMessageCap: 50, trialVoiceMinutes: 5 }, abuseGuard: { clientDailyMax: 10, sessionHourlyMax: 5 } };
  const service = load('src/services/messageGate.js', {
    '../config': config, './clientEligibility': require('../../src/services/clientEligibility'),
    './rateLimit': { checkLimit(key) { effects.push('abuse:' + key); return { allowed: !deniedAbuse || !key.startsWith(deniedAbuse), remaining: 5 }; } },
    './usageLedger': { async checkAndIncrement(key) { effects.push('quota:' + key); return { allowed: quotaAllowed }; } },
    './credits': { async consumeOne() { effects.push('credit'); return true; } },
    './usageAnomaly': { checkAndAlert() {} }, './handoff': { async notifyCapReached() {} }
  });
  return { service, effects };
}
const trial = () => ({ id: 'synthetic', status: 'active', plan: 'trial', trialExpiresAt: '2099-01-01T00:00:00Z' });
for (const [prefix, reason] of [['session-msgs:', 'session_cap'], ['client-daily-msgs:', 'daily_cap']]) {
  test('trial top-up cannot bypass ' + reason + ' or debit before denial', async () => {
    const { service, effects } = gate({ deniedAbuse: prefix, quotaAllowed: false });
    const result = await service.meterAndCap(trial(), 'web', 'visitor');
    assert.equal(result.allowed, false);
    assert.equal(result.reason, reason);
    assert.equal(effects.some(x => x.startsWith('quota:') || x === 'credit'), false);
  });
}
test('metering refuses expired subscription without any quota or credit operation', async () => {
  const { service, effects } = gate({ quotaAllowed: false });
  const result = await service.meterAndCap({ id: 'expired', status: 'active', subscriptionExpiresAt: '2000-01-01T00:00:00Z' }, 'whatsapp');
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'subscription_expired');
  assert.deepEqual(effects, []);
});
test('trial with tier uses trial message quota once', async () => {
  const { service, effects } = gate();
  assert.equal((await service.meterAndCap({ ...trial(), tier: 'growth' }, 'telegram')).allowed, true);
  assert.deepEqual(effects.filter(x => x.startsWith('quota:')), ['quota:trial-msgs:synthetic']);
});
test('trial voice cap takes priority over selected paid tier', () => {
  assert.equal(gate().service.voiceCapSeconds({ ...trial(), tier: 'growth' }), 300);
});
test('expired usage counters display zero without a write', async () => {
  const ledger = load('src/services/usageLedger.js', { './firebaseAdmin': { db: { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ count: 99, resetAt: Date.now() - 1 }) }) }) }) } } });
  const result = await ledger.peek('synthetic-counter');
  assert.equal(result.count, 0);
  assert.equal(result.resetAt, null);
});
test('voice reservation rejects invalid durations before quota or credit mutation', async () => {
  for (const duration of [0, -1, NaN, Infinity, '30']) {
    const { service, effects } = gate();
    assert.equal((await service.meterVoice(trial(), duration, { operationId: 'voice-test' })).allowed, false);
    assert.equal(effects.some(x => x.startsWith('quota:') || x === 'credit'), false);
  }
});
