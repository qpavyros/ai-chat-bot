# HANDOFF — الجلسة الكبرى 2026-08-22 → 2026-08-23

توثيق شامل لكل ما تم إنجازه خلال هالجلسة: خطة تحسين كاملة، ميزات جديدة، نشر إنتاجي، حوادث ومعالجات، وقرارات مؤجلة. **هاد الملف هو الذاكرة الرسمية للجلسة** — أي جلسة قادمة تبدأ من هنا.

---

## 0) ⚡ حالة اللحظة الحالية (اقرأها أولاً)

| البند | الحالة |
|-------|--------|
| الإنتاج `app.abiad.systems` | ✅ شغّال ومستقر (pm2 online، health ok) على نسخة تشمل: تحسينات v3 للمبيعات + سياسة رسالة التحويل + كل ميزات الصوت/التذكير/القنوات |
| **معلّق على قرص السيرفر بدون restart** | ٥ ملفات: `tutorial.html`, `tutorial.pdf`, `admin-dashboard.html` (مفاتيح الأدمن الجديدة), `clientConfigSchema.js` (+orders whitelist), `server.js` (مسار /tutorial) — **كلها إضافية وآمنة حتى مع restart مفاجئ** |
| خطوة النشر المتبقية | عند موافقة عصام ("انشر"): `pm2 restart ai-chat-bot` + تحقق `/tutorial` و`/public/tutorial.pdf` و`/admin` |
| سيرفر تجربة محلي | شغّال حالياً على `http://localhost:4006` (PID موجود بالعمليات) — للتجربة الحية قبل النشر |
| نسخة احتياطية قبل أول نشر | `/root/backup-pre-deploy-20260823.tar.gz` (data + src/clients + .env) |

---

## 1) الجدول الزمني الكامل

1. **تحليل المشروع + خطة تحسين** (`docs/improvement-plan-2026-08-22.md`) — فحص شامل بأدوات استكشاف متوازية، ثم تنفيذ المراحل 0→4 كاملة عبر عدة جلسات متتالية.
2. **نشر أولي على VPS** — tar-over-ssh، npm install، restart، تحقق حي.
3. **اكتشاف انحراف #1**: ميزة `scriptedReplies` كانت موجودة بسيرفر فقط → تبيّن لاحقاً أنها **محذوفة يدوياً بقصد من عصام** → مسح كامل الآثار (انظر قسم 4).
4. **الميزات الجديدة — النصف الأول**: محرك محادثات موحد، صوتي Groq، تذكيرات، تلغرام.
5. **الميزات الجديدة — النصف الثاني**: ديسكورد، سجل وتصدير المحادثات، تخصيص الودجت، رد خارج الدوام، إحصائيات التكلفة.
6. **تحليل سعة 100 مستخدم** — فحص حي للسيرفر (32GB RAM!) وحدود Groq.
7. **بحث المكالمات الهاتفية** → قرار عصام: **مؤجلة للمستقبل** (بحث كامل محفوظ بقسم 14 من ملف الخطة).
8. **تهيئة الموقع الأساسي** — توحيد مدة التجربة على ٧ أيام بكل المواضع (landing + config fallback + .env.example + README)، وإزالة مسار /world النموذجي؟ (لا — أُزيل فقط /docs؛ /world بقي كما هو).
9. **سياسة رسالة التحويل الموحدة** — أي عطل داخلي: الزبون يوصله "تم تحويل طلبك..." بدون ذكر سبب تقني أبداً.
10. **دليل البيع والإقناع**: مراجعة v1 → كتابة v2 محسّنة → ظهور v3 مصححة من جلسة موازية → **تحقق ميداني أكّد ادعاءاتها ضد الكود الحي** (بما فيها اكتشاف أن v2 كان سيسبب SyntaxError) → تنفيذ دمج v3 فعلياً ونشره.
11. **تدقيق تحكم الأدمن** — اكتشاف ٥ مفاتيح ناقصة بلوحة الأدمن وسدها جميعاً.
12. **دليل الاستخدام الكامل** (`/tutorial` HTML + PDF مولّد عبر Edge headless) — مرفوع بالسيرفر بانتظار restart.
13. **تشغيل بيئة تجربة محلية** على المنفذ 4006 + سكربت تدقيق آلي نجح بكل بنوده.

