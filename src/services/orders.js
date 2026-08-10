// تسجيل طلبات منتجات (مش مواعيد) — مخزّن بملف JSON لكل عميل، وبيبعت إشعار واتساب فوري
// لصاحب المحل، بنفس نمط appointments.js وhandoff.js. الهدف: البوت ما يوعد الزبون بـ"تم الحجز"
// إلا بعد ما فعليًا يصير أثر مكتوب بمكان ما، وصاحب المحل يعرف فيه طلبية جديدة بلحظتها.

const fs = require("fs");
const path = require("path");
const config = require("../config");
const whatsapp = require("./whatsapp");
const { safeId } = require("./safe-id");

const DATA_DIR = path.join(__dirname, "..", "..", "data");

function dataFilePath(clientId) {
  return path.join(DATA_DIR, safeId(clientId), "orders.json");
}

function readOrders(clientId) {
  const file = dataFilePath(clientId);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeOrders(clientId, orders) {
  const file = dataFilePath(clientId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(orders, null, 2), "utf8");
}

async function notifyBusinessOwner(client, record) {
  const notifyTo = client.escalation?.notifyWhatsapp;
  const senderPhoneNumberId = client.whatsappPhoneNumberId || config.whatsapp.notifySenderPhoneNumberId;

  if (!notifyTo || !senderPhoneNumberId) {
    console.warn(`[orders] طلب جديد لعميل "${client.id}" بس ما في notifyWhatsapp أو رقم مرسل مُعرَّف — الطلب اتسجل بالملف بس ما وصل إشعار.`);
    return;
  }

  const text =
    `🛒 طلبية جديدة — ${client.displayName}\n` +
    `${record.items}\n` +
    `السعر: ${record.totalPrice}\n` +
    `الاستلام: ${record.deliveryMethod === "delivery" ? `توصيل — ${record.deliveryAddress}` : "من الفرع"}\n` +
    `الدفع: ${record.paymentMethod}\n` +
    `الزبون: ${record.customerName} — ${record.customerPhone}` +
    (record.note ? `\nملاحظة: ${record.note}` : "");

  try {
    await whatsapp.sendTextMessage(notifyTo, senderPhoneNumberId, text);
  } catch (err) {
    console.error("[orders] فشل إرسال إشعار الطلبية:", err.response?.data || err.message);
  }
}

async function createOrder(client, { items, totalPrice, deliveryMethod, deliveryAddress, paymentMethod, customerName, customerPhone, note }) {
  if (!items || !totalPrice) throw new Error("وصف الطلبية والسعر مطلوبين");
  if (!customerName || !customerPhone) throw new Error("اسم ورقم الزبون مطلوبين");
  if (!["pickup", "delivery"].includes(deliveryMethod)) throw new Error("طريقة الاستلام لازم تكون pickup أو delivery");
  if (deliveryMethod === "delivery" && !deliveryAddress) throw new Error("عنوان التوصيل مطلوب لطلبات التوصيل");
  if (!paymentMethod) throw new Error("طريقة الدفع مطلوبة");

  const orders = readOrders(client.id);
  const record = {
    id: `order-${Date.now()}`,
    items,
    totalPrice,
    deliveryMethod,
    deliveryAddress: deliveryAddress || "",
    paymentMethod,
    customerName,
    customerPhone,
    note: note || "",
    createdAt: new Date().toISOString(),
  };
  orders.push(record);
  writeOrders(client.id, orders);

  await notifyBusinessOwner(client, record);

  return record;
}

module.exports = { createOrder, readOrders };
