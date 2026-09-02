const registry = require("../clients/registry");
const whatsapp = require("./whatsapp");
const usageLedger = require("./usageLedger");
const escalationLog = require("./escalationLog");
const escalationHandled = require("./escalationHandled");
const config = require("../config");
const safeWrite = require("./safeWrite");

function getUTCISOWeek(d) {
  const thurs = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - (d.getUTCDay() || 7)));
  const firstDay = new Date(Date.UTC(thurs.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((thurs - firstDay) / 86400000) + 1) / 7);
  return `${thurs.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function sendDigestForClient(client) {
  const notifyTo = client.escalation?.notifyWhatsapp;
  const senderPhoneNumberId = client.whatsappPhoneNumberId || config.whatsapp.notifySenderPhoneNumberId;
  if (!notifyTo || !senderPhoneNumberId) {
    return { ok: false, reason: "missing_notify_whatsapp" };
  }

  const isTrial = client.plan === "trial";
  const planDef = client.tier ? config.plans[client.tier] : null;
  const usageKey = planDef ? `tier-monthly-msgs:${client.id}` : isTrial ? `trial-msgs:${client.id}` : null;
  const usage = usageKey ? await usageLedger.peek(usageKey) : { count: 0 };
  const cap = planDef ? planDef.monthlyMessageCap : isTrial ? config.provisioning.trialMessageCap : "غير محدود";

  const escalations = escalationLog.readRecent(client.id, 100);
  const handledIds = new Set(escalationHandled.getHandledIds(client.id));
  const unhandledCount = escalations.filter((e) => !handledIds.has(e.id)).length;

  const text =
    `📊 التقرير الأسبوعي — ${client.displayName}\n\n` +
    `• رسائل الفترة: ${usage.count || 0} / ${cap}\n` +
    `• الطلبات والتصعيدات: ${escalations.length} إجمالي (${unhandledCount} بانتظار المتابعة)\n` +
    `• الرصيد الإضافي: ${client.topUpCreditsRemaining || 0} رسالة\n\n` +
    `للوصول للوحة التحكم والتفاصيل:\n` +
    `${config.provisioning.publicBaseUrl}/dashboard/bots/${client.id}`;

  try {
    await whatsapp.sendTextMessage(notifyTo, senderPhoneNumberId, text);
    return { ok: true };
  } catch (err) {
    console.error(`[weeklyDigest] فشل إرسال التقرير لـ ${client.id}:`, err.response?.data || err.message);
    return { ok: false, error: err.message };
  }
}

async function sendWeeklyDigests() {
  const clients = registry.getAllClients();
  let sent = 0;
  for (const client of clients) {
    if (client.botPaused || !registry.isServable(client)) continue;
    try {
      const res = await sendDigestForClient(client);
      if (res.ok) sent++;
    } catch (err) {
      console.error(`[weeklyDigest] Failed to prepare digest for ${client.id}:`, err.message);
    }
  }
  return { total: clients.length, sent };
}

async function sendScheduledDigestsOnce(now = new Date()) {
  const week = getUTCISOWeek(now);
  const clients = registry.getAllClients();
  let sent = 0;
  for (const client of clients) {
    if (client.botPaused || !registry.isServable(client)) continue;
    
    if (client.lastWeeklyDigestWeek === week) continue;

    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    let reserved = false;
    await safeWrite.updateClientConfig(client.id, (cfg) => {
      if (cfg.lastWeeklyDigestWeek === week || cfg.pendingDigestWeek === week) {
        return cfg;
      }
      reserved = true;
      return { ...cfg, pendingDigestWeek: week, pendingDigestToken: token };
    });
    
    if (!reserved) continue;

    try {
      const res = await sendDigestForClient(client);
      if (res.ok) {
        await safeWrite.updateClientConfig(client.id, (cfg) => {
          if (cfg.pendingDigestToken !== token) return cfg;
          const { pendingDigestWeek, pendingDigestToken, ...rest } = cfg;
          return { ...rest, lastWeeklyDigestWeek: week };
        });
        client.lastWeeklyDigestWeek = week;
        sent++;
      } else {
        await safeWrite.updateClientConfig(client.id, (cfg) => {
          if (cfg.pendingDigestToken !== token) return cfg;
          const { pendingDigestWeek, pendingDigestToken, ...rest } = cfg;
          return rest;
        });
      }
    } catch (err) {
      console.error(`[weeklyDigest] Failed to prepare digest for ${client.id}:`, err.message);
      await safeWrite.updateClientConfig(client.id, (cfg) => {
        if (cfg.pendingDigestToken !== token) return cfg;
        const { pendingDigestWeek, pendingDigestToken, ...rest } = cfg;
        return rest;
      });
    }
  }
  return { total: clients.length, sent };
}

function scheduleWeeklyDigests() {
  const CHECK_INTERVAL = 60 * 60 * 1000;

  setInterval(async () => {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();

    if (day === 0 && hour === 9) {
      console.log("[weeklyDigest] جاري إرسال التقرير الأسبوعي للبوتات النشطة...");
      try {
        await sendScheduledDigestsOnce(now);
      } catch (err) {
        console.error("[weeklyDigest] Scheduled run failed:", err.message);
      }
    }
  }, CHECK_INTERVAL);
}

module.exports = {
  sendDigestForClient,
  sendWeeklyDigests,
  scheduleWeeklyDigests,
  sendScheduledDigestsOnce,
};
