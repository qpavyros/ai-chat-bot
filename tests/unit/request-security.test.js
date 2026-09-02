const test = require("node:test");
const assert = require("node:assert/strict");
const security = require("../../src/middleware/requestSecurity");

function response() { return { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; } }; }

test("unsafe cookie-auth request rejects a foreign Origin", () => {
  const req = { method: "POST", headers: { origin: "https://evil.example", host: "app.example", "x-forwarded-proto": "https" } };
  const res = response(); let nextCalled = false;
  security.requireSameOrigin(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test("unsafe same-origin request proceeds and CSP excludes unsafe inline scripts", () => {
  const req = { method: "POST", headers: { origin: "https://app.example", host: "app.example", "x-forwarded-proto": "https" } };
  const res = response(); let nextCalled = false;
  security.requireSameOrigin(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  security.applySecurityHeaders(req, res, () => {});
  assert.match(res.headers["Content-Security-Policy"], /default-src 'self'/);
  assert.doesNotMatch(res.headers["Content-Security-Policy"].match(/script-src[^;]*/)[0], /unsafe-inline/);
});
