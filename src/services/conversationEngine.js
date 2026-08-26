// المحرك الموحد لمعالجة رسائل الزبائن — كل القنوات (ودجت/واتساب/تلغرام/ديسكورد) بتمر هون.
//
// قبل هالملف، نفس السلسلة كانت منسوخة بين webChat.js وwhatsappWebhook.js وكل قناة جديدة
// كانت معناها نسخة ثالثة ورابعة. هلق المدخل بيقوم بالحواجز الثابتة وشكل الرد حسب قناته،
// والوسط المشترك (تصعيد معلّق → كلمة تصعيد → كاش → عدادات → DeepSeek → حفظ → تصعيد) هون
// بمكان واحد.
//
// ما منلمس: الحواجز الثابتة (messageGate.evaluateStatic) وسقوف HTTP للودجت — بتضل عند
// المدخل لأن شكلها بيختلف جذرياً بين قناة وأخرى (JSON 403 مقابل رسالة واتساب مقابل تجاهل).
const deepseek = require("./deepseek");
const customers = require("./customers");
const handoff = require("./handoff");
const replyCache = require("./replyCache");
const messageGate = require("./messageGate");
const stats = require("./stats");
const { isWithinBusinessHours } = require("./businessHours");

/**
 * @param {object} client عميل من registry
 * @param {"web"|"whatsapp"|"telegram"|"discord"} channel
 * @param {string} endUserId معرف الزبون بالقناة (sessionId للودجت، رقم الهاتف لواتساب، chat.id لتلغرام...)
 * @param {string} userText نص الرسالة الواردة
 * @param {(delta:string)=>void} [onDelta] اختياري — بث تدريجي للرد (الودجت بس). تمريره يقلب
 *   الاستدعاء الداخلي لـgetReplyStream بدل getReply.
 * @param {string} [pageContext] اختياري — وصف حر لوين الزائر موجود بصفحة المضيف هلق (ودجت
 *   الموقع بس، راجع data-page-context بـchat-widget.js)، بيوصل كسياق للنموذج بس، مش للكاش
 *   (ممكن يحمل تفاصيل ديناميكية متل اسم شركة).
 * @param {string} [pageKey] اختياري — معرّف قصير وثابت لنوع الصفحة (راجع data-page-key)،
 *   لتقسيم الكاش بشكل صحيح بدون ما يفلت جواب صفحة عصفحة تانية بنفس السؤال.
 * @returns {Promise<{kind:"reply", reply:string, escalated?:boolean}|{kind:"blocked", reason:string}>}
 */
async function handleInbound({ client, channel, endUserId, userText, onDelta, pageContext = "", pageKey = "" }) {
  stats.increment({ messages: 1 });

  // ١) محادثة موقوفة بعد تصعيد سابق — رد "لسا منستنى" بدون DeepSeek ولا عدّ
  if (handoff.isConversationPaused(client.id, endUserId)) {
    return { kind: "reply", reply: handoff.buildStillWaitingReply(client) };
  }

  // ٢) تصعيد بكلمة مفتاحية — رد فوري جاهز + إشعار صاحب العمل، بدون استدعاء نموذج
  if (handoff.checkKeywordEscalation(userText)) {
    const reply = handoff.buildEscalationReply(client);
    await customers.saveTurn(client.id, endUserId, userText, reply);
    await handoff.handleEscalation(client, { channel, endUserId, lastMessage: userText });
    stats.increment({ escalations: 1 });
    return { kind: "reply", reply };
  }

  // ٣) كاش الردود — زبون أول-تواصل بس (راجع replyCache.js للشروط الثلاثة)
  const profile = customers.getProfile(client.id, endUserId);
  const cacheable = profile.history.length === 0 && profile.facts.length === 0;
  const cachedReply = cacheable ? replyCache.get(client.id, userText, pageKey) : null;
  if (cachedReply) {
    stats.increment({ cacheHits: 1 });
    await customers.saveTurn(client.id, endUserId, userText, cachedReply);
    return { kind: "reply", reply: cachedReply };
  }

  // ٣.٥) خارج ساعات الدوام — رد مهذب بدون استهلاك DeepSeek ولا عدّ. عمدًا بعد الكاش:
  // سؤال شائع بيلقى جوابه حتى بعد الدوام، وأي شي محتاج نموذج بينقال عليه إننا مقفلين هلق.
  // كلمات التصعيد فاتت فوق عمدًا كمان — "بدي حدا حقيقي" برا الدوام لازم توصل لصاحب العمل.
  if (!isWithinBusinessHours(client.businessHours)) {
    const bh = client.businessHours;
    const hoursHint =
      bh?.start && bh?.end ? ` ساعاتنا: ${bh.start} حتى ${bh.end} بتوقيت بيروت.` : "";
    const reply =
      `عذرًا، ${client.displayName} حاليًا خارج ساعات الدوام.${hoursHint} ` +
      `اكتبلك رسالة وبررد عليك أول ما نفتح، أو للتواصل الفوري: ${client.escalation.contactMethod} (${client.escalation.phone})`;
    stats.increment({ offHours: 1 });
    return { kind: "reply", reply, offHours: true };
  }

  // ٤) عدادات وسقوف — بس هلق لما صار واضح إنه رح ينستدعى DeepSeek فعليًا.
  // ردود الكاش والكلمات الجاهزة فوق ما بتستهلك شي (تكلفتهم صفر).
  const meter = await messageGate.meterAndCap(client, channel, endUserId);
  if (!meter.allowed) {
    return { kind: "blocked", reason: meter.reason };
  }

  // ٥) النموذج + ماركر التصعيد + الحفظ + التخزين بالكاش + إشعار التصعيد
  stats.increment({ llmCalls: 1 });
  const result = onDelta
    ? await deepseek.getReplyStream(client, profile, userText, onDelta, pageContext)
    : await deepseek.getReply(client, profile, userText, pageContext);

  if (result.usage) {
    stats.increment({
      tokensIn: result.usage.prompt_tokens || 0,
      tokensOut: result.usage.completion_tokens || 0,
    });
  }

  const { escalated, cleanText } = handoff.extractEscalationMarker(result.text);

  await customers.saveTurn(client.id, endUserId, userText, cleanText);

  // ما نخزّن إلا رد "نظيف": أول-تواصل + بدون أدوات + بدون تصعيد
  if (cacheable && !result.toolsUsed && !escalated) {
    replyCache.set(client.id, userText, cleanText, pageKey);
  }
  if (escalated) {
    stats.increment({ escalations: 1 });
    await handoff.handleEscalation(client, { channel, endUserId, lastMessage: userText });
  }

  return { kind: "reply", reply: cleanText, escalated };
}

module.exports = { handleInbound };
