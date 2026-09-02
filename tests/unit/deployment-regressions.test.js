const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const cheerio = require("cheerio");
const root = path.resolve(__dirname, "../..");
const clientEligibility = require(path.join(root, "src/services/clientEligibility"));
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");

function load(file, stubs, extra = {}) {
  const context = { module: { exports: {} }, Buffer, URL, console: { log() {}, warn() {}, error() {} },
    require(name) { if (Object.hasOwn(stubs, name)) return stubs[name]; if (["path", "crypto"].includes(name)) return require(name); throw Error("Unexpected import: " + name); }, ...extra };
  vm.runInNewContext(source(file), context, { filename: file });
  return context.module.exports;
}
function router() {
  const rows = [], r = {};
  for (const method of ["get", "post", "use"]) r[method] = (...args) => rows.push({ method, args });
  return { rows, express: { Router: () => r } };
}
function response() { return { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, sendStatus(code) { this.code = code; } }; }

test("registry lists each client once despite phone and API-key aliases", () => {
  const base = path.join(root, "synthetic-clients"), files = new Map();
  for (const id of ["a", "b"]) {
    files.set(path.join(base, id, "config.json"), JSON.stringify({ id, status: "active", whatsappPhoneNumberId: id + "-phone" }));
    files.set(path.join(base, id, "auth.json"), JSON.stringify({ publicKey: id + "-public", apiKeys: [{ hash: id + "-hash" }] }));
    files.set(path.join(base, id, "knowledge.md"), "Knowledge");
  }
  const mockFs = { existsSync: (p) => files.has(p), readFileSync: (p) => files.get(p), statSync: () => ({ mtimeMs: 1, size: 1 }),
    readdirSync(p, opts) { return opts ? ["a", "b"].map(name => ({ name, isDirectory: () => true })) : ["config.json", "auth.json", "knowledge.md"]; } };
  const registry = load("src/clients/registry.js", { fs: mockFs, "../services/apiKeys": {}, "../services/clientEligibility": clientEligibility }, { __dirname: base });
  assert.deepEqual(Array.from(registry.getAllClients(), c => c.id), ["a", "b"]);
  assert.equal(registry.getClientByPublicKey("a-public"), registry.getAllClients()[0]);
});

function digest(stubs = {}, extra = {}) {
  return load("src/services/weeklyDigest.js", { "../clients/registry": {}, "./whatsapp": {}, "./usageLedger": {}, "./escalationLog": { readRecent: () => [] }, "./escalationHandled": { getHandledIds: () => [] }, "./safeWrite": { updateClientConfig: async () => {} },
    "../config": { plans: {}, whatsapp: { notifySenderPhoneNumberId: "sender" }, provisioning: { publicBaseUrl: "https://example.test" } }, ...stubs }, extra);
}
test("digest skips inactive/paused bots and continues after a preparation failure", async () => {
  const clients = ["broken", "disabled", "paused", "ok"].map(id => ({ id, plan: "manual", botPaused: id === "paused", escalation: { notifyWhatsapp: id } }));
  const sent = [];
  const service = digest({ "../clients/registry": { getAllClients: () => clients, isServable: c => c.id !== "disabled" },
    "./escalationLog": { readRecent(id) { if (id === "broken") throw Error("unavailable"); return []; } },
    "./whatsapp": { sendTextMessage: async to => sent.push(to) } });
  assert.equal((await service.sendWeeklyDigests()).sent, 1);
  assert.deepEqual(sent, ["ok"]);
});
test("scheduled digest contains failures instead of rejecting the timer callback", async () => {
  let tick;
  const service = digest({ "../clients/registry": { getAllClients() { throw Error("registry failed"); } } },
    { setInterval(fn) { tick = fn; }, Date: class { getDay() { return 0; } getHours() { return 9; } getTime() { return 1000000000; } } });
  service.scheduleWeeklyDigests();
  await assert.doesNotReject(() => tick());
});

