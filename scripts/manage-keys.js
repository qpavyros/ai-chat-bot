#!/usr/bin/env node
/**
 * يصدر/يلغي مفاتيح pk_/sk_ لعميل مُنشأ يدويًا (config.json مكتوب بالإيد، مش تسجيل ذاتي —
 * هدول عندهم auth.json من `provisioning.js` تلقائيًا). بديل عن الاعتماد على WEB_WIDGET_KEY
 * المشترك القديم (ALLOW_LEGACY_WIDGET_KEY بـ.env).
 *
 * الاستخدام:
 *   npm run key -- issue <clientId> [label]     يُنشئ pk_ (إذا ناقص) + sk_ جديد، يطبعهم مرة وحدة
 *   npm run key -- list <clientId>              يعرض pk_ (كامل، عام) + قائمة sk_ (بدون القيمة الخام — غير مخزّنة)
 *   npm run key -- revoke <clientId> <keyId>     يلغي مفتاح sk_ معيّن (pk_ ما بينلغى، غيّر الملف يدويًا إذا لزم)
 *
 * ⚠️ الـsk_ الخام بيطبع مرة وحدة بس وقت الإصدار — غير مخزّن أبدًا (بس الـhash). لو ضاع، أصدر
 * مفتاح جديد وألغي القديم.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const apiKeys = require("../src/services/apiKeys");

const CLIENTS_DIR = path.join(__dirname, "..", "src", "clients");

function authPath(clientId) {
  return path.join(CLIENTS_DIR, clientId, "auth.json");
}

function loadAuth(clientId) {
  const file = authPath(clientId);
  if (!fs.existsSync(file)) return { publicKey: null, apiKeys: [] };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveAuth(clientId, auth) {
  fs.writeFileSync(authPath(clientId), JSON.stringify(auth, null, 2), "utf8");
}

function requireClientDir(clientId) {
  const dir = path.join(CLIENTS_DIR, clientId);
  if (!fs.existsSync(path.join(dir, "config.json"))) {
    console.error(`مجلد العميل غير موجود أو ناقص config.json: ${dir}`);
    process.exit(1);
  }
}

function issue(clientId, label) {
  requireClientDir(clientId);
  const auth = loadAuth(clientId);

  if (!auth.publicKey) {
    auth.publicKey = apiKeys.generatePublicKey();
  }

  const rawSecret = apiKeys.generateSecretKey();
  const record = {
    id: crypto.randomBytes(6).toString("hex"),
    hash: apiKeys.hashKey(rawSecret),
    label: label || "بدون تسمية",
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };
  auth.apiKeys.push(record);
  saveAuth(clientId, auth);

  console.log(`✅ مفاتيح "${clientId}" جاهزة:\n`);
  console.log(`pk_ (عام — للودجت):\n  ${auth.publicKey}\n`);
  console.log(`sk_ (سري — سيرفر-لسيرفر، معرّف ${record.id}، اطبعه هلق لأنه ما رح يتعاد عرضه):\n  ${rawSecret}\n`);
  console.log(`ضيف بكود الودجت: <script data-client-key="${auth.publicKey}" ...>`);
}

function list(clientId) {
  requireClientDir(clientId);
  const auth = loadAuth(clientId);

  console.log(`pk_: ${auth.publicKey || "(ما في بعد — أصدر مفتاح أول)"}\n`);
  if (!auth.apiKeys.length) {
    console.log("sk_: ما في مفاتيح سرية مُصدرة بعد.");
    return;
  }
  console.log("sk_ المصدرة:");
  for (const key of auth.apiKeys) {
    const status = key.revokedAt ? `ملغى (${key.revokedAt})` : "فعّال";
    console.log(`  ${key.id}  [${status}]  "${key.label}"  أُصدر ${key.createdAt}`);
  }
}

function revoke(clientId, keyId) {
  requireClientDir(clientId);
  const auth = loadAuth(clientId);

  const record = auth.apiKeys.find((k) => k.id === keyId);
  if (!record) {
    console.error(`ما في مفتاح بمعرّف "${keyId}" لعميل "${clientId}". استخدم "list" لتشوف المعرّفات.`);
    process.exit(1);
  }
  if (record.revokedAt) {
    console.log(`المفتاح ${keyId} أصلاً ملغى من ${record.revokedAt}.`);
    return;
  }
  record.revokedAt = new Date().toISOString();
  saveAuth(clientId, auth);
  console.log(`✅ ألغيت المفتاح ${keyId} ("${record.label}") لعميل "${clientId}".`);
}

function main() {
  const [cmd, clientId, extra] = process.argv.slice(2);
  const usage = "الاستخدام: npm run key -- <issue|list|revoke> <clientId> [label|keyId]";

  if (!cmd || !clientId) {
    console.error(usage);
    process.exit(1);
  }

  if (cmd === "issue") return issue(clientId, extra);
  if (cmd === "list") return list(clientId);
  if (cmd === "revoke") {
    if (!extra) {
      console.error("لازم تحدد keyId للإلغاء. " + usage);
      process.exit(1);
    }
    return revoke(clientId, extra);
  }

  console.error(`أمر غير معروف: ${cmd}\n${usage}`);
  process.exit(1);
}

main();
