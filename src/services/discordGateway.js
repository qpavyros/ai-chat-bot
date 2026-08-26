// عميل Discord Gateway خام (websocket) — بديل خفيف عن discord.js الثقيلة.
// لكل بوت عميل اتصال وحدة: استقبال الرسائل الخاصة (DM) فقط، والرد عبر REST.
//
// ⚠️ شرط تشغيلي: MESSAGE_CONTENT نية (intent) مميزة — لازم صاحب البوت يفعّلها من بوابة
// مطورين Discord (Bot settings → Privileged Gateway Intents → Message Content Intent)
// وإلا المحتوى بييجي فاضي بكل رسالة.
//
// إعادة الاتصال: backoff أسي حتى 5 دقائق. ما في resume عمدًا — identify من جديد أبسط
// وكافي لأننا ما بنعتمد على أحداث فائتة (زبون بيكتب مرة تانية).
const WebSocket = require("ws");
const registry = require("../clients/registry");
const messageGate = require("./messageGate");
const conversationEngine = require("./conversationEngine");

const DISCORD_API = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
// DIRECT_MESSAGES | MESSAGE_CONTENT
const INTENTS = (1 << 12) | (1 << 15);

const connections = new Map(); // clientId -> { ws, heartbeatTimer, token, stopped }

function log(clientId, ...args) {
  console.log(`[discord:${clientId}]`, ...args);
}

async function restRequest(token, method, path, body) {
  const res = await fetch(DISCORD_API + path, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 429) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res;
}

async function sendReply(token, channelId, text) {
  // تقسيم لأجزاء 2000 حرف (حد Discord للرسالة الواحدة)
  for (let i = 0; i < text.length; i += 2000) {
    await restRequest(token, "POST", `/channels/${channelId}/messages`, {
      content: text.slice(i, i + 2000),
    });
    if (i + 2000 < text.length) {
      await new Promise((r) => setTimeout(r, 500)); // احترام rate limit
    }
  }
}

function startForClient(clientId, token, onLog = log) {
  if (connections.has(clientId)) stopForClient(clientId);

  const state = { ws: null, heartbeatTimer: null, token, stopped: false, attempts: 0 };
  connections.set(clientId, state);
  connect(clientId, state, onLog);
}

function connect(clientId, state, onLog) {
  if (state.stopped) return;
  const ws = new WebSocket(GATEWAY_URL);
  state.ws = ws;

  ws.on("message", async (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (payload.op) {
      case 10: {
        // Hello — نبضات القلب + Identify
        const interval = payload.d?.heartbeat_interval || 45000;
        clearInterval(state.heartbeatTimer);
        state.heartbeatTimer = setInterval(() => {
          try {
            ws.send(JSON.stringify({ op: 1, d: null }));
          } catch {
            /* السوكيت انقفل — إعادة الاتصال بتتكفل */
          }
        }, interval * 0.9); // هامش أمان قبل المهلة

        ws.send(
          JSON.stringify({
            op: 2,
            d: {
              token: state.token,
              intents: INTENTS,
              properties: { os: "linux", browser: "ai-chat-bot", device: "ai-chat-bot" },
            },
          })
        );
        break;
      }

      case 0: {
        if (payload.t === "MESSAGE_CREATE") {
          handleMessageCreate(clientId, payload.d).catch((err) =>
            onLog(clientId, "فشل معالجة رسالة:", err.message)
          );
        }
        break;
      }

      case 11:
        // Heartbeat ACK — كل شي تمام
        break;

      case 7:
      case 9:
        // إعادة اتصال مطلوبة / جلسة غير صالحة — نسكّر ونعيد من الصفر
        ws.close();
        break;
    }
  });

  ws.on("open", () => {
    state.attempts = 0;
    onLog(clientId, "متصل بالـgateway");
  });

  ws.on("close", () => {
    if (state.stopped) return;
    clearInterval(state.heartbeatTimer);
    state.attempts += 1;
    const delay = Math.min(300_000, 5_000 * state.attempts ** 2); // backoff أسي حتى 5 دقائق
    onLog(clientId, `انقطع الاتصال — إعادة بعد ${Math.round(delay / 1000)} ثانية`);
    setTimeout(() => connect(clientId, state, onLog), delay);
  });

  ws.on("error", (err) => {
    onLog(clientId, "خطأ websocket:", err.message);
  });
}

async function handleMessageCreate(clientId, d) {
  if (!d || !d.content) return;
  if (d.author?.bot) return; // رسائل البوتات نفسها (حتى البوت التاني)
  if (d.guild_id) return; // DM بس بهالمرحلة — سيرفرات السيرفرات لسا

  const client = registry.getClientById(clientId);
  if (!client?.discordBotToken) return;

  // حواجز ثابتة — نفس نمط تلغرام
  const gate = messageGate.evaluateStatic(client, "discord");
  if (!gate.allowed) {
    if (gate.reason === "bot_paused" || gate.reason === "channel_off") {
      await sendReply(
        state_tokenOf(clientId),
        d.channel_id,
        gate.reason === "bot_paused"
          ? `عذرًا، ${client.displayName} متوقف مؤقتًا عن الرد الآلي حاليًا. للتواصل المباشر: ${client.escalation.contactMethod} (${client.escalation.phone})`
          : `عذرًا، ${client.displayName} أوقف الرد عبر ديسكورد مؤقتًا. للتواصل المباشر: ${client.escalation.contactMethod} (${client.escalation.phone})`
      );
    }
    return;
  }

  const result = await conversationEngine.handleInbound({
    client,
    channel: "discord",
    endUserId: String(d.author.id),
    userText: d.content,
  });

  if (result.kind === "blocked") {
    log(clientId, `منع بالسقف (${result.reason}) — تجاهلنا`);
    return;
  }

  await sendReply(state_tokenOf(clientId), d.channel_id, result.reply);
}

function state_tokenOf(clientId) {
  return connections.get(clientId)?.token;
}

function stopForClient(clientId) {
  const state = connections.get(clientId);
  if (!state) return;
  state.stopped = true;
  clearInterval(state.heartbeatTimer);
  try {
    state.ws?.close();
  } catch {
    /* already closed */
  }
  connections.delete(clientId);
}

/**
 * مزامنة الاتصالات مع الـregistry: يشغّل أي بوت عنده توكن، ويوقف أي اتصال توكنه انشال.
 * تُستدعى عند الإقلاع وبعد تعديل الأدمن.
 */
function syncAll() {
  for (const clientId of require("../services/safeWrite").listClientIds()) {
    const cfgPath = require("path").join(__dirname, "..", "clients", clientId, "config.json");
    const cfg = require("../services/safeWrite").safeReadJSON(cfgPath, null);
    const active = connections.get(clientId);

    if (cfg?.discordBotToken) {
      if (!active || active.token !== cfg.discordBotToken) {
        startForClient(clientId, cfg.discordBotToken);
        console.log(`[discord] شغّلنا بوت "${clientId}"`);
      }
    } else if (active) {
      stopForClient(clientId);
      console.log(`[discord] وقّفنا بوت "${clientId}" (التوكن انشال)`);
    }
  }
}

module.exports = { syncAll, startForClient, stopForClient };
