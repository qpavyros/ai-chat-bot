const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const PROJECT_ID = "demo-ai-chat-bot";
const AUTH_EMULATOR_HOST = "127.0.0.1:9099";
const FIRESTORE_EMULATOR_HOST = "127.0.0.1:8188";

if (process.env.FIRESTORE_EMULATOR_HOST !== FIRESTORE_EMULATOR_HOST) {
  throw new Error(`This test requires the local Firestore emulator at ${FIRESTORE_EMULATOR_HOST}`);
}
if (process.env.GCLOUD_PROJECT && process.env.GCLOUD_PROJECT !== PROJECT_ID) {
  throw new Error(`Refusing to run against non-demo Firebase project ${process.env.GCLOUD_PROJECT}`);
}
if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID !== PROJECT_ID) {
  throw new Error(`Refusing to run against non-demo Firebase project ${process.env.FIREBASE_PROJECT_ID}`);
}

// firebase emulators:exec starts Auth but does not set the Admin SDK switch for
// the test process. Pin it before importing any Firebase Admin modules.
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_EMULATOR_HOST;
process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
process.env.FIREBASE_ALLOWED_SIGN_IN_PROVIDERS = "password";
process.env.FIREBASE_WEB_API_KEY = "emulator-only-fake-api-key";
process.env.FIREBASE_AUTH_DOMAIN = `${PROJECT_ID}.firebaseapp.com`;
process.env.FIREBASE_STORAGE_BUCKET = `${PROJECT_ID}.appspot.com`;
process.env.FIREBASE_MESSAGING_SENDER_ID = "1234567890";
process.env.FIREBASE_APP_ID = "1:1234567890:web:emulator-only";
process.env.USER_SESSION_TTL_HOURS = "1";
process.env.USER_SESSION_EXCHANGE_MAX_AGE_MINUTES = "5";
process.env.MEDIA_DRIVE_TOKEN_ENCRYPTION_KEY = "emulator-only-placeholder";
process.env.MEDIA_VIEW_SIGNING_KEY = "emulator-only-placeholder";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const credentialsPath = path.join(os.tmpdir(), `codex-auth-emulator-${crypto.randomUUID()}.json`);
fs.writeFileSync(credentialsPath, JSON.stringify({
  type: "service_account",
  project_id: PROJECT_ID,
  private_key_id: "emulator-only",
  private_key: privateKey,
  client_email: `firebase-adminsdk-emulator@${PROJECT_ID}.iam.gserviceaccount.com`,
  client_id: "1234567890",
  token_uri: "http://127.0.0.1/token-uri-must-not-be-used",
}));
process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

const express = require("express");
const { initializeApp, getApps, deleteApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { router: authRouter } = require("../../src/routes/userAuth");
const botManagementRouter = require("../../src/routes/botManagement");
const userAccounts = require("../../src/services/userAccounts");

async function createPasswordUser(email, password) {
  const response = await fetch(
    `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${process.env.FIREBASE_WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const body = await response.json();
  assert.equal(response.ok, true, `Auth Emulator signup failed: ${body.error?.message || response.status}`);
  return { uid: body.localId, email: body.email };
}

async function signInWithPassword(email, password) {
  const response = await fetch(
    `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const body = await response.json();
  assert.equal(response.ok, true, `Auth Emulator sign-in failed: ${body.error?.message || response.status}`);
  return body;
}

async function exchangeForSession(baseUrl, idToken) {
  const response = await fetch(`${baseUrl}/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ idToken }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `Session exchange failed: ${JSON.stringify(body)}`);
  const cookie = response.headers.get("set-cookie")?.match(/(?:^|,\s*)user_session=([^;]+)/)?.[1];
  assert.ok(cookie, "Expected the real session endpoint to set user_session cookie");
  return { body, cookie: `user_session=${cookie}` };
}

test("Auth Emulator ID tokens become real sessions and bot access stays tenant-scoped", { timeout: 60_000 }, async () => {
  const app = getApps()[0] || initializeApp({ projectId: PROJECT_ID });
  const auth = getAuth(app);
  const db = getFirestore(app);
  const suffix = crypto.randomUUID();
  const password = `Local-only-${crypto.randomBytes(24).toString("hex")}!`;
  const ownerEmail = `auth-owner-${suffix}@example.test`;
  const otherEmail = `auth-other-${suffix}@example.test`;
  const users = [];
  let server;

  try {
    assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, AUTH_EMULATOR_HOST);
    const centralDriveSecret = await db.collection("systemSecrets").doc("googleDrive").get();
    assert.equal(centralDriveSecret.exists, false, "Refusing this test unless Drive is disconnected in the fresh demo emulator");

    const owner = await createPasswordUser(ownerEmail, password);
    users.push(owner.uid);
    await auth.updateUser(owner.uid, { emailVerified: true });
    const ownerSignIn = await signInWithPassword(ownerEmail, password);

    const other = await createPasswordUser(otherEmail, password);
    users.push(other.uid);
    await auth.updateUser(other.uid, { emailVerified: true });
    const otherSignIn = await signInWithPassword(otherEmail, password);
    assert.notEqual(ownerSignIn.localId, otherSignIn.localId);
    assert.ok(ownerSignIn.idToken);
    assert.ok(otherSignIn.idToken);

    const serverApp = express();
    serverApp.use(express.json());
    serverApp.use(authRouter);
    serverApp.use(botManagementRouter);
    server = http.createServer(serverApp);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const anonymousResponse = await fetch(`${baseUrl}/dashboard/bots/example-client/api/summary`);
    assert.equal(anonymousResponse.status, 401, "Unauthenticated requests must stop at the real session middleware");

    const ownerSession = await exchangeForSession(baseUrl, ownerSignIn.idToken);
    assert.equal(ownerSession.body.uid, owner.uid);
    const ownerProfile = await fetch(`${baseUrl}/auth/me`, { headers: { cookie: ownerSession.cookie } });
    assert.equal(ownerProfile.status, 200);
    assert.equal((await ownerProfile.json()).uid, owner.uid);

    await userAccounts.attachBot(owner.uid, "example-client");
    const ownerBotResponse = await fetch(`${baseUrl}/dashboard/bots/example-client/api/summary`, {
      headers: { cookie: ownerSession.cookie },
    });
    assert.equal(ownerBotResponse.status, 200, "The owner must pass session and Firestore ownership middleware");
    assert.match(ownerBotResponse.headers.get("content-type") || "", /application\/json/);
    assert.equal((await ownerBotResponse.json()).clientId, "example-client");

    const otherSession = await exchangeForSession(baseUrl, otherSignIn.idToken);
    assert.equal(otherSession.body.uid, other.uid);
    const otherBotResponse = await fetch(`${baseUrl}/dashboard/bots/example-client/api/summary`, {
      headers: { cookie: otherSession.cookie },
    });
    assert.equal(otherBotResponse.status, 404, "A different signed-in user must not access the owner's bot");
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    await Promise.all(users.map(async (uid) => {
      await db.collection("users").doc(uid).delete().catch(() => {});
      await auth.deleteUser(uid).catch(() => {});
    }));
    await db.terminate().catch(() => {});
    await Promise.all(getApps().map((adminApp) => deleteApp(adminApp).catch(() => {})));
    fs.rmSync(credentialsPath, { force: true });
  }
});
