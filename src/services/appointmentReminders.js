// تذكير مواعيد استباقي عبر واتساب — فاحص دوري يمسح المواعيد المؤكدة الجاية ويرسل تذكير
// قبلها بعدد ساعات قابل للإعداد (افتراضي 24 و2).
//
// ⚠️ قاعدة Meta الأساسية: الإرسال الحر ممنوع خارج نافذة خدمة الـ24 ساعة (آخر رسالة واردة
// من الزبون). لهيك:
//   - لو العميل عرّف appointments.reminders.templateName (قالب معتمد عند Meta) → إرسال
//     قالب بأي وقت (هاد المسار الصحيح دائمًا).
//   - بدون قالب → نص حر مسموح بس لو الزبون راسلنا خلال آخر 24 ساعة (نطّلع عليها من
//     profile.lastMessageAt). غير هيك منتجّز مع تحذير بالسجل حتى ما ينحرق التوكن.
//
// تعليم "انذكّر" بيصير جوا قفل العميل على سجل الموعد نفسه (remindersSent)، فرسالتين
// متتاليتين ما بيبعتوا تكرار.
const path = require("path");
const safeWrite = require("./safeWrite");
const config = require("../config");
const whatsapp = require("./whatsapp");
const customers = require("./customers");
const { todayInBeirut, nowInBeirut } = require("./date-utils");

const DEFAULT_HOURS_BEFORE = [24, 2];

function pad2(n) {
  return String(n).padStart(2, "0");
}

// مواعيد بيروت محفوظة كـ"تاريخ/وقت حائط" — بنقارن بنفس الإطار الزائف (UTC ثابت) للطرفين
// حتى الفرق يطلع صحيح مهما تغير الـDST، بدون مكتبة مناطق زمنية.
function beirutWallClockMs(dateStr, hhmm) {
  return Date.parse(`${dateStr}T${hhmm}:00Z`);
}

/**
 * دالة نقية — أي موعد مؤكد استحق تذكيرًا لم يُرسل بعد.
 * كل عتبة "بتملك" النافذة بينها وبين العتبة الأصغر مباشرة: عتبة 24 ساعة بتشتغل بـ
 * (2سا، 24سا] وعتبة 2 ساعة بـ(0، 2سا] — هيك ما ينرسل تذكيرين ورا بعض بدقائق لو السيرفر
 * كان طافي وقت العتبة الأولى.
 *
 * @param {Array} appointments سجلات المواعيد
 * @param {{date:string, hhmm:string}} nowBeirut "الآن" بتوقيت بيروت (قابل للحقن بالاختبارات)
 * @param {number[]} hoursBefore
 * @returns {Array<{appointment, hoursKey}>}
 */
function computeDueReminders(appointments, nowBeirut, hoursBefore = DEFAULT_HOURS_BEFORE) {
  const nowMs = beirutWallClockMs(nowBeirut.date, nowBeirut.hhmm);
  const thresholds = [...new Set(hoursBefore.map(Number))].filter((h) => h > 0).sort((a, b) => b - a); // تنازلي
  const due = [];

  for (const appt of appointments || []) {
    if (!appt || appt.status !== "confirmed") continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(appt.date || "") || !/^([01]\d|2[0-3]):[0-5]\d$/.test(appt.time || "")) continue;

    const apptMs = beirutWallClockMs(appt.date, appt.time);
    if (Number.isNaN(apptMs)) continue;

    const minutesUntil = (apptMs - nowMs) / 60_000;
    if (minutesUntil <= 0) continue; // الموعد فات

    const sent = appt.remindersSent || {};
    for (let i = 0; i < thresholds.length; i++) {
      const h = String(thresholds[i]);
      if (sent[h]) continue;
      // الحد الأدنى للنافذة: العتبة الأصغر التالية (أو صفر لآخر عتبة)
      const lowerBoundMinutes = i + 1 < thresholds.length ? thresholds[i + 1] * 60 : 0;
      if (minutesUntil <= thresholds[i] * 60 && minutesUntil > lowerBoundMinutes) {
        due.push({ appointment: appt, hoursKey: h });
        break; // تذكير واحد لكل موعد لكل دورة
      }
    }
  }

  return due;
}

async function readClientConfigLight(clientId) {
  const file = path.join(safeWrite.clientDir(clientId), "config.json");
  return safeWrite.safeReadJSON(file, null);
}