---

## 2) المنفذ والمنشور على الإنتاج (ملخص طبقة-طبقة)

### 2.1 أمان (المرحلة 0)
- تحقق توقيع `X-Hub-Signature-256` إلزامي على ويبهوك واتساب (**فشل مغلق** — بدون META_APP_SECRET بينرفض كل شي). مقارنة GET handshake timing-safe أيضاً.
- إزالة `/docs` العام (كان يكشف خطط داخلية).
- `assertValidClientId` على كل روترات الأدمن (حماية path traversal بالقراءات).
- whitelist حقول config بدل الدمج الأعمى (`pickClientConfigFields`).
- rate limit على `/auth/session` (20/15د لكل IP).
- إصلاح snippet `manage-keys.js` (كان يطبع اسم attribute غلط).
- مقارنة كلمة سر الأدمن timing-safe عبر SHA256 للطرفين.

### 2.2 موثوقية (المرحلة 1)
- **لا فقدان رسائل واتساب**: دورة claim/markProcessed/releaseClaim — الفشل بيحرر العلامة حتى Meta يعيد الإرسال.
- `asyncHandler` middleware + **معالج أخطاء مركزي** بدون تسريب err.message.
- أقفال موحدة: حذف البوت داخل `withClientLock` + audit log • `activateClient`/`replaceKnowledge` مؤمنة.
- كاش registry ببصمة mtime (انتهى القراءة الكاملة للقرص بكل رسالة؛ الاختبار أثبت إعادة البناء عند التغيير).
- سجل JSONL بسقف تلقائي `jsonlLog.js` (escalations + audit لا ينموان للأبد).
- تنظيف بقايا smoke-test + إصلاح الرد المختلق "تمام خلص طلبك".

### 2.3 جودة (المرحلة 2)
- حذف الكود الميت: بوابة portal كاملة + portalAuth + nodemailer/config.smtp + exports ميتة.
- **24 اختبار وحدة** (`npm test` عبر node --test، مجانية): schema، safeWrite ids، adminAuth، knowledge retrieval، appointments byDay، jsonlLog، reminders، voice caps.
- `.env.example` أعيد بناؤه بالكامل (كان سيرفر جديد ما بينقلع) + README تصحيحات جوهرية.
- GitHub Actions CI (syntax + unit tests).
- توحيد cookies/sessions بموديل مشترك + بوابة الرسائل `messageGate.js` موحدة بين القناتين.

### 2.4 أداء وتجربة (المرحلة 3)
- **Streaming للودجت** (SSE مع تجميع tool_calls من deltas وfallback تلقائي) — مفعّل افتراضياً (`WIDGET_STREAMING`).
- **استرجاع معجمي للمعرفة الكبيرة** `knowledgeRetrieval.js`: تقسيم chunks + تطبيع عربي (همزات/تشكيل/تاء مربوطة) — ≤12k حرف تنحقن كاملة كما قبل.
- العد بعد الكاش: ردود الكاش وكلمات التصعيد **لا تستهلك السقوف**.
- Tailwind بناء محلي (`npm run build:css`) بدل CDN التطويرية — `src/public/tailwind.css`.
- إصلاحات فرونت: شريط موبايل بالداشبورد (زر الخروج reachable)، innerHTML→textContent، روابط ميتة، Esc/focus بالودجت.

### 2.5 المنتج (المرحلة 4)
- تقارير لكل بوت بصفحة الإدارة (زبائن/نشاط/تصعيدات/أكثر الأسئلة).

---

## 3) الميزات الجديدة الكبرى (كلها منشورة)

### 3.1 🧠 محرك المحادثات الموحد `conversationEngine.js`
كل القنوات (ويب/واتساب/تلغرام/ديسكورد) بتمر من نقطة واحدة: تصعيد معلق → كلمات → كاش → عدادات → DeepSeek(+stream اختياري) → حفظ → تصعيد.

