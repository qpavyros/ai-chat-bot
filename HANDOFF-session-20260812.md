# Handoff — جلسة 2026-08-12 (طويلة، متعددة المواضيع)

اقرأ هالملف بالكامل أول شي بمحادثة جديدة قبل أي شي تاني. المستخدم اسمه **عصام** (مذكّر،
خاطبه هيك دايماً — صار لبس بمنتصف الجلسة وصحّحلي).

---

## 1. ملخص شو صار هالجلسة (بالترتيب)

1. **تحليل شامل للمشروع** (بنية، أمان، تخزين بيانات) — تفاصيله بذاكرة `ai-customer-service-venture`.
2. **خطة ترويج** عبر Fable 5 (soft launch، رسائل شخصية، إلخ).
3. **قرار معماري:** كل عميل واتساب لازم WABA (Business Portfolio) خاص فيه، مش portfolio
   مشترك — بسبب حدود Meta على مستوى الـportfolio مش الرقم. موثّق بذاكرة
   `ai-customer-service-whatsapp-architecture`.
4. **بوابة العميل (Client Portal)** — بُرمجت جزء أول عبر antigravity (برومت جهّزته أنا)،
   وتحققت منها حي (عزل multi-tenant، timing-safe auth، dummy hash ضد enumeration).
   Phase 2 (تعديل knowledge.md ذاتياً) نُفّذت ونجحت الاختبارات كمان.