async function markReminderSent(clientId, appointmentId, hoursKey) {
  await safeWrite.withClientLock(clientId, () => {
    const file = path.join(safeWrite.dataDir(clientId), "appointments.json");
    const appointments = safeWrite.safeReadJSON(file, []);
    const record = appointments.find((a) => a.id === appointmentId);
    if (!record) return;
    record.remindersSent = record.remindersSent || {};
    record.remindersSent[hoursKey] = new Date().toISOString();
    safeWrite.rawWriteDataFile(clientId, "appointments.json", JSON.stringify(appointments, null, 2));
  });
}

async function sendReminderForClient(clientId, cfg, dueList) {
  const reminders = cfg.appointments?.reminders || {};
  const phoneNumberId = cfg.whatsappPhoneNumberId;
  let sent = 0;

  for (const { appointment, hoursKey } of dueList) {
    try {
      // المسار الصحيح: قالب معتمد — شغال بأي وقت
      if (reminders.templateName) {
        await whatsapp.sendTemplateMessage(
          appointment.customerPhone,
          phoneNumberId,
          reminders.templateName,
          reminders.templateLang || "ar",
          [appointment.date, appointment.time, cfg.displayName]
        );
      } else {
        // fallback نص حر — مسموح فقط ضمن نافذة خدمة 24 ساعة من آخر رسالة واردة للزبون
        const profile = customers.getProfile(clientId, appointment.customerPhone);
        const lastInbound = profile.lastMessageAt ? new Date(profile.lastMessageAt).getTime() : 0;
        const withinServiceWindow = Date.now() - lastInbound <= 24 * 60 * 60 * 1000;
        if (!withinServiceWindow) {
          console.warn(
            `[reminders] "${clientId}": موعد ${appointment.id} استحق لكن ما في قالب معتمد والزبون برا نافذة الـ24h — تجاهلنا. ` +
              `اعتمد قالب Meta وحط templateName بإعدادات العميل.`
          );
          // منعلّمه حتى ما نفحص كل 5 دقائق منشتن
          await markReminderSent(clientId, appointment.id, hoursKey);
          continue;
        }
        await whatsapp.sendTextMessage(
          appointment.customerPhone,
          phoneNumberId,
          `تذكير لطيف 😊 موعدك مع ${cfg.displayName} يوم ${appointment.date} الساعة ${appointment.time}. بشوفكم!`
        );
      }
      await markReminderSent(clientId, appointment.id, hoursKey);
      sent += 1;
    } catch (err) {
      console.error(`[reminders] "${clientId}" فشل تذكير للموعد ${appointment.id}:`, err.response?.data || err.message);
      // ما منعلّم — الدورة الجاية بتعيد المحاولة
    }
  }

  return sent;
}

/**
 * دورة واحدة كاملة — تُستدعى من الحلقة الدورية بserver.js، أو يدويًا للاختبار.
 */
async function runOnce() {
  const nowBeirut = (() => {
    const { hours, minutes } = nowInBeirut();
    return { date: todayInBeirut(), hhmm: `${pad2(hours)}:${pad2(minutes)}` };
  })();

  let totalSent = 0;
  for (const clientId of safeWrite.listClientIds()) {
    let cfg;
    try {
      cfg = await readClientConfigLight(clientId);
    } catch {
      continue; // عميل انشال بنص المسح
    }
    if (!cfg?.appointments?.enabled || !cfg.appointments.reminders?.enabled) continue;
    if (!cfg.whatsappPhoneNumberId) continue;

    const hoursBefore = Array.isArray(cfg.appointments.reminders.hoursBefore) && cfg.appointments.reminders.hoursBefore.length
      ? cfg.appointments.reminders.hoursBefore.map(Number).filter((n) => n > 0)
      : DEFAULT_HOURS_BEFORE;

    const all = safeWrite.safeReadJSON(path.join(safeWrite.dataDir(clientId), "appointments.json"), []);
    const due = computeDueReminders(all, nowBeirut, hoursBefore);
    if (due.length) {
      totalSent += await sendReminderForClient(clientId, cfg, due);
    }
  }

  if (totalSent > 0) console.log(`[reminders] انبعت ${totalSent} تذكير`);
  return totalSent;
}

module.exports = { runOnce, computeDueReminders };
