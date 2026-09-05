// نظام حجز مواعيد بسيط، مخزّن بملف JSON لكل عميل — بدون قاعدة بيانات قصدًا (راجع README).
// كل عميل معرّف "appointments" بـ config.json فيه:
//   workingHours: { start: "09:00", end: "17:00" }
//     أو ساعات لكل يوم منفصلة:
//   workingHours: { byDay: { "0": {start,end}, "2": {start:"10:00", end:"19:00"}, "5": {closed:true} } }
//     (مفاتيح byDay أرقام أيام JS Date.getDay(): 0=أحد .. 6=سبت؛ اليوم بدون مدخل أو closed=true = مغلق)
//   slotMinutes: 30
//   offDays: [5]   // 0=أحد .. 6=سبت، بتطبق فوق byDay كمان
//
// الحجز (bookAppointment) بيصير كامل جوا safeWrite.withClientLock — فحص التوفر والكتابة
// بنفس القفل، حتى ما يصير حجز مزدوج لو زبونين طلبوا نفس الخانة بنفس اللحظة (كان ثغرة حقيقية:
// فحص التوفر والكتابة كانوا عمليتين منفصلتين بدون قفل بينهم).

const safeWrite = require("./safeWrite");
const { todayInBeirut, nowInBeirut } = require("./date-utils");
const { hoursForDate } = require("./businessHours");

function readAppointments(clientId) {
  const file = require("path").join(safeWrite.dataDir(clientId), "appointments.json");
  return safeWrite.safeReadJSON(file, []);
}

function isValidDate(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !Number.isNaN(Date.parse(dateStr));
}

function isValidTime(timeStr) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(timeStr);
}

function minutesSinceMidnight(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function dayOfWeek(dateStr) {
  // نضيف وقت ظهر UTC ثابت لتفادي انزياح التاريخ بسبب المنطقة الزمنية
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

// ساعات يوم معيّن صارت بالخدمة المشتركة businessHours.js — نفس الصيغتين (عام أو byDay)
function generateSlots(client, dateStr) {
  const { slotMinutes } = client.appointments;
  const hours = hoursForDate(client.appointments.workingHours, dateStr);
  if (!hours) return [];

  const start = minutesSinceMidnight(hours.start);
  const end = minutesSinceMidnight(hours.end);
  if (end <= start) return [];

  const slots = [];
  for (let t = start; t + slotMinutes <= end; t += slotMinutes) {
    const h = String(Math.floor(t / 60)).padStart(2, "0");
    const m = String(t % 60).padStart(2, "0");
    slots.push(`${h}:${m}`);
  }
  return slots;
}

// منطق القراءة الفعلي — بدون قفل، يُستخدم من getFreeSlots (قراءة عابرة، ما بتحتاج قفل)
// ومن bookAppointment (لازم يصير جوا القفل، فبيستدعي هاد مباشرة مش getFreeSlots).
function computeFreeSlots(client, dateStr) {
  const apptConfig = client.appointments;
  const offDays = apptConfig.offDays || [];
  if (offDays.includes(dayOfWeek(dateStr))) return [];
  if (dateStr < todayInBeirut()) return [];
  if (!hoursForDate(apptConfig.workingHours, dateStr)) return []; // يوم مغلق بـbyDay

  let allSlots = generateSlots(client, dateStr);

  // اليوم نفسه: خانات الوقت يلي مضت ما لازم تظهر متاحة — كانت ثغرة حقيقية (بوت عيادة كان
  // يعرض موعد الساعة ٩ الصبح وقت العصر). هامش ساعة قبل أي خانة حتى ما نعرض حجز بعد ٥ دقايق.
  if (dateStr === todayInBeirut()) {
    const { hours, minutes } = nowInBeirut();
    const nowMinutes = hours * 60 + minutes;
    allSlots = allSlots.filter((slot) => minutesSinceMidnight(slot) > nowMinutes + 60);
  }

  const booked = readAppointments(client.id)
    .filter((a) => a.date === dateStr && a.status !== "cancelled")
    .map((a) => a.time);

  return allSlots.filter((slot) => !booked.includes(slot));
}

function getFreeSlots(client, dateStr) {
  if (!isValidDate(dateStr)) throw new Error("تاريخ غير صحيح، الصيغة المطلوبة YYYY-MM-DD");
  return computeFreeSlots(client, dateStr);
}

async function bookAppointment(client, { date, time, customerName, customerPhone, note }) {
  if (!isValidDate(date)) throw new Error("تاريخ غير صحيح، الصيغة المطلوبة YYYY-MM-DD");
  if (!isValidTime(time)) throw new Error("وقت غير صحيح، الصيغة المطلوبة HH:mm");
  if (!customerName || !customerPhone) throw new Error("اسم ورقم الزبون مطلوبين");

  const record = await safeWrite.withClientLock(client.id, () => {
    // الفحص والكتابة جوا نفس القفل — هاد يلي بيمنع الحجز المزدوج فعليًا
    const free = computeFreeSlots(client, date);
    if (!free.includes(time)) {
      throw new Error(
        `الوقت ${time} بتاريخ ${date} غير متاح. المتاح: ${free.join(", ") || "لا يوجد مواعيد متاحة هالتاريخ"}`
      );
    }

    const appointments = readAppointments(client.id);
    const record = {
      id: `${date}-${time}-${Date.now()}`,
      date,
      time,
      customerName,
      customerPhone,
      note: note || "",
      status: "confirmed",
      createdAt: new Date().toISOString(),
    };
    appointments.push(record);
    safeWrite.rawWriteDataFile(client.id, "appointments.json", JSON.stringify(appointments, null, 2));

    return record;
  });
  if (process.env.FIRESTORE_MIRROR_WRITES === "true") {
    await require("./storageRepository").mirrorBusinessData(client.id, "appointments", readAppointments(client.id));
  }
  return record;
}

// إلغاء بالبحث عن تاريخ+وقت+رقم تواصل — البوت ما بيعرف الـid الداخلي للموعد (ما ظهرله أبدًا
// بالمحادثة)، بس نفس التفاصيل الثلاثة يلي أكّدها الزبون وقت الحجز هي يلي بيقدر يرجّعها.
async function cancelAppointment(client, { date, time, customerPhone }) {
  if (!isValidDate(date)) throw new Error("تاريخ غير صحيح، الصيغة المطلوبة YYYY-MM-DD");
  if (!isValidTime(time)) throw new Error("وقت غير صحيح، الصيغة المطلوبة HH:mm");
  if (!customerPhone) throw new Error("رقم تواصل الزبون مطلوب لتأكيد أي موعد نلغيه");

  const record = await safeWrite.withClientLock(client.id, () => {
    const appointments = readAppointments(client.id);
    const record = appointments.find(
      (a) => a.date === date && a.time === time && a.customerPhone === customerPhone && a.status !== "cancelled"
    );
    if (!record) throw new Error(`ما في موعد فعّال بتاريخ ${date} الساعة ${time} برقم التواصل هذا`);

    record.status = "cancelled";
    record.cancelledAt = new Date().toISOString();
    safeWrite.rawWriteDataFile(client.id, "appointments.json", JSON.stringify(appointments, null, 2));

    return record;
  });
  if (process.env.FIRESTORE_MIRROR_WRITES === "true") {
    await require("./storageRepository").mirrorBusinessData(client.id, "appointments", readAppointments(client.id));
  }
  return record;
}

module.exports = { getFreeSlots, bookAppointment, cancelAppointment, readAppointments };
