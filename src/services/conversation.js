// حالة "تم التصعيد لإنسان" بس — RAM فقط، مقصود: مو مهم تنجو من إعادة تشغيل السيرفر
// (لو السيرفر عاد اشتغل، منطقي البوت يرجع يرد عادي). لذاكرة الزبون الدائمة (تاريخ + تفضيلات)
// راجع customers.js.

function key(clientId, userId) {
  return `${clientId}:${userId}`;
}

const pausedUntil = new Map(); // key -> timestamp

function pauseForHandoff(clientId, userId, ms) {
  pausedUntil.set(key(clientId, userId), Date.now() + ms);
}

function isPaused(clientId, userId) {
  const until = pausedUntil.get(key(clientId, userId));
  return typeof until === "number" && until > Date.now();
}

function resume(clientId, userId) {
  pausedUntil.delete(key(clientId, userId));
}

module.exports = { pauseForHandoff, isPaused, resume };
