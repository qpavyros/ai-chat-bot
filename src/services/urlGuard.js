// حماية من SSRF لأي رابط بيجيبه السيرفر بناءً على مدخل خارجي (استيراد معرفة من موقع).
// آمن أصلاً بـ scripts/ingest.js (المشغّل هو يلي يختار الرابط)، بس صار ضروري لما يصير
// هالمصدر قابل الاستدعاء من نموذج تسجيل ذاتي — رابط ممكن يشاور على شبكة داخلية
// (169.254.169.254 metadata، لوحة تحكم داخلية، إلخ) ولازم يترفض قبل أي اتصال فعلي.

const dns = require("dns").promises;
const net = require("net");
const axios = require("axios");

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inV4Range(intIp, base, prefixBits) {
  const mask = prefixBits === 0 ? 0 : (~0 << (32 - prefixBits)) >>> 0;
  return (intIp & mask) === (ipv4ToInt(base) & mask);
}

// النطاقات الخاصة/المحجوزة (RFC 1918 وأخواتها) — أي رابط بيحل لأي عنوان منها مرفوض
const PRIVATE_V4_RANGES = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (بما فيها metadata endpoint الشائع بالسحابة)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // محجوز
];

function isPrivateV4(ip) {
  const intIp = ipv4ToInt(ip);
  return PRIVATE_V4_RANGES.some(([base, bits]) => inV4Range(intIp, base, bits));
}

function isPrivateV6(ip) {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4 مُدمج جوا IPv6
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

function isPrivateOrReservedIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (net.isIPv6(ip)) return isPrivateV6(ip);
  return true; // شكل غير معروف = ما بنثق فيه
}

async function assertSafePublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("رابط غير صحيح");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("بروتوكول غير مسموح — http أو https بس");
  }

  if (parsed.port && !["80", "443", ""].includes(parsed.port)) {
    throw new Error("بورت غير مسموح");
  }

  const hostname = parsed.hostname;

  if (net.isIP(hostname)) {
    throw new Error("لازم اسم نطاق (domain)، مو عنوان IP مباشر");
  }

  if (hostname === "localhost" || /\.(internal|local)$/i.test(hostname)) {
    throw new Error("نطاق غير مسموح");
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error("تعذّر حل اسم النطاق (DNS)");
  }

  if (addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
    throw new Error("الرابط بيشاور على عنوان شبكة داخلية/محجوز — مرفوض");
  }

  if (addresses.length === 0) {
    throw new Error("لا يوجد عناوين صالحة");
  }

  return { parsedUrl: parsed, addresses };
}

// ⚠️ حد معروف ومقصود: الفحص أعلاه بيصير قبل الاتصال الفعلي بلحظات — نافذة نظرية لهجوم
// DNS rebinding (يبدّل مزوّد خبيث الـ DNS بين لحظة الفحص ولحظة الاتصال الفعلي من axios).
// إغلاقها بالكامل يحتاج تثبيت (pin) العنوان المُحلّل والاتصال فيه مباشرة مع تمرير Host
// header يدويًا — تعقيد إضافي مو مبرر حاليًا لأن المصدر رابط قدّمته شركة بإيميل مؤكّد،
// مو مستخدم مجهول الهوية بالكامل. وثّق هالحد بالـ README قبل ما تفتح الميزة للعامة.
async function safeGet(url, { depth = 0 } = {}) {
  if (depth > MAX_REDIRECTS) {
    throw new Error("عدد إعادات التوجيه تجاوز الحد المسموح");
  }

  const { parsedUrl: safeUrl, addresses } = await assertSafePublicUrl(url);
  const pinned = addresses[0];

  // مواقع كتير (خصوصًا اللي وراء Cloudflare أو حماية bot بسيطة) بترفض أي طلب بـ
  // User-Agent افتراضي لمكتبات HTTP (axios/curl/إلخ) بـ403 — مو استهداف لنا تحديدًا،
  // مجرد فلترة عامة ضد "غير متصفح". محاكاة متصفح حقيقي هون شرعية 100%: الشركة نفسها
  // قدّمت رابط موقعها لنستورد معرفته، مش سيناريو تحايل على حماية موجّهة ضدنا.
  const response = await axios.get(safeUrl.toString(), {
    timeout: FETCH_TIMEOUT_MS,
    maxRedirects: 0,
    maxContentLength: MAX_CONTENT_BYTES,
    validateStatus: (status) => status >= 200 && status < 400,
    lookup: (hostname, options, callback) => {
      const cb = typeof options === "function" ? options : callback;
      cb(null, pinned.address, pinned.family);
    },
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.location;
    if (!location) throw new Error("إعادة توجيه بدون رابط وجهة");
    const nextUrl = new URL(location, safeUrl).toString();
    return safeGet(nextUrl, { depth: depth + 1 });
  }

  const contentType = response.headers["content-type"] || "";
  if (!contentType.includes("text/html")) {
    throw new Error(`نوع المحتوى غير مدعوم: ${contentType || "غير معروف"} (لازم text/html)`);
  }

  return response;
}

module.exports = { assertSafePublicUrl, safeGet, isPrivateOrReservedIp };