5. **دفعة تحسينات نفّذتها مباشرة أنا** (بدون antigravity، بطلب صريح من المستخدم "ساوي أي
   شي ما يحتاجني أونلاين"): تصعيد بكشف استياء، Dashboard تحليلات، زر دفعة +30 يوم، تجربة
   محادثة من لوحة الأدمن، تصدير Excel من البوابة، إيقاف البوت من البوابة، تنبيه استهلاك
   غير معتاد. كل واحدة اتحققت حية بالسيرفر شغّال + متصفح.
6. **نشر VPS (185.91.127.214):** حُلّت مشكلة SSH العالقة من قبل (كانت محتاجة استدعاء
   Virtualizor Enduser API لتطبيق مفتاح SSH فعلياً + **Stop/Start كامل مش Restart عادي**).
   التفاصيل الكاملة بـ`HANDOFF-backup-sheets.md` قسم 11. نُشر الكود مرتين (دفعة أولى:
   بوابة العميل+التحسينات، دفعة تانية: تعديلات مجلس التسعير).
7. **مجلس LLM (`/llm-council`) لتحديد التسعير** — قرار نهائي: 3 باقات ($29/$59/$99)،
   برنامج إحالة (شهرين بعد دفعتين متتاليتين)، تجربة مجانية 14 يوم/120 رسالة. التقرير
   الكامل: `council-report-20260812.html` (Artifact منشور) و`council-transcript-20260812.md`.
8. **تطبيق قرار المجلس بالكود** — `client.tier` (starter/growth/pro، **حقل منفصل تماماً
   عن `client.plan`** يلي معناه trial/manual — ما تخلطهم!)، إنفاذ فعلي (منع widget لـStarter،
   سقف رسائل شهري)، نظام إحالة كامل (referralCode، paymentHistory، مكافأة يدوية بعد دفعتين
   متتاليتين). اتحقق منه حي بسيناريو كامل، ونُشر عالسيرفر.
9. **WhatsApp Embedded Signup** — البند الأخير المؤجّل من الأول. عصام جهّز App ID
   (`4138100919825641`) وConfiguration ID (`1395298849142275`) عبر Facebook Login for
   Business (System-user token, Never expires). نفّذت:
   - `config.meta` بـ`config.js`
   - `GET /api/v1/signup/embedded-signup-config` (عام، بدون سر)
   - `POST /api/v1/signup/connect-whatsapp` بـ`signup.js`
   - قسم UI بـ`onboard.html` (Facebook JS SDK + FB.login + postMessage listener)

---

## 2. آخر شي صار بالضبط (مهم جداً)

عصام كان **يختبر حي** تدفق ربط واتساب بمتصفحه الشخصي (أنا ما بقدر أضغط popup Meta
بنفسي). وصل لعمق حقيقي جداً بالتدفق:
- تسجيل دخول فيسبوك ✅
- شاشة اختيار/إضافة رقم واتساب ✅ (وصل تدفق Meta الحقيقي، يعني App ID/Config ID صحيحين)
- جرّب رقم (`79165355`) — طلع "مسجّل بحساب واتساب بزنس حالي" — **حذف الحساب القديم عليه بنفسه**
  (تأكد ما كان فيه شي مهم)
- رجع يجرّب — طلعتله شاشة **"الرابط غير صالح"** بصفحة onboard.html

**اكتشفت وصلّحت باگ حقيقي وقتها:** `signups.getPendingBySignupToken()` كانت تقتل التوكن
**فوراً** لحظة `markCompleted()` (يعني لحظة "بوتك جاهز 🎉")، فأي إعادة تحميل صفحة (وهاد
بالضبط صار — popup فيسبوك عمل full-page redirect بدل postMessage صافي بمتصفح عصام) كانت
ترجّع 401 من `/signup/status` → "الرابط غير صالح".

**الإصلاح:** حوّلت `requireSignupToken` من middleware ثابتة لـfactory function
`requireSignupToken({ allowCompleted })`:
- `/signup/status` و`/signup/connect-whatsapp` → `allowCompleted: true` (لازم تشتغل بعد
  التفعيل، التوكن بيضل صالح لحد انتهاءه الطبيعي 24 ساعة)
- `/signup/knowledge`، `/signup/preview-chat`، `/signup/activate` → تبقى صارمة (بلا
  `allowCompleted`) — ما بدنا حدا يقدر يستبدل معرفة بوت شغّال بتوكن قديم

**اتحقق من الإصلاح حي** بنفس توكن عصام الحقيقي (`jbG4kx4-Lluul8urmB-V4UjT29QsMIvO`،
clientId=`embedded-signup`): `/signup/status` رجعت 200 صح، `/signup/knowledge` ضلت
403/401 صح (زي ما المفروض).

**آخر رسالة مني لعصام:** طلبت منه يعمل refresh لنفس رابط onboard.html بمتصفحه ويجرب
"اربط واتساب بزنس" من جديد. **ما وصلني رد بعد** — هاي بالضبط النقطة يلي وقفنا فيها.

---

## 3. الخطوة الجاية بالضبط

1. اسأل عصام: شو صار لما عمل refresh وجرّب الربط تاني؟ نجح ولا لسا في مشكلة؟
2. لو نجح: أكّد إن `whatsappPhoneNumberId`/`whatsappBusinessAccountId` انكتبوا صح بـ
   `src/clients/embedded-signup/config.json` المحلي، ونظّف عميل الاختبار (`embedded-signup`)
   من `src/clients/` و`data/` بعد التأكيد.
3. **مهم: هالإصلاح (`requireSignupToken` factory) لسا مش منشور عالـVPS** — بعد ما يتأكد
   الحل شغّال محلياً، انشره (نفس أسلوب النشر المستخدم قبل: `tar` عبر SSH لملفات
   `src/routes/signup.js` و`src/services/signups.js` و`src/public/onboard.html`، بعدين
   `pm2 restart ai-chat-bot`).
4. **App Secret لسا بس بـ`.env` المحلي** — لازم عصام يضيفه لـ`.env` البعيد كمان (نفس
   الطريقة: SSH يدوي، ما تمر القيمة فيني بالمحادثة) قبل ما تشتغل الميزة عالإنتاج.
5. بعد النشر، أفضل اختبار نهائي: عميل حقيقي أو عصام نفسه يجرب الربط عالسيرفر الحي
   (مش localhost) قبل ما نعتبر البند مقفول 100%.

---

## 4. معلومات وصول (SSH/VPS) — تذكير سريع

- VPS: `185.91.127.214`، hostname `vps`، LXC عبر Virtualizor (بانل Kinguin)
- SSH: `ssh -i ~/.ssh/vps_backup_deploy root@185.91.127.214` (المفتاح شغّال، اتحل من الجلسة
  يلي قبل هاي — تفاصيل كاملة بـ`HANDOFF-backup-sheets.md` قسم 11)
- التطبيق منشور بـ`/opt/ai-chat-bot`، عبر **pm2** (process name `ai-chat-bot`)، nginx
  بروكسي على **8443** (مش 443!) و80، SSL عبر acme.sh، دومين `185-91-127-214.sslip.io`
- ⚠️ **عملاء حقيقيين شغالين فعلياً عالسيرفر** (`example-client`, `client-ec1436` "أيوب
  كمبيوتر") — أي نشر لازم يتفادى لمس `data/` أو `src/clients/*` البعيدة
- ⚠️ مفتاح/كلمة سر Virtualizor API انكشفوا بالمحادثة (استُخدموا فعلياً بنجاح) — يستاهلوا
  تدوير (rotate) من البانل، لسا ما تم.

---

## 5. طابور المهام — الحالة النهائية

| # | البند | الحالة |
|---|---|---|
| 1 | توثيق env vars + nodemon.json | ✅ منجز ومنشور |
| 2 | بوابة العميل Phase 2 (تعديل معرفة ذاتي) | ✅ منجز ومنشور |
| 3 | Embedded Signup | 🟡 قيد الاختبار الحي معك، باگ اتصلّح، بانتظار تأكيد + نشر |
| 4 | صندوق تصعيدات | ✅ منجز ومنشور |
| 5 | رسائل صوتية | ⏸️ مؤجّل (يحتاج قرار مزوّد transcription) |
| 6 | تذكير مواعيد استباقي | ⏸️ مؤجّل (يحتاج Meta message template approval) |
| 7 | تصعيد بكشف استياء | ✅ منجز ومنشور |
| 8 | تحليلات لوحة الأدمن | ✅ منجز ومنشور |
| 9 | زر دفعة Whish | ✅ منجز ومنشور (تطوّر لنظام paymentHistory كامل) |
| 10 | تجربة محادثة بلوحة الأدمن | ✅ منجز ومنشور |
| 11 | تصدير Excel من البوابة | ✅ منجز ومنشور |
| 12 | إيقاف البوت من البوابة | ✅ منجز ومنشور |
| 13 | باقات متدرّجة | ✅ منجز ومنشور (قرار المجلس + tier system) |
| 14 | برنامج إحالة | ✅ منجز ومنشور (قرار المجلس + نظام كامل) |
| 15 | تنبيه استهلاك غير معتاد | ✅ منجز ومنشور |

**الباقي فعلياً:** بس تأكيد نجاح Embedded Signup ونشره، وبعدين تدوير مفاتيح Virtualizor
المكشوفة (نقطة أمان معلّقة من زمان).

---

## 6. ذاكرة Claude — الملفات ذات الصلة (بمجلد memory/)

- `ai-customer-service-venture.md` — نظرة عامة على المشروع
- `ai-customer-service-whatsapp-architecture.md` — قرار WABA منفصل لكل عميل
- `ai-customer-service-antigravity-workflow.md` — مسارين تنفيذ (antigravity مقابل مباشر)
- `ai-customer-service-improvement-queue.md` — تفاصيل كل بند بالطابور فوق
- `ai-customer-service-vps-deployment.md` — تفاصيل نشر VPS وحل مشكلة SSH

اقرأهم لو احتجت سياق أعمق من هالملخص.
