const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');

function load(stubs) {
  const routes = [];
  const express = { Router: () => ({ post: (...args) => routes.push(args), get() {} }) };
  const context = { module: { exports: {} }, Buffer, URL, console: { log() {}, warn() {}, error() {} }, require(name) {
    if (name === 'express') return express;
    if (Object.hasOwn(stubs, name)) return stubs[name];
    if (name === 'path' || name === 'crypto') return require(name);
    throw Error('Unexpected dependency: ' + name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/routes/whatsappWebhook.js'), 'utf8'), context);
  return routes.find(row => row[0] === '/webhook').at(-1);
}

function response() { return { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, sendStatus(code) { this.code = code; } }; }
function request() { return { body: { entry: [{ changes: [{ value: { metadata: { phone_number_id: 'phone' }, messages: [{ id: 'voice-id', from: 'visitor', type: 'voice', voice: { id: 'media-id', duration: 8 } }] } }] }] } }; }

function base(overrides = {}) {
  const calls = [];
  const client = { id: 'synthetic', displayName: 'Synthetic', escalation: {}, voice: { enabled: true } };
  const stubs = {
    '../config': {},
    '../clients/registry': { getClientByWhatsappPhoneNumberId: () => client },
    '../services/whatsapp': { async downloadMedia() { calls.push('download'); return Buffer.from('audio'); }, async sendTextMessage() { calls.push('send'); } },
    '../services/transcribe': { isConfigured: () => true, async transcribeAudioBuffer() { calls.push('transcribe'); return 'text'; } },
    '../services/handoff': { buildServiceIssueReply: () => 'fallback' },
    '../services/messageGate': {
      evaluateStatic: () => ({ allowed: true }),
      preflightAbuse: () => ({ allowed: true, permit: { private: true } }),
      meterVoice: async () => ({ allowed: true, reservation: { id: 'voice-reservation' } }),
      async commitVoiceReservation() { calls.push('commit'); },
      async refundVoiceReservation() { calls.push('refund'); }
    },
    '../services/conversationEngine': { async handleInbound() { calls.push('engine'); return { kind: 'reply', reply: 'ok' }; } },
    ...overrides
  };
  return { calls, handler: load(stubs), stubs };
}

test('failed transcription refunds reserved voice usage before fallback reply', async () => {
  const h = base({ '../services/transcribe': { isConfigured: () => true, async transcribeAudioBuffer() { throw Error('provider failed'); } } });
  const res = response();
  await h.handler(request(), res);
  assert.equal(res.code, 200);
  assert.ok(h.calls.includes('refund'));
  assert.equal(h.calls.includes('commit'), false);
  assert.equal(h.calls.includes('engine'), false);
});

test('successful transcription commits reserved voice usage exactly once', async () => {
  const h = base();
  await h.handler(request(), response());
  assert.equal(h.calls.filter(c => c === 'commit').length, 1);
  assert.equal(h.calls.includes('refund'), false);
  assert.equal(h.calls.includes('engine'), true);
});

test('abuse denial happens before voice reservation, download, transcription, or engine', async () => {
  const h = base({ '../services/messageGate': {
    evaluateStatic: () => ({ allowed: true }), preflightAbuse: () => ({ allowed: false, reason: 'daily_cap' }),
    async meterVoice() { h.calls.push('reserve'); return { allowed: true }; }, async commitVoiceReservation() {}, async refundVoiceReservation() {}
  } });
  await h.handler(request(), response());
  assert.equal(h.calls.includes('reserve'), false);
  assert.equal(h.calls.includes('download'), false);
  assert.equal(h.calls.includes('transcribe'), false);
  assert.equal(h.calls.includes('engine'), false);
});