### 3.2 🎤 الرسائل الصوتية (واتساب)
`transcribe.js` (متوافق OpenAI — **Groq whisper-large-v3-turbo** $0.04/ساعة) + `whatsapp.downloadMedia`. بدون مفتاح = رسالة مهذبة. **سقوف دقائق شهرياً**: Starter ١٥ / Growth ٤٥ / Pro ١٢٠ / تجربة ٥ (`TRIAL_VOICE_MINUTES`). الفحص **قبل** تنزيل الميديا (من duration تبع Meta) حتى ما نصرف على طلب مرفوض. عداد ثواني دائم بـFirestore. مفتاح تشغيل لكل عميل `voice.enabled`.

### 3.3 🔔 تذكير المواعيد `appointmentReminders.js`
حلقة كل ٥ دقائق. منطق نقي مختبر: كل عتبة ساعات "بتملك" نافذتها (24h بين 2–24، 2h بين 0–2). إرسال: قالب Meta معتمد (`templateName`) أو نص حر خلال نافذة خدمة 24h (فحص lastMessageAt). التعليم على سجل الموعد داخل القفل.

### 3.4 ✈️ قناة Telegram
`telegram.js` + `/webhook/telegram/:clientId` بسرّ تحقق (`X-Telegram-Bot-Api-Secret-Token` يتولد تلقائياً). تسجيل تلقائي عند الإقلاع وبعد حفظ التوكن من الأدمن. حقل `telegramBotToken` بلوحة الأدمن.

### 3.5 🎮 قناة Discord
Gateway خام بـ`ws` (`discordGateway.js`): DM فقط، heartbeat، backoff أسي، مدير مزامنة `syncAll()` عند الإقلاع وبعد تغيير توكن الأدمن. **يتطلب Message Content Intent** من بوابة المطورين لكل بوت. حقل `discordBotToken`.

