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
    "background:#1f6f5c;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;" +
    "box-shadow:0 6px 18px rgba(0,0,0,.22);z-index:999999;font-size:26px;border:none;}" +
    "#aicb-panel{position:fixed;bottom:86px;inset-inline-end:20px;width:340px;max-width:92vw;height:460px;" +
    "max-height:75vh;background:#fff;border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.28);" +
    "display:none;flex-direction:column;overflow:hidden;z-index:999999;font-family:'Segoe UI',Tahoma,Arial,sans-serif;" +
    "direction:rtl;}" +
    "#aicb-panel.open{display:flex;}" +
    "#aicb-head{background:#1f6f5c;color:#fff;padding:14px 16px;font-weight:600;font-size:15px;}" +
    "#aicb-msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f4f6f5;}" +
    ".aicb-msg{max-width:82%;padding:9px 12px;border-radius:10px;font-size:14px;line-height:1.6;white-space:pre-wrap;}" +
    ".aicb-msg.user{align-self:flex-end;background:#1f6f5c;color:#fff;border-bottom-right-radius:2px;}" +
    ".aicb-msg.bot{align-self:flex-start;background:#fff;color:#1a1a1a;border:1px solid #e3e6e5;border-bottom-left-radius:2px;}" +
    "#aicb-form{display:flex;border-top:1px solid #e3e6e5;padding:8px;gap:8px;background:#fff;}" +
    "#aicb-input{flex:1;border:1px solid #d8dbda;border-radius:8px;padding:9px 10px;font-size:14px;font-family:inherit;}" +
    "#aicb-send{background:#1f6f5c;color:#fff;border:none;border-radius:8px;padding:0 14px;font-size:14px;cursor:pointer;}" +
    "#aicb-send:disabled{opacity:.6;cursor:default;}";

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
  panel.innerHTML =
    '<div id="aicb-head">' + TITLE + "</div>" +
    '<div id="aicb-msgs"></div>' +
    '<form id="aicb-form">' +
    '<input id="aicb-input" autocomplete="off" placeholder="اكتب رسالتك..." />' +
    '<button id="aicb-send" type="submit">إرسال</button>' +
    "</form>";
  document.body.appendChild(panel);

  var msgsEl = panel.querySelector("#aicb-msgs");
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

  bubble.addEventListener("click", function () {
    panel.classList.toggle("open");
    if (panel.classList.contains("open") && msgsEl.children.length === 0) {
      addMessage("bot", "أهلًا! كيف فيني ساعدك اليوم؟");
    }
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

    fetch(SERVER + "/api/v1/chat/" + encodeURIComponent(CLIENT_ID), {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ message: text, sessionId: sessionId }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var errorText = data.error && (data.error.message || data.error);
        addMessage("bot", data.reply || errorText || "صار خطأ، جرب كمان شوي");
      })
      .catch(function () {
        addMessage("bot", "ما قدرنا نوصل للسيرفر، جرب كمان شوي.");
      })
      .finally(function () {
        sendEl.disabled = false;
      });
  });
})();
