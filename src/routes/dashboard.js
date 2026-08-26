// Dashboard رئيسي — راجع docs/site-restructure-plan.md قسم 5. حساب واحد بيقدر يملك أكتر
// من بوت (config.js حقل bots[] بملف المستخدم)، فهون منجمّع إحصائيات كل بوت تبعه.
//
// ملاحظة مقصودة (2026-08-14): الباقة (tier) وسقفها لسا حقل عالبوت الواحد (client.tier)،
// مش عالحساب — نقلها لمستوى الحساب (قرار "باقة واحدة مشتركة لكل بوتات الحساب") بند Phase 5
// منفصل، بيحتاج مراجعة admin.js أول. هلق كل بوت بيعرض سقف باقته الخاصة به.

const express = require("express");
const path = require("path");
const fs = require("fs");
const config = require("../config");
const safeWrite = require("../services/safeWrite");
const usageLedger = require("../services/usageLedger");
const userAccounts = require("../services/userAccounts");
const asyncHandler = require("../middleware/asyncHandler");
const { requireUserAuth } = require("./userAuth");

const router = express.Router();

router.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "dashboard.html"));
});

function countConversationsThisMonth(clientId) {
  const customersDir = path.join(safeWrite.dataDir(clientId), "customers");
  if (!fs.existsSync(customersDir)) return 0;

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const file of fs.readdirSync(customersDir)) {
    if (!file.endsWith(".json")) continue;
    const profile = safeWrite.safeReadJSON(path.join(customersDir, file), null);
    if (profile?.firstSeenAt && new Date(profile.firstSeenAt).getTime() >= cutoff) count += 1;
  }
  return count;
}

async function buildBotSummary(clientId) {
  const cfgPath = path.join(safeWrite.clientDir(clientId), "config.json");
  const cfg = safeWrite.safeReadJSON(cfgPath, null);
  if (!cfg) return null; // بوت اتحذف يدويًا من الملفات بدون ما ينشال من bots[] — تجاهله بدل ما يكسر الصفحة

  const planDef = cfg.tier ? config.plans[cfg.tier] : null;
  const isTrial = cfg.plan === "trial";
  const cap = planDef ? planDef.monthlyMessageCap : isTrial ? config.provisioning.trialMessageCap : null;
  const usageKey = planDef ? `tier-monthly-msgs:${clientId}` : isTrial ? `trial-msgs:${clientId}` : null;
  const usage = usageKey ? await usageLedger.peek(usageKey) : { count: 0 };

  return {
    clientId,
    displayName: cfg.displayName,
    status: cfg.status || "active",
    botPaused: Boolean(cfg.botPaused),
    tier: cfg.tier || null,
    plan: cfg.plan || "manual",
    messagesThisPeriod: usage.count || 0,
    messagesCap: cap,
    topUpCreditsRemaining: cfg.topUpCreditsRemaining || 0,
    conversationsThisPeriod: countConversationsThisMonth(clientId),
  };
}

router.get("/dashboard/api/summary", requireUserAuth, asyncHandler(async (req, res) => {
  const profile = await userAccounts.getProfile(req.uid);
  if (!profile) return res.status(404).json({ error: { code: "profile_not_found", message: "ملف شخصي غير موجود" } });

  const bots = (await Promise.all(profile.bots.map(buildBotSummary))).filter(Boolean);

  res.json({ email: profile.email, bots });
}));

module.exports = router;
