const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const scriptHashes = new Set();

function computeHashes() {
  const dirs = [
    path.join(__dirname, "..", "public"),
    path.join(__dirname, "..", "admin-pages")
  ];

  const regex = /<script[^>]*>([\s\S]*?)<\/script>/gi;

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".html"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), "utf8");
      let match;
      while ((match = regex.exec(content)) !== null) {
        const scriptContent = match[1];
        if (scriptContent.trim().length > 0) {
          const hash = crypto.createHash("sha256").update(scriptContent).digest("base64");
          scriptHashes.add(`'sha256-${hash}'`);
        }
      }
    }
  }
}

computeHashes();

function requireSameOrigin(req, res, next) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin) {
      const host = req.headers.host;
      const proto = req.headers['x-forwarded-proto'] || req.protocol;
      const expectedOrigin = `${proto}://${host}`;
      if (origin !== expectedOrigin) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }
  }
  next();
}

function applySecurityHeaders(req, res, next) {
  const hashes = Array.from(scriptHashes).join(" ");
  
  const csp = [
    "default-src 'self'",
    `script-src 'self' https://www.gstatic.com ${hashes}`,
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self' https://*.googleapis.com https://*.firebaseapp.com https://securetoken.googleapis.com https://identitytoolkit.googleapis.com"
  ].join("; ");
  
  res.setHeader("Content-Security-Policy", csp);
  next();
}

module.exports = {
  requireSameOrigin,
  applySecurityHeaders
};
