// نظام حجز مواعيد بسيط، مخزّن بملف JSON لكل عميل — بدون قاعدة بيانات قصدًا (راجع README).
// كل عميل معرّف "appointments" بـ config.json فيه:
//   workingHours: { start: "09:00", end: "17:00" }
//   slotMinutes: 30
//   offDays: [5]   // 0=أحد .. 6=سبت (JS Date.getDay())، مثلاً 5 = جمعة

const fs = require("fs");
const path = require("path");
const { todayInBeirut } = require("./date-utils");
const { safeId } = require("./safe-id");

const DATA_DIR = path.join(__dirname, "..", "..", "data");

function dataFilePath(clientId) {
  return path.join(DATA_DIR, safeId(clientId), "appointments.json");
}

function readAppointments(clientId) {
  const file = dataFilePath(clientId);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeAppointments(clientId, appointments) {
  const file = dataFilePath(clientId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(appointments, null, 2), "utf8");
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

function generateSlots(client) {
  const { workingHours, slotMinutes } = client.appointments;
  const start = minutesSinceMidnight(workingHours.start);
  const end = minutesSinceMidnight(workingHours.end);
  const slots = [];
  for (let t = start; t + slotMinutes <= end; t += slotMinutes) {
    const h = String(Math.floor(t / 60)).padStart(2, "0");
    const m = String(t % 60).padStart(2, "0");
    slots.push(`${h}:${m}`);
  }
  return slots;
}

function getFreeSlots(client, dateStr) {
  if (!isValidDate(dateStr)) throw new Error("تاريخ غير صحيح، الصيغة المطلوبة YYYY-MM-DD");

  const offDays = client.appointments.offDays || [];
  if (offDays.includes(dayOfWeek(dateStr))) return [];

  if (dateStr < todayInBeirut()) return [];

  const allSlots = generateSlots(client);
  const booked = readAppointments(client.id)
    .filter((a) => a.date === dateStr)
    .map((a) => a.time);

  return allSlots.filter((slot) => !booked.includes(slot));
}

function bookAppointment(client, { date, time, customerName, customerPhone, note }) {
  if (!isValidDate(date)) throw new Error("تاريخ غير صحيح، الصيغة المطلوبة YYYY-MM-DD");
  if (!isValidTime(time)) throw new Error("وقت غير صحيح، الصيغة المطلوبة HH:mm");
  if (!customerName || !customerPhone) throw new Error("اسم ورقم الزبون مطلوبين");

  const free = getFreeSlots(client, date);
  if (!free.includes(time)) {
    throw new Error(`الوقت ${time} بتاريخ ${date} غير متاح. المتاح: ${free.join(", ") || "لا يوجد مواعيد متاحة هالتاريخ"}`);
  }

  const appointments = readAppointments(client.id);
  const record = {
    id: `${date}-${time}-${Date.now()}`,
    date,
    time,
    customerName,
    customerPhone,
    note: note || "",
    createdAt: new Date().toISOString(),
  };
  appointments.push(record);
  writeAppointments(client.id, appointments);

  return record;
}

module.exports = { getFreeSlots, bookAppointment, readAppointments };
