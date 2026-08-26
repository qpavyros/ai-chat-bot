// قراءة حدود Groq الفعلية من هيدرز الرد
const fs = require("fs");
const https = require("https");

const key = (fs.readFileSync(".env", "utf8").match(/^TRANSCRIBE_API_KEY=(.+)$/m) || [])[1]?.trim();
if (!key) {
  console.log("no-key");
  process.exit(0);
}

https.get(
  "https://api.groq.com/openai/v1/models",
  { headers: { Authorization: "Bearer " + key } },
  (res) => {
    console.log("STATUS:", res.statusCode);
    for (const [k, v] of Object.entries(res.headers)) {
      if (/ratelimit|remaining|limit/i.test(k)) console.log(k + ":", v);
    }
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => {
      try {
        const models = JSON.parse(body).data || [];
        const turbo = models.find((m) => m.id.includes("turbo"));
        console.log("turbo-available:", Boolean(turbo), "| total-models:", models.length);
      } catch {}
    });
  }
);
