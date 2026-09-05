const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const clone = value => JSON.parse(JSON.stringify(value));
function harness() {
  const routes = [], clear = [], writes = [];
  const router = {};
  for (const method of ['get', 'post', 'put', 'delete', 'use']) router[method] = (...args) => routes.push({ method, args });
  const upload = () => ({ single: () => () => {} }); upload.memoryStorage = () => ({});
  const stale = { id: 'synthetic', displayName: 'Old', status: 'active', plan: 'manual', topUpCreditsRemaining: 1, escalation: { contactMethod: 'phone', phone: 'synthetic' }, channels: { whatsapp: { enabled: true, custom: 'retain' }, web: { enabled: true }, telegram: { enabled: false }, discord: { enabled: false } }, whatsappPhoneNumberId: 'old-phone' };
  let stored = { ...clone(stale), topUpCreditsRemaining: 19, newConcurrentField: 'keep' };
  const safeWrite = {
    assertValidClientId() {}, clientDir: () => '/synthetic', dataDir: () => '/synthetic-data',
    safeReadJSON: () => clone(stored),
    async safeWriteJSON(id, file, cfg) { writes.push(id); stored = clone(cfg); },
    async updateClientConfig(id, updater, options = {}) { const next = await updater(clone(stored)); if (options.validate) assert.equal(options.validate(next), null); writes.push(id); stored = clone(next); return clone(stored); },
    async withClientLock(id, fn) { return fn(); },
    rawWriteClientFile(id, file, text) { writes.push(id); stored = JSON.parse(text); }
  };
  const stubs = {
    express: { Router: () => router }, multer: upload, fs: {},
    '../config': { plans: {}, provisioning: { publicBaseUrl: 'http://example.test' } },
    '../services/safeWrite': safeWrite,
    '../services/clientConfigSchema': require('../../src/services/clientConfigSchema'),
    '../middleware/asyncHandler': require('../../src/middleware/asyncHandler'),
    './userAuth': { requireUserAuth() {} },
    '../services/replyCache': { clear: id => clear.push(id) },
    '../services/provisioning': {}, '../services/userAccounts': {}, '../clients/registry': {},
    '../services/ingest': {}, '../services/urlGuard': {}, '../services/usageLedger': {}, '../services/auditLog': { record() {} },
    '../services/escalationLog': {}, '../services/escalationHandled': {}, '../services/handoff': {}, '../services/orders': {}, '../services/customers': {},
    '../services/safe-id': { safeId: x => x }, '../services/discordGateway': { syncAll() {}, sendReply: async () => {} },
    '../services/humanReply': { sendHumanReply: async () => ({ status: 'sent' }) },
    '../services/telegram': { sendMessage: async () => {} }, '../services/whatsapp': { sendTextMessage: async () => {} }
  };
  const context = { module: { exports: {} }, __dirname: path.join(root, 'src/routes'), Buffer, URL, console: { log() {}, error() {}, warn() {} }, require(name) { if (Object.hasOwn(stubs, name)) return stubs[name]; if (['path', 'crypto'].includes(name)) return require(name); throw Error('Unexpected dependency: ' + name); } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/routes/botManagement.js'), 'utf8'), context);
  return { stale, clear, writes, get stored() { return stored; }, async invoke(suffix, body) {
    const row = routes.find(r => r.method === 'post' && r.args[0] === '/dashboard/bots/:clientId/api/' + suffix);
    const res = { status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
    let error; await row.args.at(-1)({ uid: 'synthetic-owner', clientId: 'synthetic', clientConfig: clone(stale), body }, res, e => { error = e; });
    assert.ifError(error); assert.equal(res.body?.ok, true); return res;
  } };
}
for (const [route, body] of [
  ['settings', { voiceEnabled: false }],
  ['integrations', { telegramBotToken: '' }],
  ['info', { displayName: 'New', escalationContactMethod: 'phone' }],
  ['channels', { webEnabled: false }],
  ['disconnect-whatsapp', {}]
]) {
  test(route + ' preserves configuration changes made after ownership snapshot', async () => {
    const h = harness(); await h.invoke(route, body);
    assert.equal(h.stored.topUpCreditsRemaining, 19);
    assert.equal(h.stored.newConcurrentField, 'keep');
  });
}
test('editing web channel preserves other channel flags and nested options', async () => {
  const h = harness(); await h.invoke('channels', { webEnabled: false });
  assert.equal(h.stored.channels.web.enabled, false);
  assert.deepEqual(h.stored.channels.telegram, { enabled: false });
  assert.deepEqual(h.stored.channels.discord, { enabled: false });
  assert.equal(h.stored.channels.whatsapp.custom, 'retain');
});
for (const [route, body] of [['info', { displayName: 'New', tone: 'formal', escalationContactMethod: 'phone' }], ['settings', { salesMode: true }]]) {
  test(route + ' invalidates reply cache after successful instruction change', async () => {
    const h = harness(); await h.invoke(route, body);
    assert.deepEqual(h.clear, ['synthetic']);
  });
}