test("non-stream chat returns the intended fallback on provider failure", async () => {
  const mock = router(), client = { id: "test" };
  load("src/routes/webChat.js", { express: mock.express, "../config": { streaming: { enabled: false } }, "../services/rateLimit": {}, "../clients/registry": {},
    "../services/handoff": { buildServiceIssueReply(c) { assert.equal(c, client); return "fallback"; } },
    "../services/messageGate": { evaluateStatic: (c) => clientEligibility.evaluateClientEligibility(c) }, "../services/conversationEngine": { handleInbound: async () => { throw Error("provider unavailable"); } },
    "../middleware/auth": { authenticate: () => () => {} } });
  const res = response();
  await mock.rows.find(r => r.args[0] === "/chat/:clientId").args.at(-1)({ client, headers: {}, body: { message: "hello", sessionId: "visitor" } }, res);
  assert.equal(res.code, 500);
  assert.equal(res.body.error.message, "fallback");
});
test("WhatsApp audio and voice media IDs reach transcription and the engine", async () => {
  const mock = router(), downloads = [], inbound = [];
  load("src/routes/whatsappWebhook.js", { express: mock.express, "../config": {}, "../clients/registry": { getClientByWhatsappPhoneNumberId: () => ({ id: "test", escalation: {} }) },
    "../services/whatsapp": { sendTextMessage: async () => {}, downloadMedia: async id => { downloads.push(id); return Buffer.from("audio"); } },
    "../services/transcribe": { isConfigured: () => true, transcribeAudioBuffer: async () => "transcript" }, "../services/handoff": { buildServiceIssueReply: () => "fallback" },
    "../services/messageGate": { evaluateStatic: (c) => clientEligibility.evaluateClientEligibility(c), preflightAbuse: () => ({ allowed: true, permit: {} }), meterVoice: async () => ({ allowed: true }), commitVoiceReservation: async () => {}, refundVoiceReservation: async () => {} },
    "../services/conversationEngine": { handleInbound: async req => { inbound.push(req.userText); return { kind: "reply", reply: "ok" }; } } });
  const handler = mock.rows.find(r => r.method === "post" && r.args[0] === "/webhook").args.at(-1);
  for (const type of ["audio", "voice"]) await handler({ body: { entry: [{ changes: [{ value: { metadata: { phone_number_id: "phone" }, messages: [{ id: type, from: "visitor", type, [type]: { id: type + "-media", duration: 10 } }] } }] }] } }, response());
  assert.deepEqual(downloads, ["audio-media", "voice-media"]);
  assert.equal(inbound.length, 2);
  assert.ok(inbound.every(s => s.includes("transcript")));
});

function dom() {
  const elements = {};
  const create = () => { let html = ""; return { style: {}, handlers: {}, setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [],
    addEventListener(k, fn) { this.handlers[k] = fn; }, set textContent(s) { const $ = cheerio.load("<div></div>"); $("div").text(s); html = $("div").html(); }, get innerHTML() { return html; }, set innerHTML(s) { html = s; } }; };
  return { elements, document: { body: create(), createElement: create, getElementById(id) { return elements[id] || (elements[id] = create()); }, querySelectorAll: () => [], addEventListener() {} } };
}
const payload = '" onmouseover="globalThis.auditMarker=1';
for (const file of ["src/public/bot-manage.html", "src/public/billing.html", "src/public/dashboard.html", "src/admin-pages/admin-client-detail.html", "src/admin-pages/admin-dashboard.html", "src/admin-pages/admin-analytics.html", "src/admin-pages/admin-escalations.html", "src/admin-pages/admin-legacy.html"]) {
  test("HTML helper preserves quoted text without attributes: " + file, () => {
    const fn = source(file).match(/function (esc|escapeHtml)\(s\)\s*\{[\s\S]*?\n\s*\}/);
    const ctx = { document: dom().document };
    vm.runInNewContext(fn[0], ctx);
    const $ = cheerio.load('<input value="' + ctx[fn[1]](payload) + '">');
    assert.equal($("input").attr("value"), payload);
    assert.equal($("[onmouseover]").length, 0);
  });
}
function inline(file) { return cheerio.load(source(file))("script:not([src])").first().text(); }
test("actual conversation rendering cannot create an event attribute from a customer message", async () => {
  const mock = dom();
  const ctx = { document: mock.document, location: { pathname: "/dashboard/bots/a" }, firebase: { initializeApp() {} },
    fetch: url => url.endsWith("/api/conversations") ? Promise.resolve({ ok: true, json: async () => ({ conversations: [{ userId: payload, lastMessage: payload }] }) }) : new Promise(() => {}) };
  vm.runInNewContext(inline("src/public/bot-manage.html").replace(/\}\)\(\);\s*$/, "globalThis.loadAudit=loadConversations;})();"), ctx);
  ctx.loadAudit(); await new Promise(resolve => setImmediate(resolve));
  const $ = cheerio.load(mock.elements["conversations-box"].innerHTML);
  assert.equal($("[onmouseover]").length, 0);
  assert.equal($("td[title]").attr("title"), payload);
});
test("billing bot selection updates browser history and requests the newly selected bot", () => {
  const mock = dom(), urls = [], historyUrls = [];
  const ctx = { document: mock.document, URLSearchParams, location: { search: "" }, window: { location: {}, history: { pushState(a, b, url) { historyUrls.push(url); } } }, fetch: url => { urls.push(url); return new Promise(() => {}); } };
  vm.runInNewContext(inline("src/public/billing.html").replace(/\}\)\(\);\s*$/, 'globalThis.renderAudit=function(){bots=[{clientId:"a"},{clientId:"b"}];state={paymentHistory:[]};render();};})();'), ctx);
  ctx.renderAudit(); mock.elements["bot-select"].handlers.change.call({ value: "b" });
  assert.deepEqual(historyUrls, ["/dashboard/billing?clientId=b"]);
  assert.equal(urls.at(-1), "/dashboard/bots/b/api/summary");
});
