// حالة "تم التصعيد لإنسان" بس — RAM فقط، مقصود: مو مهم تنجو من إعادة تشغيل السيرفر
// (لو السيرفر عاد اشتغل، منطقي البوت يرجع يرد عادي). لذاكرة الزبون الدائمة (تاريخ + تفضيلات)
// راجع customers.js.

function key(clientId, userId) {
  return `${clientId}:${userId}`;
}

const pausedUntil = new Map(); // key -> timestamp

function pauseForHandoff(clientId, userId, ms = 24 * 60 * 60 * 1000) {
  pausedUntil.set(key(clientId, userId), Date.now() + ms);
}

function resumeFromHandoff(clientId, userId) {
  pausedUntil.delete(key(clientId, userId));
}

function isPaused(clientId, userId) {
  const until = pausedUntil.get(key(clientId, userId));
  return typeof until === "number" && until > Date.now();
}

function getPausedConversations(clientId) {
  const result = [];
  const prefix = `${clientId}:`;
  const now = Date.now();
  for (const [k, until] of pausedUntil.entries()) {
    if (k.startsWith(prefix) && until > now) {
      const endUserId = k.slice(prefix.length);
      result.push({ endUserId, pausedUntil: until, remainingMinutes: Math.ceil((until - now) / 60000) });
    }
  }
  return result;
}

module.exports = { pauseForHandoff, resumeFromHandoff, isPaused, getPausedConversations };

