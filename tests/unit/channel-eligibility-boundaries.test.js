// Independent reviewer checks: exercise real handlers without live providers or credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
function load(file, stubs) {
  const context = { module: { exports: {} }, Buffer, URL, console: { log() {}, warn() {}, error() {} }, require(name) {
    if (Object.hasOwn(stubs, name)) return stubs[name];
    if (name === 'crypto' || name === 'path') return require(name);
    throw new Error('Unexpected dependency: ' + name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  return context.module.exports;
}
function router() { const handlers = []; const instance = {}; for (const method of ['get', 'post', 'use']) instance[method] = (...args) => handlers.push({ method, args }); return { handlers, express: { Router: () => instance } }; }
function response() { return { status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; }, sendStatus(n) { this.code = n; } }; }

for (const reason of ['client_not_active', 'trial_expired', 'subscription_expired']) {
  for (const type of ['text', 'audio', 'voice']) {
    test(`WhatsApp ${type}: ${reason} causes no media, metering, engine or outbound call`, async () => {
      const r = router(), calls = [];
      const client = { id: 'synthetic', displayName: 'Synthetic', escalation: {} };
      load('src/routes/whatsappWebhook.js', { express: r.express, '../config': {},
        '../clients/registry': { getClientByWhatsappPhoneNumberId: () => client },
        '../services/whatsapp': { async sendTextMessage() { calls.push('send'); }, async downloadMedia() { calls.push('download'); return Buffer.from('synthetic'); } },
        '../services/transcribe': { isConfigured: () => true, async transcribeAudioBuffer() { calls.push('transcribe'); return 'hello'; } },
        '../services/handoff': { buildServiceIssueReply: () => 'service unavailable' },
        '../services/messageGate': { evaluateStatic: () => ({ allowed: false, reason }), async meterVoice() { calls.push('meter'); return { allowed: true }; } },
        '../services/conversationEngine': { async handleInbound() { calls.push('engine'); return { kind: 'reply', reply: 'hello' }; } }
      });
      const message = { id: 'synthetic-message', from: 'synthetic-visitor', type, [type]: type === 'text' ? { body: 'hello' } : { id: 'synthetic-media', duration: 5 } };
      const req = { body: { entry: [{ changes: [{ value: { metadata: { phone_number_id: 'synthetic-phone' }, messages: [message] } }] }] } };
      const res = response();
      await r.handlers.find(h => h.method === 'post' && h.args[0] === '/webhook').args.at(-1)(req, res);
      assert.equal(res.code, 200, 'acknowledge delivery to avoid webhook retries');
      assert.deepEqual(calls, [], 'eligibility must precede every costly or outbound operation');
    });
  }
  test(`web handler rejects ${reason} instead of falling through an unknown switch case`, async () => {
    const r = router(); let engineCalls = 0;
    load('src/routes/webChat.js', { express: r.express, '../config': {}, '../services/rateLimit': {},
      '../clients/registry': {}, '../middleware/auth': { authenticate: () => () => {} },
      '../services/handoff': { buildServiceIssueReply: () => 'fallback' },
      '../services/messageGate': { evaluateStatic: () => ({ allowed: false, reason }) },
      '../services/conversationEngine': { async handleInbound() { engineCalls++; return { kind: 'reply', reply: 'hello' }; } }
    });
    const res = response();
    await r.handlers.find(h => h.method === 'post' && h.args[0] === '/chat/:clientId').args.at(-1)({ client: { id: 'synthetic', escalation: {} }, headers: {}, body: { message: 'hello', sessionId: 'synthetic-session' } }, res);
    assert.equal(engineCalls, 0);
    assert.equal(res.code, 403);
    assert.equal(res.body.error.code, reason);
  });
}

for (const channel of ['web', 'whatsapp', 'telegram', 'discord']) {
  test('engine rejects denied ' + channel + ' before every side effect', async () => {
    const calls = [];
    const record = name => () => { calls.push(name); return false; };
    const engine = load('src/services/conversationEngine.js', {
      './deepseek': { getReply: record('llm') },
      './customers': { getProfile: () => { calls.push('profile'); return { history: [], facts: [] }; }, saveTurn: record('save') },
      './handoff': { isConversationPaused: record('handoff'), checkKeywordEscalation: record('keyword') },
      './replyCache': { get: record('cache') },
      './messageGate': { evaluateStatic: () => ({ allowed: false, reason: 'subscription_expired' }), meterAndCap: record('meter') },
      './stats': { increment: record('stats') },
      './businessHours': { isWithinBusinessHours: () => false }
    });
    let result, thrown;
    try { result = await engine.handleInbound({ client: { id: 'synthetic' }, channel, endUserId: 'synthetic-user', userText: 'hello' }); } catch (e) { thrown = e; }
    assert.deepEqual(calls, [], 'denied engine entry must perform no work');
    assert.ifError(thrown);
    assert.equal(result.kind, 'blocked');
    assert.equal(result.reason, 'subscription_expired');
  });
}