### 3.6 📄 سجل وتصدير المحادثات
نسخة كاملة دائمة: `data/<id>/transcripts/<userId>.jsonl` (سقف 2000 تبادل) تُكتب داخل قفل العميل. Endpoints: قائمة/عرض محادثة/**تصدير Excel** (ورقتان: ملخص + كامل). واجهة قسم "المحادثات" بصفحة إدارة البوت مع مودال عرض.

### 3.7 🎨 تخصيص الودجت
`widget.accentColor/title/suggestions[]` → endpoint عام محمي `/api/v1/widget-config/:clientId` → الودجت يجيبهم بأول فتح (fallback صامت) + chips أسئلة مقترحة + حقول بلوحة الأدمن (color picker).

### 3.8 🌙 رد خارج ساعات الدوام
`businessHours.js` مشترك (صيغة byDay نفسها). داخل المحرك بعد الكاش وقبل LLM — وكلمات التصعيد **تتجاوزه عمداً**. checkbox + وقتين بلوحة الأدمن.

### 3.9 📊 إحصائيات الأدمن
`stats.js` عدادات يومية دائمة (flush كل 30 ثانية، احتفاظ 90 يوم) + التقاط usage فعلي من DeepSeek حتى بالبث (`stream_options.include_usage`) + رسم 14 يوم + تقدير تكلفة الشهر (`DEEPSEEK_PRICE_*_PER_M`, افتراضي 0.27/1.10).

### 3.10 💼 وضع البيع (v3 مدموج)
استبدال كامل لـ`SALES_DIRECTIVE` القديمة (اللي كانت شغالة غير مشروط أصلاً — اكتشاف مهم) بنسخة DISC-lite + توقف فوري عند الجهوزية + ذروة/نهاية + اختبار أخلاقي، مع شرط `client.salesMode !== false` وصندوق بلوحة الأدمن، وإعادة مثالي التوضيح والـupsell من النسخة القديمة. المرجع: `docs/sales-persuasion-playbook-v3.md` + مراجعة التحقق `...-v3-review.md`.

### 3.11 ⚡ باقات شحن الرصيد
`credits.js`: small 100/$8 • medium 300/$21 (أسعار أعلى عمداً من سعر الباقات). زر بلوحة الأدمن يسجل paymentHistory(type:"topup") + يرفع `topUpCreditsRemaining`. الاستهلاك overflow بعد السقف الشهري/التجريبي فقط (الحد اليومي لا يُتجازى به). ظاهر بصاحب البوت وعلى الـlanding.

### 3.12 🛡️ سياسة رسالة التحويل الموحدة
`handoff.buildServiceIssueReply()` — أي عطل (توكنز DeepSeek، Groq، سقوف، فشل صوتي، استثناء عام): الزبون يستلم *"عذرًا، ما قدرنا نكمل خدمتك بهاللظة. تم تحويل طلبك لفريقنا..."* **بدون ذكر سبب تقني**، بينما السبب الحقيقي كامل باللوج. مستثنى الوحيد: تعطيل الصوت من صاحب البوت (رسالة إرشادية مقصودة).

---

## 4) 🚨 الحوادث والمعالجات (شفافية كاملة)

1. **انحراف كود خارج الجلسات — مرتان**: `scriptedReplies` (سيرفر فقط) ثم `SALES_DIRECTIVE` (محلي+سيرفر). الأولى تبيّن أنها حذف مقصود، الثانية اكتشفت بوقتها قبل أن تكسر خطة v2. **الدرس المسجل:** أي تعديل يدوي/موازٍ لازم commit أو سطر توثيق فوري.
2. **حادثة ترميز landing**: استبدال Tailwind عبر PowerShell كسر العربية (قراءة CP1252/كتابة UTF8+BOM) → **استعادة كاملة byte-by-byte** بخوارزمية جدول CP1252 عكسي، وتحقق صفر mojibake.
3. **حادثة scriptedReplies**: نسخة احتياطي الأولى لم تشمل src/ → اكتشفنا أرشيفات السيرفر `backups/revert-doctor-bot...` واستعدنا الملفات → ثم عصام وضّح أنها **حذف مقصود** → مسح نهائي شامل (كود + PDF مذكرة + أرشفتا scripted/doctor + ملاحظة دائمة بالخطة "لا تُستعاد أبداً").
4. **SSH timeouts متكررة** أثناء النشر (kex timeout) — عولجت بإعادة المحاولة بعد انتظار؛ لا ضرر.

---

## 5) 📁 ملفات ووثائق جديدة/محدثة

- **وثائق:** `improvement-plan-2026-08-22.md` (الخطة + أقسام 8–14 حالة التنفيذ والمؤجلات) • `sales-persuasion-playbook-v2/v3` + تقريرا مراجعة v2-review/v3-review • هذا الملف.
- **خدمات جديدة:** conversationEngine, messageGate, credits, transcribe, telegram, discordGateway, appointmentReminders, knowledgeRetrieval, businessHours, stats, jsonlLog, asyncHandler, sessionCookies.
- **روترات:** telegramWebhook جديد؛ webChat/webhook/botManagement/signup/admin/userAuth/dashboard كلها أعيد هيكلتها.
- **صفحات:** tutorial.html (جديد) + tutorial.pdf (مولّد Edge headless 1.7MB) + admin-dashboard (حقول ومفاتيح جديدة كثيرة) + bot-manage (تقارير + محادثات + صوت + رصيد) + dashboard.html (موبايل) + landing (أسعار صوت + شحن + توحيد ٧ أيام).
- **سكربتات:** `scripts/test-voice.js` (`npm run test:voice` — توليد صوت Windows → Groq → طباعة النص) • `scripts/groq-limits.js` • `scripts/admin-audit-local.js` (تدقيق دخول/مفاتيح/حفظ/استمرارية محلياً).
- **CI:** `.github/workflows/ci.yml`.

## 6) تغييرات npm scripts

```bash
npm test          # 34 اختبار وحدة (node --test) — مجاني وسريع
npm run test:smoke   # تكاملي يحتاج سيرفر حي (مدفوع)
npm run test:voice   # تجربة Groq حية بصوت مولّد محلياً
npm run build:css    # tailwind محلي
```

---

## 7) 🔐 حالة الأسرار (بدون أي قيم هنا!)

| المتغير | المحلي | السيرفر | ملاحظة |
|---------|--------|---------|--------|
| DEEPSEEK_API_KEY | ✓ | ✓ | — |
| WHATSAPP_TOKEN/PHONE/VERIFY | ✓ | ✓ | — |
| META_APP_ID/SECRET/CONFIG_ID | ✓(32ح) | ✓ **مؤكد موجود** | إجباري للويبهوك الآن |
| TRANSCRIBE_API_KEY (Groq) | ✓(56ح) | ✅ **أُضيف هذه الجلسة عبر ssh stdin** | model=turbo |
| TRIAL_DAYS | 7 | 7 | توحيد كامل مع الموقع |
| FIREBASE creds | ✓ | ✓ (ملف credentials على السيرفر لم يُلمس) | — |
| ⚠️ Virtualizor + Google keys | **لم تُدرّ بعد** | — | بند مفتوح عليك (تسربت سابقاً) |

## 8) 💾 نسخ السيرفر الموجودة

- `/root/backup-pre-deploy-20260823.tar.gz` — data + src/clients + .env (قبل أول نشر لهالجلسة)
- `/opt/ai-chat-bot/backups/fraud-guard-predeploy-*` و`public-*` (تاريخية غير متعلقة بالمحذوف)
- *(أرشيفا scripted-reply وdoctor-bot انمسحوا بطلب صريح)*

---

## 9) 🗂️ المؤجَّل عمداً (قرارات موثقة بالخطة)

| الفكرة | السبب/الحالة |
|--------|---------------|
| المكالمات الهاتفية AI (PSTN/واتساب) | مؤجلة بعصام — بحث كامل + مساران جاهزان بقسم 14 |
| WhatsApp Coexistence / Tech Provider | يحتاج تأسيس شركة رسمي |
| تحصيل آلي (بوابة دفع) | الشحن حالياً يدوي بالأدمن؛ الأتمتة عند نمو العملاء |
| Messenger/Instagram/X | مراجعة Meta / تسعير X المدفوع |
| RAG دلالي كامل (embeddings) | الخطوة بعد الاسترجاع المعجمي الحالي |
| Redis + تعدد instances | عند تجاوز ~50 شركة |

## 10) ✅ المهام المعلّقة على عصام

1. **قرار نشر الملفات الخمس المعلقة** → كلمة "انشر" = restart + تحقق (tutorial/PDF/admin/health).
2. **تجربة حية**: رسالة نصية + صوتية لأحد البوتات + مراجعة `/tutorial` وPDF.
3. **تدوير مفاتيح Virtualizor + Google service account** (متأخر عن موعده).
4. (اختياري) تفعيل فوترة Groq قبل ضغط الاستخدام الصوتي الحقيقي — $0.04/ساعة.
5. (عند حاجة عميل) توكن تلغرام/ديسكورد لكل عميل عبر BotFather/بوابة ديفلوبرز + Intent.

## 11) 🔧 أوامر مرجعية سريعة

```bash
# محلياً
npm test && npm run build:css     # فحص + css
npm run test:voice                # تجربة Groq حية
node scripts/groq-limits.js       # فحص المفتاح والنماذج
$env:PORT="4006"; node src/server.js   # بيئة تجربة محلية

# سيرفر
ssh -i ~/.ssh/vps_backup_deploy root@185.91.127.214
cd /opt/ai-chat-bot && pm2 restart ai-chat-bot && pm2 logs --lines 30 --nostream
curl -s https://app.abiad.systems/health
```

## 12) روابط الإنتاج الجاهزة

| الرابط | الوصف |
|--------|--------|
| `https://app.abiad.systems/` | صفحة الهبوط (باقات + صوت + شحن) |
| `/auth` • `/dashboard` • `/public/signup` • `/public/onboard` | رحلة العميل |
| **`/tutorial`** • **`/public/tutorial.pdf`** | 🆕 الدليل الكامل (بانتظار restart ليظهر المسار النظيف؛ نسخة /public/tutorial.html تعمل حالياً) |
| `/privacy` `/terms` `/cookies` | قانوني |
| `/admin` | لوحة المشغّل (كل مفاتيح الميزات الـ14+) |
