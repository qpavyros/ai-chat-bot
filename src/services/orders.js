// تسجيل طلبات منتجات (مش مواعيد) — مخزّن بملف JSON لكل عميل، وبيبعت إشعار واتساب فوري
// لصاحب المحل، بنفس نمط appointments.js وhandoff.js. الهدف: البوت ما يوعد الزبون بـ"تم الحجز"
// إلا بعد ما فعليًا يصير أثر مكتوب بمكان ما، وصاحب المحل يعرف فيه طلبية جديدة بلحظتها.
//
// القراءة+الكتابة بتصير جوا safeWrite.withClientLock (بنفس القفل يلي appointments.js/customers.js
// عم يستخدموه لهيك العميل) — إشعار واتساب بيصير برا القفل عمدًا (نداء شبكة، ما في داعي يعطّل
// كتابات تانية لنفس العميل وقت ما بينتظر رد Meta).

const path = require("path");
const config = require("../config");
const whatsapp = require("./whatsapp");
const safeWrite = require("./safeWrite");

function readOrders(clientId) {
  const file = path.join(safeWrite.dataDir(clientId), "orders.json");
  return safeWrite.safeReadJSON(file, []);
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

  const record = await safeWrite.withClientLock(client.id, () => {
    const orders = readOrders(client.id);
    const newRecord = {
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
    orders.push(newRecord);
    safeWrite.rawWriteDataFile(client.id, "orders.json", JSON.stringify(orders, null, 2));
    return newRecord;
  });

  await notifyBusinessOwner(client, record);

  return record;
}

module.exports = { createOrder, readOrders };
