// تهيئة Firebase Admin SDK (نسخة 14.x — API الحديث المفكّك بالوحدات، مش namespace القديم
// admin.apps/admin.firestore()). مثيل واحد مشترك لكل الخدمة (Firestore + Authentication).
// استخدام Admin SDK حصرًا من السيرفر — الفرونت إند (لو احتاج Firebase لاحقًا) بيستخدم
// firebase.config.js (مفاتيح غير سرية أصلًا، راجع src/config.js حقل firebase).

const path = require("path");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const config = require("../config");

if (!getApps().length) {
  initializeApp({
    credential: cert(
      path.isAbsolute(config.firebase.credentialsPath)
        ? config.firebase.credentialsPath
        : path.join(__dirname, "..", "..", config.firebase.credentialsPath)
    ),
    projectId: config.firebase.projectId,
  });
}

const db = getFirestore();
const auth = getAuth();

module.exports = { db, auth };
