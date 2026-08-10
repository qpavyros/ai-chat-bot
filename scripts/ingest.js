#!/usr/bin/env node
/**
 * يحوّل مصدر معلومات خام (PDF، إكسل/CSV، أو صفحة موقع) لملف .md نصي
 * يُقرأ تلقائيًا كجزء من قاعدة معرفة العميل (راجع src/clients/registry.js).
 *
 * الاستخدام:
 *   npm run ingest -- <clientId> pdf <مسار-الملف.pdf> [اسم-الملف-الناتج]
 *   npm run ingest -- <clientId> excel <مسار-الملف.xlsx-أو-csv> [اسم-الملف-الناتج]
 *   npm run ingest -- <clientId> website <رابط-الصفحة> [اسم-الملف-الناتج]
 *
 * مثال:
 *   npm run ingest -- pharmacy-x excel "C:\path\products.xlsx" products
 *   → بيكتب src/clients/pharmacy-x/source-products.md
 *
 * قاعدة بيانات العميل (SQL/Firebase/إلخ): مو مدعومة هون لأن كل قاعدة مختلفة —
 * اكتب سكربت تصدير بسيط يفرّغ الجداول المهمة كـ CSV، وبعدين مرّره بـ excel نمط.
 *
 * منطق الاستخراج الفعلي بـ src/services/ingest.js — هالملف غلاف CLI بس فوقه
 * (بيقرأ من القرص، بيمرر Buffer/رابط، بيكتب النتيجة).
 */

const fs = require("fs");
const path = require("path");
const ingest = require("../src/services/ingest");

const CLIENTS_DIR = path.join(__dirname, "..", "src", "clients");

async function main() {
  const [clientId, type, source, outputName] = process.argv.slice(2);

  if (!clientId || !type || !source) {
    console.error(
      "الاستخدام: npm run ingest -- <clientId> <pdf|excel|website> <مسار-أو-رابط> [اسم-الملف-الناتج]"
    );
    process.exit(1);
  }

  const clientDir = path.join(CLIENTS_DIR, clientId);
  if (!fs.existsSync(clientDir)) {
    console.error(`مجلد العميل غير موجود: ${clientDir}\nأنشئه أول (انسخ عن example-client) قبل ما تجيب معلومات.`);
    process.exit(1);
  }

  let content;
  if (type === "pdf") {
    content = await ingest.ingestPdfBuffer(fs.readFileSync(source));
  } else if (type === "excel") {
    content = await ingest.ingestExcelBuffer(fs.readFileSync(source), path.extname(source));
  } else if (type === "website") {
    content = await ingest.ingestWebsite(source);
  } else {
    console.error(`نوع غير مدعوم: ${type} (المتاح: pdf, excel, website)`);
    process.exit(1);
  }

  const baseName = outputName || path.basename(source, path.extname(source)).replace(/\s+/g, "-");
  const outPath = ingest.knowledgeFilePath(clientDir, baseName);
  fs.writeFileSync(outPath, content, "utf8");

  console.log(`✅ كُتب: ${outPath}`);
  console.log(`   (${content.length} حرف — راجعه، وإذا كبير كتير فكّر تلخّصه يدويًا لتقليل تكلفة كل رسالة)`);
}

main().catch((err) => {
  console.error("فشل الاستيراد:", err.message);
  process.exit(1);
});
