// مسح نهائي للبوتات المحذوفة (soft delete) بعد مهلة استرجاع 30 يوم — راجع
// docs/site-restructure-plan.md قسم 7. بيشتغل يدوياً (node scripts/purge-deleted-bots.js)
// أو مجدول (cron/pm2) — ما بيلمس أي شي عمره أقل من 30 يوم.

const fs = require("fs");
const path = require("path");

const ARCHIVE_DIR = path.join(__dirname, "..", "data", "deleted-bots");
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function run() {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    console.log("[purge-deleted-bots] ما في مجلد أرشيف بعد — ما في شي يُمسح.");
    return;
  }

  const now = Date.now();
  const entries = fs.readdirSync(ARCHIVE_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  let purged = 0;

  for (const entry of entries) {
    // اسم المجلد: <clientId>-<timestamp> — الـtimestamp آخر جزء دايمًا (clientId ممكن فيه dash).
    const match = entry.name.match(/-(\d+)$/);
    const deletedAt = match ? Number(match[1]) : null;

    if (!deletedAt || now - deletedAt >= RETENTION_MS) {
      fs.rmSync(path.join(ARCHIVE_DIR, entry.name), { recursive: true, force: true });
      console.log(`[purge-deleted-bots] مُسح نهائياً: ${entry.name}`);
      purged += 1;
    }
  }

  console.log(`[purge-deleted-bots] خلص — ${purged} من ${entries.length} انمسحوا نهائياً.`);
}

run();
