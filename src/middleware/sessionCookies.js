// أدوات كوكي الجلسات المشتركة — كانت منسوخة نصيًا بثلاثة روترات (admin/userAuth/portal القديمة)
// بفروق شكلية فقط، وهيك أي إصلاح أمني (SameSite، Secure خلف proxy...) لازم ينطبق 3 مرات.
// كل جلسة بتحط HttpOnly + SameSite=Strict دائمًا، وSecure لما الطلب فعليًا وصل عبر HTTPS
// (trust proxy مفعّل بserver.js فيخلي req.secure يعكس X-Forwarded-Proto).

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return cookies;
}

function setSessionCookie(req, res, { name, value, maxAgeSeconds }) {
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader(
    "Set-Cookie",
    `${name}=${value}; HttpOnly; Path=/; Max-Age=${Math.floor(maxAgeSeconds)}; SameSite=Strict${isHttps ? "; Secure" : ""}`
  );
}

function clearSessionCookie(res, name) {
  res.setHeader("Set-Cookie", `${name}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict`);
}

function clientIp(req) {
  return req.ip || req.connection?.remoteAddress || "unknown";
}

module.exports = { parseCookies, setSessionCookie, clearSessionCookie, clientIp };
