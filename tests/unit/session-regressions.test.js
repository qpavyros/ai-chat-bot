const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "../..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");

function load(file, stubs = {}, extra = {}) {
  const context = {
    module: { exports: {} },
    __dirname: path.dirname(path.join(root, file)),
    Buffer,
    URL,
    process: extra.process || process,
    Date: extra.Date || Date,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (["path", "crypto"].includes(name)) return require(name);
      throw Error("Unexpected import: " + name);
    },
    ...extra,
  };
  vm.runInNewContext(source(file), context, { filename: file });
  return context.module.exports;
}

function response() {
  return {
    code: undefined,
    body: undefined,
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    sendStatus(code) {
      this.code = code;
      return this;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. parseCookies tests (src/middleware/sessionCookies.js)
// ---------------------------------------------------------------------------

const { parseCookies } = require("../../src/middleware/sessionCookies");

test("parseCookies extracts valid user_session when unrelated cookie has malformed percent-encoding", () => {
  const req = {
    headers: {
      cookie: "unrelated=%E0%A4%A; user_session=valid_user_session_abc123",
    },
  };

  let cookies;
  assert.doesNotThrow(() => {
    cookies = parseCookies(req);
  }, "parseCookies must tolerate malformed percent-encoding in unrelated cookies without throwing");

  assert.equal(cookies.user_session, "valid_user_session_abc123");
});

test("parseCookies survives multiple malformed cookies and decodes remaining valid cookies", () => {
  const req = {
    headers: {
      cookie: "broken1=%FF; a=1; broken2=%Z; user_session=session_token_xyz; b=hello%20world",
    },
  };

  let cookies;
  assert.doesNotThrow(() => {
    cookies = parseCookies(req);
  });

  assert.equal(cookies.a, "1");
  assert.equal(cookies.user_session, "session_token_xyz");
  assert.equal(cookies.b, "hello world");
});

test("parseCookies rejects malformed user_session and does not accept it as valid decoded value", () => {
  const req = {
    headers: {
      cookie: "user_session=%E0%A4%A; valid_cookie=123",
    },
  };

  let cookies;
  assert.doesNotThrow(() => {
    cookies = parseCookies(req);
  });

  // A malformed user_session must not be accepted as a valid decoded value
  assert.notEqual(cookies.user_session, "%E0%A4%A");
  assert.equal(cookies.user_session, undefined);
  assert.equal(cookies.valid_cookie, "123");
});

test("parseCookies handles standard valid cookies and empty headers", () => {
  assert.deepEqual(parseCookies({ headers: {} }), {});
  assert.deepEqual(parseCookies({ headers: { cookie: "" } }), {});

  const normal = parseCookies({
    headers: { cookie: "user_session=token123; pref=arabic" },
  });
  assert.equal(normal.user_session, "token123");
  assert.equal(normal.pref, "arabic");
});

// ---------------------------------------------------------------------------
// 2. requireUserAuth tests (src/routes/userAuth.js)
// ---------------------------------------------------------------------------

function loadUserAuth(stubs = {}) {
  return load("src/routes/userAuth.js", {
    path: { join: (...args) => args.join("/") },
    express: { Router: () => ({ get() {}, post() {} }) },
    "../config": {
      userAccounts: { sessionTtlHours: 336 },
      firebase: {
        webApiKey: "k",
        authDomain: "d",
        projectId: "p",
        storageBucket: "b",
        messagingSenderId: "m",
        appId: "a",
      },
    },
    "../middleware/sessionCookies": {
      parseCookies(req) {
        const header = req.headers?.cookie;
        const cookies = {};
        if (!header) return cookies;
        header.split(";").forEach((pair) => {
          const idx = pair.indexOf("=");
          if (idx === -1) return;
          try {
            cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
          } catch {}
        });
        return cookies;
      },
      setSessionCookie() {},
      clearSessionCookie() {},
    },
    "../middleware/asyncHandler": require("../../src/middleware/asyncHandler"),
    "../services/rateLimit": { checkLimit: () => ({ allowed: true }) },
    "../services/userAccounts": { verifySessionCookie: async () => null },
    ...stubs,
  });
}

test("requireUserAuth returns 401 when session cookie is missing", async () => {
  const { requireUserAuth } = loadUserAuth({
    "../services/userAccounts": { verifySessionCookie: async () => null },
  });

  const req = { headers: {} };
  const res = response();
  let nextCalled = false;

  await requireUserAuth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(res.code, 401);
  assert.equal(res.body?.error?.code, "not_authenticated");
  assert.equal(nextCalled, false);
});

test("requireUserAuth returns 401 when session verification returns null or false", async () => {
  const { requireUserAuth } = loadUserAuth({
    "../services/userAccounts": { verifySessionCookie: async () => null },
  });

  const req = { headers: { cookie: "user_session=invalid-token" } };
  const res = response();
  let nextCalled = false;

  await requireUserAuth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(res.code, 401);
  assert.equal(res.body?.error?.code, "not_authenticated");
  assert.equal(nextCalled, false);
});

test("requireUserAuth passes unexpected async verification failures to next(err)", async () => {
  const asyncError = new Error("Firebase auth connection timed out");
  const { requireUserAuth } = loadUserAuth({
    "../services/userAccounts": {
      verifySessionCookie: async () => {
        throw asyncError;
      },
    },
  });

  const req = { headers: { cookie: "user_session=some-token" } };
  const res = response();
  let passedErr = null;

  try {
    await requireUserAuth(req, res, (err) => {
      passedErr = err;
    });
  } catch (err) {
    // Current unpatched code throws an unhandled rejection instead of next(err)
  }

  assert.equal(passedErr, asyncError);
  assert.equal(res.code, undefined);
});

test("requireUserAuth attaches uid to req and calls next() on valid session", async () => {
  const { requireUserAuth } = loadUserAuth({
    "../services/userAccounts": { verifySessionCookie: async () => "verified-user-123" },
  });

  const req = { headers: { cookie: "user_session=valid-token" } };
  const res = response();
  let nextCalled = false;

  await requireUserAuth(req, res, (err) => {
    assert.ifError(err);
    nextCalled = true;
  });

  assert.equal(req.uid, "verified-user-123");
  assert.equal(nextCalled, true);
  assert.equal(res.code, undefined);
});

// ---------------------------------------------------------------------------
// 3. Session TTL configuration tests (src/config.js)
// ---------------------------------------------------------------------------

function loadConfig(envOverrides = {}) {
  const baseEnv = {
    PORT: "3000",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    DEEPSEEK_MODEL: "deepseek-chat",
    META_APP_ID: "test-meta-app-id",
    META_APP_SECRET: "test-meta-app-secret",
    META_EMBEDDED_SIGNUP_CONFIG_ID: "test-config-id",
    WHATSAPP_TOKEN: "test-wa-token",
    WHATSAPP_PHONE_NUMBER_ID: "test-wa-phone",
    WHATSAPP_VERIFY_TOKEN: "test-wa-verify",
    NOTIFY_WHATSAPP_PHONE_NUMBER_ID: "test-wa-notify",
    WEB_WIDGET_KEY: "test-widget-key",
    ALLOW_LEGACY_WIDGET_KEY: "true",
    HANDOFF_PAUSE_HOURS: "4",
    ADMIN_PASSWORD: "test-admin-password",
    FIREBASE_PROJECT_ID: "test-fb-project",
    GOOGLE_APPLICATION_CREDENTIALS: "test-credentials.json",
    FIREBASE_WEB_API_KEY: "test-web-key",
    FIREBASE_AUTH_DOMAIN: "test-auth-domain",
    FIREBASE_STORAGE_BUCKET: "test-storage-bucket",
    FIREBASE_MESSAGING_SENDER_ID: "test-sender-id",
    FIREBASE_APP_ID: "test-app-id",
    ...envOverrides,
  };

  for (const k of Object.keys(envOverrides)) {
    if (envOverrides[k] === undefined) {
      delete baseEnv[k];
    }
  }

  const stubs = {
    dotenv: { config() {} },
  };

  return load("src/config.js", stubs, {
    process: { env: baseEnv, cwd: () => root },
  });
}

test("config: session TTL defaults to 336 hours when USER_SESSION_TTL_HOURS is unset", () => {
  const config = loadConfig({ USER_SESSION_TTL_HOURS: undefined });
  assert.equal(config.userAccounts.sessionTtlHours, 336);
});

test("config: session TTL respects valid values within range [5 minutes to 336 hours]", () => {
  // 5 minutes (5 / 60 hours = ~0.08333)
  const minConfig = loadConfig({ USER_SESSION_TTL_HOURS: String(5 / 60) });
  assert.ok(Math.abs(minConfig.userAccounts.sessionTtlHours - 5 / 60) < 1e-6);

  // 24 hours
  const dayConfig = loadConfig({ USER_SESSION_TTL_HOURS: "24" });
  assert.equal(dayConfig.userAccounts.sessionTtlHours, 24);

  // 168 hours (1 week)
  const weekConfig = loadConfig({ USER_SESSION_TTL_HOURS: "168" });
  assert.equal(weekConfig.userAccounts.sessionTtlHours, 168);

  // 336 hours (max 14 days)
  const maxConfig = loadConfig({ USER_SESSION_TTL_HOURS: "336" });
  assert.equal(maxConfig.userAccounts.sessionTtlHours, 336);
});

test("config: session TTL rejects non-numeric NaN values with validation error", () => {
  assert.throws(
    () => loadConfig({ USER_SESSION_TTL_HOURS: "invalid-number" }),
    /USER_SESSION_TTL_HOURS|session.*ttl/i
  );
  assert.throws(
    () => loadConfig({ USER_SESSION_TTL_HOURS: "NaN" }),
    /USER_SESSION_TTL_HOURS|session.*ttl/i
  );
});

test("config: session TTL rejects Infinity and -Infinity with validation error", () => {
  assert.throws(
    () => loadConfig({ USER_SESSION_TTL_HOURS: "Infinity" }),
    /USER_SESSION_TTL_HOURS|session.*ttl/i
  );
  assert.throws(
    () => loadConfig({ USER_SESSION_TTL_HOURS: "-Infinity" }),
    /USER_SESSION_TTL_HOURS|session.*ttl/i
  );
});

test("config: session TTL rejects zero and negative values with validation error", () => {
  assert.throws(
    () => loadConfig({ USER_SESSION_TTL_HOURS: "0" }),
    /USER_SESSION_TTL_HOURS|session.*ttl/i
  );
  assert.throws(
    () => loadConfig({ USER_SESSION_TTL_HOURS: "-1" }),
    /USER_SESSION_TTL_HOURS|session.*ttl/i
  );
  assert.throws(
    () => loadConfig({ USER_SESSION_TTL_HOURS: "-24" }),
    /USER_SESSION_TTL_HOURS|session.*ttl/i
  );
});

test("config: session TTL rejects values out of range (< 5 minutes or > 336 hours)", () => {
  // Below 5 minutes (0.05 hours = 3 minutes)
  assert.throws(
    () => loadConfig({ USER_SESSION_TTL_HOURS: "0.05" }),
    /USER_SESSION_TTL_HOURS|session.*ttl/i
  );
  // Above 336 hours
  assert.throws(
    () => loadConfig({ USER_SESSION_TTL_HOURS: "337" }),
    /USER_SESSION_TTL_HOURS|session.*ttl/i
  );
  // Legacy 720 hours default is out-of-range
  assert.throws(
    () => loadConfig({ USER_SESSION_TTL_HOURS: "720" }),
    /USER_SESSION_TTL_HOURS|session.*ttl/i
  );
});
