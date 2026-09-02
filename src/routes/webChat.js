const express = require("express");
const config = require("../config");
const rateLimit = require("../services/rateLimit");
const registry = require("../clients/registry");
const handoff = require("../services/handoff");
const messageGate = require("../services/messageGate");
const conversationEngine = require("../services/conversationEngine");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

// إعدادات تخصيص الودجت (لون/عنوان/أسئلة مقترحة) — بيانات عامة عمدًا (براندينغ ظاهر أصلاً
// لكل زائر)، محمية بسقف طلبات حتى ما تصير مصدر ضغط. عميل غير موجود = قيم فاضية والودجت
// بيضل شغال بإعدادات الوسوم المضمّنة.
router.get("/widget-config/:clientId", (req, res) => {
  const ip = req.ip || "unknown";
  if (!rateLimit.checkLimit(`widget-cfg:${ip}`, { max: 240, windowMs: 60 * 60 * 1000 }).allowed) {
    return res.status(429).json({ error: { code: "rate_limited" } });
  }

  const client = registry.getClientById(String(req.params.clientId || ""));
  const w = client?.widget || {};
  res.json({
    accentColor: typeof w.accentColor === "string" && /^#[0-9a-fA-F]{3,8}$/.test(w.accentColor) ? w.accentColor : null,
    title: typeof w.title === "string" && w.title.trim() ? w.title.trim().slice(0, 60) : null,
    suggestions: Array.isArray(w.suggestions)
      ? w.suggestions.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim().slice(0, 120)).slice(0, 6)
      : [],
  });
});

// ودجت الموقع بتستدعي هالـ endpoint. sessionId يجيء من الودجت (مولّد بالمتصفح ومحفوظ بـ localStorage).
// المصادقة (pk_/sk_/الوضع القديم) بتصير بـ authenticate middleware — بترتب req.client جاهز هون.
//
// الحواجز الثابتة وشكل أخطاء السقوف HTTP هون، ووسط المعالجة المشترك بconversationEngine.
router.post("/chat/:clientId", authenticate({ allow: ["public", "secret"] }), async (req, res) => {
  const client = req.client;
  try {
    const { message, sessionId } = req.body;
    // اختياري — من data-page-context بالودجت المضمّن، وين الزائر موجود بصفحة المضيف هلق.
    // نص حر من صفحة المضيف مش من الزبون، بس منحدد طول أقصى احتياطًا (ما بيوصل لـsystem prompt خام بلا حد).
    const pageContext = typeof req.body.pageContext === "string" ? req.body.pageContext.trim().slice(0, 200) : "";
    // معرّف قصير وثابت لنوع الصفحة (مش النص الحر) — راجع data-page-key بالودجت. نحصره
    // بحروف/أرقام/شرطات فقط حتى ما يصير مصدر مفاتيح كاش عشوائية غير محدودة.
    const pageKeyRaw = typeof req.body.pageKey === "string" ? req.body.pageKey.slice(0, 40) : "";
    const pageKey = /^[a-zA-Z0-9_-]*$/.test(pageKeyRaw) ? pageKeyRaw : "";

    if (!message || !sessionId) {
      return res.status(400).json({ error: { code: "missing_fields", message: "message و sessionId مطلوبين" } });
    }

    // حواجز ثابتة (موقوف/قناة/باقة) — على كل رسالة
    const gate = messageGate.evaluateStatic(client, "web");
    if (!gate.allowed) {
      switch (gate.reason) {
        case "bot_paused":
          return res.json({
            reply: `عذرًا، ${client.displayName} متوقف مؤقتًا عن الرد الآلي حاليًا. للتواصل المباشر: ${client.escalation.contactMethod} (${client.escalation.phone})`,
          });
        case "channel_off":
          return res.json({
            reply: `عذرًا، ${client.displayName} أوقف الرد الآلي عبر الموقع مؤقتًا. للتواصل المباشر: ${client.escalation.contactMethod} (${client.escalation.phone})`,
          });
        case "widget_not_included":
          return res.status(403).json({
            error: { code: "widget_not_included", message: "ودجت الموقع مش متوفر بباقتك الحالية — تواصل معنا للترقية" },
          });
      }
    }

    // ===== مسار streaming (SSE) — للودجت بس، لما العميل يطلبه =====
    // المحرك بينده getReplyStream داخليًا لما نمرر onDelta، وأي فشل بالبث بيصير
    // رسالة اعتذار بنفس الستريم بدون مسار موازٍ.
    const wantsStream =
      config.streaming?.enabled !== false &&
      (req.headers.accept || "").includes("text/event-stream");
    if (wantsStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // nginx ما يخزّن الرد — الدلتا توصل لحالها
      });

      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      try {
        const result = await conversationEngine.handleInbound({
          client,
          channel: "web",
          endUserId: sessionId,
          userText: message,
          onDelta: (delta) => send({ type: "delta", text: delta }),
          pageContext,
          pageKey,
        });

        if (result.kind === "blocked") {
          // السقوف انفحصت بعد ما بلشنا البث نظريًا مستحيل (انفحصت قبل deepseek)، بس للأمان
          send({ type: "done", reply: `وصلنا لحد رسائل الفترة الحالية (${result.reason}). تواصل معنا للمساعدة.` });
        } else {
          // الرد النهائي النظيف (بعد شيل ماركر التصعيد) — الودجت بيعتمده كنص نهائي
          send({ type: "done", reply: result.reply });
        }
        res.end();
      } catch (err) {
        console.error("web chat stream error:", err.response?.data || err.message);
        // سياسة موحدة: رسالة تحويل محايدة بدون أي تفاصيل تقنية
        send({ type: "done", reply: handoff.buildServiceIssueReply(client) });
        res.end();
      }
      return;
    }

    // المسار العادي غير المتدفق
    const result = await conversationEngine.handleInbound({
      client,
      channel: "web",
      endUserId: sessionId,
      userText: message,
      pageContext,
      pageKey,
    });

    if (result.kind === "blocked") {
      switch (result.reason) {
        case "trial_cap":
          return res.status(403).json({ error: { code: "trial_limit_reached", message: "وصلت لسقف رسائل الفترة التجريبية" } });
        case "session_cap":
        case "daily_cap":
          return res.status(429).json({
            error: {
              code: "rate_limited",
              message:
                result.reason === "session_cap"
                  ? "رسائل كتير بوقت قصير — جرب بعد شوي"
                  : "وصلنا لسقف الرسائل اليومي — جرب بكرا",
            },
          });
        case "monthly_cap":
          return res.status(429).json({
            error: { code: "tier_limit_reached", message: "وصلت لسقف رسائل باقتك الشهري — تواصل معنا للترقية" },
          });
      }
    }

    res.json({ reply: result.reply });
  } catch (err) {
    console.error("web chat error:", err.response?.data || err.message);
    res.status(500).json({
      error: { code: "internal_error", message: handoff.buildServiceIssueReply(client) },
    });
  }
});

module.exports = router;
