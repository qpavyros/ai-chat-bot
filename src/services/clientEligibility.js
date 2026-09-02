const beirutFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Beirut',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function getBeirutYYYYMMDD(ms) {
  const parts = beirutFormatter.formatToParts(ms);
  let y, m, d;
  for (const part of parts) {
    if (part.type === 'year') y = part.value;
    if (part.type === 'month') m = part.value;
    if (part.type === 'day') d = part.value;
  }
  return parseInt(`${y}${m}${d}`, 10);
}

const parseCache = new Map();

function parseExpiry(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (parseCache.has(value)) return parseCache.get(value);

  let result = null;

  if (value.includes('T')) {
    const fullMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})$/);
    if (fullMatch) {
      const y = parseInt(fullMatch[1], 10);
      const m = parseInt(fullMatch[2], 10);
      const d = parseInt(fullMatch[3], 10);
      const h = parseInt(fullMatch[4], 10);
      const min = parseInt(fullMatch[5], 10);
      const s = parseInt(fullMatch[6], 10);

      if (h < 24 && min < 60 && s < 60) {
        const testD = new Date('2000-01-01T00:00:00Z');
        testD.setUTCFullYear(y, m - 1, d);
        
        if (testD.getUTCFullYear() === y && testD.getUTCMonth() === m - 1 && testD.getUTCDate() === d) {
          const parsedMs = Date.parse(value);
          if (!isNaN(parsedMs)) {
            result = parsedMs;
          }
        }
      }
    }
  } else {
    const dateMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateMatch) {
      const y = parseInt(dateMatch[1], 10);
      const m = parseInt(dateMatch[2], 10);
      const d = parseInt(dateMatch[3], 10);

      const testD = new Date('2000-01-01T00:00:00Z');
      testD.setUTCFullYear(y, m - 1, d);
      
      if (testD.getUTCFullYear() === y && testD.getUTCMonth() === m - 1 && testD.getUTCDate() === d) {
        const nextD = new Date('2000-01-01T00:00:00Z');
        nextD.setUTCFullYear(y, m - 1, d + 1);

        const nextYStr = nextD.getUTCFullYear().toString().padStart(4, '0');
        const nextMStr = (nextD.getUTCMonth() + 1).toString().padStart(2, '0');
        const nextDStr = nextD.getUTCDate().toString().padStart(2, '0');
        const targetNextLocal = parseInt(`${nextYStr}${nextMStr}${nextDStr}`, 10);

        let low = nextD.getTime() - 36 * 3600 * 1000;
        let high = nextD.getTime() + 36 * 3600 * 1000;
        let ans = high;

        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          if (getBeirutYYYYMMDD(mid) >= targetNextLocal) {
            ans = mid;
            high = mid - 1;
          } else {
            low = mid + 1;
          }
        }
        result = ans;
      }
    }
  }

  if (parseCache.size >= 1000) parseCache.clear();
  parseCache.set(value, result);
  return result;
}

function evaluateClientEligibility(client, now = Date.now()) {
  if (!client || typeof client !== 'object' || Array.isArray(client)) {
    return { allowed: false, reason: 'client_not_active' };
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    return { allowed: false };
  }

  if (client.status !== 'active' && client.status !== undefined) {
    return { allowed: false, reason: 'client_not_active' };
  }

  if (client.plan === 'trial') {
    if (client.trialExpiresAt === undefined || client.trialExpiresAt === null || (typeof client.trialExpiresAt === 'string' && client.trialExpiresAt.trim() === '')) {
      return { allowed: false, reason: 'invalid_expiry' };
    }
    const expiry = parseExpiry(client.trialExpiresAt);
    if (expiry === null) {
      return { allowed: false, reason: 'invalid_expiry' };
    }
    if (now >= expiry) {
      return { allowed: false, reason: 'trial_expired' };
    }
    return { allowed: true };
  }

  if (client.subscriptionExpiresAt === undefined || client.subscriptionExpiresAt === null || (typeof client.subscriptionExpiresAt === 'string' && client.subscriptionExpiresAt.trim() === '')) {
    // Unbounded
  } else {
    const expiry = parseExpiry(client.subscriptionExpiresAt);
    if (expiry === null) {
      return { allowed: false, reason: 'invalid_expiry' };
    }
    if (now >= expiry) {
      return { allowed: false, reason: 'subscription_expired' };
    }
  }

  return { allowed: true };
}

module.exports = {
  parseExpiry,
  evaluateClientEligibility
};
