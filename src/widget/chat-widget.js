/**
 * ودجت شات قابل للتضمين بأي موقع.
 * الاستخدام (مفتاح عام جديد — هيدا يلي بيرجعه التسجيل الذاتي):
 *   <script src="https://YOUR_SERVER/widget/chat-widget.js"
 *           data-server="https://YOUR_SERVER"
 *           data-client-id="acme-tools"
 *           data-public-key="pk_xxxxx"
 *           data-title="اسألنا أي شي"></script>
 *
 * الاستخدام القديم (لسا شغال، وضع توافق مؤقت):
 *   data-widget-key="change-me-too"  بدل data-public-key
 */
(function () {
  var scriptTag = document.currentScript;
  var SERVER = scriptTag.getAttribute("data-server").replace(/\/$/, "");
  var CLIENT_ID = scriptTag.getAttribute("data-client-id");
  var PUBLIC_KEY = scriptTag.getAttribute("data-public-key") || "";
  var WIDGET_KEY = scriptTag.getAttribute("data-widget-key") || ""; // وضع قديم — راجع README قسم "ملكية رقم واتساب"
  var TITLE = scriptTag.getAttribute("data-title") || "الدردشة معنا";

  var SESSION_KEY = "aicb_session_" + CLIENT_ID;
  var sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = "web-" + Math.random().toString(36).slice(2) + Date.now();
    localStorage.setItem(SESSION_KEY, sessionId);
  }

  var css = "" +
    "#aicb-bubble{position:fixed;bottom:20px;inset-inline-end:20px;width:56px;height:56px;border-radius:50%;" +
    "background:#00288e;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;" +
    "box-shadow:0 6px 18px rgba(0,0,0,.22);z-index:999999;font-size:26px;border:none;}" +
    "#aicb-panel{position:fixed;bottom:86px;inset-inline-end:20px;width:340px;max-width:92vw;height:460px;" +
    "max-height:75vh;background:#fff;border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.28);" +
    "display:none;flex-direction:column;overflow:hidden;z-index:999999;font-family:'Segoe UI',Tahoma,Arial,sans-serif;" +
    "direction:rtl;}" +
    "#aicb-panel.open{display:flex;}" +
    "#aicb-head{background:#00288e;color:#fff;padding:14px 16px;font-weight:600;font-size:15px;}" +
    "#aicb-msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f4f6f5;}" +    ".aicb-msg{max-width:82%;padding:9px 12px;border-radius:10px;font-size:14px;line-height:1.6;white-space:pre-wrap;}" +
    ".aicb-msg.user{align-self:flex-end;background:#00288e;color:#fff;border-bottom-right-radius:2px;}" +
    ".aicb-msg.bot{align-self:flex-start;background:#fff;color:#1a1a1a;border:1px solid #e3e6e5;border-bottom-left-radius:2px;}" +
    "#aicb-form{display:flex;border-top:1px solid #e3e6e5;padding:8px;gap:8px;background:#fff;}" +
    "#aicb-input{flex:1;border:1px solid #d8dbda;border-radius:8px;padding:9px 10px;font-size:14px;font-family:inherit;}" +
    "#aicb-send{background:#00288e;color:#fff;border:none;border-radius:8px;padding:0 14px;font-size:14px;cursor:pointer;}" +
    "#aicb-send:disabled{opacity:.6;cursor:default;}" +
    ".aicb-chip{border:1px solid #d8dbda;background:#f4f6f5;color:#1a1a1a;border-radius:999px;" +
    "padding:6px 12px;font-size:12.5px;cursor:pointer;font-family:inherit;text-align:right;}" +
    ".aicb-chip:hover{background:#e3e6e5;}";

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var bubble = document.createElement("button");
  bubble.id = "aicb-bubble";
  bubble.setAttribute("aria-label", TITLE);
  bubble.textContent = "💬";
  document.body.appendChild(bubble);

  var panel = document.createElement("div");
  panel.id = "aicb-panel";
  // بناء بالعناصر + textContent — العنوان (data-title) بييجي من كود الصفحة المضيفة، بس
  // ما في سبب نحقنه HTML أصلاً (نمط innerHTML هون كان بيسمح XSS لو حدا ضمّن ودجت بموقع ثالث).
  var headEl = document.createElement("div");
  headEl.id = "aicb-head";
  headEl.textContent = TITLE;
  var formEl0 = document.createElement("form");
  formEl0.id = "aicb-form";
  var inputEl0 = document.createElement("input");
  inputEl0.id = "aicb-input";
  inputEl0.autocomplete = "off";
  inputEl0.placeholder = "اكتب رسالتك...";
  var sendEl0 = document.createElement("button");
  sendEl0.id = "aicb-send";
  sendEl0.type = "submit";
  sendEl0.textContent = "إرسال";
  formEl0.appendChild(inputEl0);
  formEl0.appendChild(sendEl0);
  panel.appendChild(headEl);
  panel.appendChild(document.createElement("div")).id = "aicb-msgs";

  // شريط الأسئلة المقترحة — مخفي لحد ما يجي إعدادها من السيرفر
  var suggestionsWrap = document.createElement("div");
  suggestionsWrap.id = "aicb-suggestions";
  suggestionsWrap.style.display = "none";
  suggestionsWrap.style.flexWrap = "wrap";
  suggestionsWrap.style.gap = "6px";
  suggestionsWrap.style.padding = "8px 12px 0";
  suggestionsWrap.style.background = "#fff";
  panel.appendChild(suggestionsWrap);

  panel.appendChild(formEl0);
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", TITLE);
  document.body.appendChild(panel);

  var msgsEl = panel.querySelector("#aicb-msgs");
  msgsEl.setAttribute("aria-live", "polite"); // قارئات الشاشة تعلن الردود الجديدة
  var formEl = panel.querySelector("#aicb-form");
  var inputEl = panel.querySelector("#aicb-input");
  var sendEl = panel.querySelector("#aicb-send");

  function addMessage(role, text) {
    var el = document.createElement("div");
    el.className = "aicb-msg " + role;
    el.textContent = text;
    msgsEl.appendChild(el);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function openPanel() {
    panel.classList.add("open");
    if (msgsEl.children.length === 0) {
      addMessage("bot", "أهلًا! كيف فيني ساعدك اليوم؟");
      loadWidgetConfig(); // مرة وحدة بأول فتح — best effort، الفشل صامت
    }
    setTimeout(function () { inputEl.focus(); }, 50);
  }

  // تخصيص اختياري من السيرفر: لون الهوية + عنوان بديل + أسئلة مقترحة كأزرار.
  // أي شي ما يرجع من السيرفر بيضل من وسوم التضمين (data-title إلخ).
  var configLoaded = false;
  function loadWidgetConfig() {
    if (configLoaded) return;
    configLoaded = true;
    fetch(SERVER + "/api/v1/widget-config/" + encodeURIComponent(CLIENT_ID))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        if (!cfg) return;

        if (cfg.title && headEl.textContent !== cfg.title) {
          headEl.textContent = cfg.title;
        }

        if (cfg.accentColor && /^#[0-9a-fA-F]{3,8}$/.test(cfg.accentColor)) {
          var accent = cfg.accentColor;
          bubble.style.background = accent;
          headEl.style.background = accent;
          sendEl.style.background = accent;
          var styleFor = document.createElement("style");
          styleFor.textContent =
            ".aicb-msg.user{background:" + accent + " !important;}";
          document.head.appendChild(styleFor);
        }

        if (cfg.suggestions && cfg.suggestions.length && !suggestionsWrap.hasChildNodes()) {
          for (var i = 0; i < cfg.suggestions.length && i < 4; i++) {
            var chip = document.createElement("button");
            chip.type = "button";
            chip.className = "aicb-chip";
            chip.textContent = cfg.suggestions[i];
            chip.addEventListener("click", function () {
              inputEl.value = this.textContent;
              formEl.dispatchEvent(new Event("submit", { cancelable: true }));
              suggestionsWrap.style.display = "none"; // مرة وحدة تكفي
            });
            suggestionsWrap.appendChild(chip);
          }
          if (suggestionsWrap.hasChildNodes()) suggestionsWrap.style.display = "flex";
        }
      })
      .catch(function () { /* صامت */ });
  }

  function closePanel() {
    panel.classList.remove("open");
    bubble.focus();
  }

  bubble.addEventListener("click", function () {
    if (panel.classList.contains("open")) closePanel();
    else openPanel();
  });

  // Esc للإغلاق — سلوك قياسي للحوارات
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && panel.classList.contains("open")) closePanel();
  });

  formEl.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = inputEl.value.trim();
    if (!text) return;

    addMessage("user", text);
    inputEl.value = "";
    sendEl.disabled = true;

    var headers = { "Content-Type": "application/json" };
    if (PUBLIC_KEY) {
      headers["Authorization"] = "Bearer " + PUBLIC_KEY;
    } else if (WIDGET_KEY) {
      headers["x-widget-key"] = WIDGET_KEY; // وضع قديم — راجع تعليقات data-widget-key فوق
    }

    var canStream = typeof window.ReadableStream !== "undefined" && fetch && window.AbortController;
    if (canStream) {
      headers["Accept"] = "text/event-stream";
      streamReply(text, headers);
    } else {
      jsonReply(text, headers);
    }
  });

  // المسار الحديث: بث SSE — الرد بيظهر تدريجيًا، والحدث "done" بيحمل النص النهائي النظيف.
  // أي فشل (سيرفر قديم/شبكة) بينزل للمسار العادي JSON.
  function streamReply(text, headers) {
    var botEl = addStreamingMessage();

    fetch(SERVER + "/api/v1/chat/" + encodeURIComponent(CLIENT_ID), {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ message: text, sessionId: sessionId }),
    })
      .then(function (r) {
        if (!r.ok || !(r.headers.get("content-type") || "").includes("text/event-stream")) {
          // السيرفر رد JSON (خطأ أو streaming مطفي) — نقرأه كعادي
          return r.json().then(function (data) {
            finishMessage(botEl, data.reply || errorTextOf(data) || null);
          });
        }

        var reader = r.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";

        function pump() {
          return reader.read().then(function (result) {
            if (result.done) {
              if (!botEl.finalized) finishMessage(botEl, null);
              return;
            }
            buffer += decoder.decode(result.value, { stream: true });
            var lines = buffer.split("\n");
            buffer = lines.pop();
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i].trim();
              if (line.indexOf("data:") !== 0) continue;
              try {
                var evt = JSON.parse(line.slice(5));
                if (evt.type === "delta" && evt.text) appendToMessage(botEl, evt.text);
                if (evt.type === "done") finishMessage(botEl, evt.reply || null);
              } catch (_) { /* سطر ناقص — نتجاهله */ }
            }
            return pump();
          });
        }

        return pump().catch(function () { finishMessage(botEl, null); });
      })
      .catch(function () { finishMessage(botEl, null); })
      .then(function () {}, function () {})
      .finally(function () { sendEl.disabled = false; });
  }

  // المسار الاحتياطي: طلب JSON واحد زي قبل
  function jsonReply(text, headers) {
    fetch(SERVER + "/api/v1/chat/" + encodeURIComponent(CLIENT_ID), {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ message: text, sessionId: sessionId }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        addMessage("bot", data.reply || errorTextOf(data) || "صار خطأ، جرب كمان شوي");
      })
      .catch(function () {
        addMessage("bot", "ما قدرنا نوصل للسيرفر، جرب كمان شوي.");
      })
      .finally(function () {
        sendEl.disabled = false;
      });
  }

  function errorTextOf(data) {
    return data.error && (data.error.message || data.error);
  }

  // فقاعة رد بتتحدث تدريجياً أثناء البث
  function addStreamingMessage() {
    var el = document.createElement("div");
    el.className = "aicb-msg bot";
    el.textContent = "";
    msgsEl.appendChild(el);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    el._text = "";
    el._finalized = false;
    return el;
  }

  function appendToMessage(el, chunk) {
    if (el._finalized) return;
    el._text += chunk;
    el.textContent = el._text;
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // النص النهائي من السيرفر بيعتمد دائماً (بيعيد رسم الفقاعة بالنص النظيف بعد ماركر التصعيد).
  // لو ما وصلك done بنص (انقطاع)، نخلي يلي تجمع مع رسالة تنويه خفيفة.
  function finishMessage(el, finalText) {
    if (el._finalized) return;
    el._finalized = true;
    if (finalText) {
      el.textContent = finalText;
    } else if (!el._text) {
      el.textContent = "ما قدرنا نوصل للسيرفر، جرب كمان شوي.";
    }
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
})();
