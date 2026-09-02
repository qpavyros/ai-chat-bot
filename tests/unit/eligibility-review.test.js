const test = require('node:test');
const assert = require('node:assert/strict');
const { parseExpiry, evaluateClientEligibility } = require('../../src/services/clientEligibility');

test('manual null and blank expiration remain unbounded; malformed explicit expiry does not', () => {
  for (const status of [undefined, 'active']) {
    for (const expiry of [undefined, null, '', '   ']) {
      assert.equal(evaluateClientEligibility({ status, plan: 'manual', subscriptionExpiresAt: expiry }).allowed, true);
    }
    for (const expiry of [0, false, {}, 'not-a-date']) {
      assert.equal(evaluateClientEligibility({ status, plan: 'manual', subscriptionExpiresAt: expiry }).reason, 'invalid_expiry');
    }
  }
});

test('expiry parser rejects normalized invalid timestamps and preserves years', () => {
  for (const value of ['2026-02-30T00:00:00Z', '2026-04-31T00:00:00+03:00', '2026-01-01T24:00:00Z', '2026-01-01T23:60:00Z']) {
    assert.equal(parseExpiry(value), null, value);
  }
  assert.equal(parseExpiry('0099-01-01T00:00:00Z'), Date.parse('0099-01-01T00:00:00Z'));
});

test('eligibility rejects non-object clients and invalid clocks', () => {
  for (const client of ['bot', 1, true, []]) assert.equal(evaluateClientEligibility(client).allowed, false);
  for (const now of [NaN, Infinity, '2026-09-02']) assert.equal(evaluateClientEligibility({ status: 'active', subscriptionExpiresAt: '2026-09-03T00:00:00Z' }, now).allowed, false);
});
