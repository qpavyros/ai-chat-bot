// استخراج معرفة من مصدر خام (PDF، إكسل/CSV، أو صفحة موقع) — نص .md جاهز يُقرأ تلقائيًا
// كجزء من قاعدة معرفة العميل (راجع src/clients/registry.js).
//
// مشترك بين scripts/ingest.js (CLI يشغّله المشغّل يدويًا) وrouter التسجيل الذاتي لاحقًا —
// لهيك الدوال تاخد Buffer/رابط مباشرة، بدون أي افتراض إنه في ملف عالقرص. هيك التسجيل الذاتي
// (لما يوصل) بيقدر يمرر ملف مرفوع بالـ HTTP مباشرة بدون ما يكتبه عالديسك أول.

const { Readable } = require("stream");
const path = require("path");
const axios = require("axios");
const ExcelJS = require("exceljs");
const cheerio = require("cheerio");
const pdfParse = require("pdf-parse");

async function ingestPdfBuffer(buffer) {
  const { text } = await pdfParse(buffer);
  return (
    "> ⚠️ نص مستخرج آليًا من PDF، ممكن يكون فيه تنسيق مبعثر — راجعه وعدّله قبل ما تعتمد عليه بالكامل.\n\n" +
    text.trim()
  );
}

async function ingestExcelBuffer(buffer, ext) {
  const workbook = new ExcelJS.Workbook();
  const normalizedExt = (ext || "").toLowerCase();

  if (normalizedExt === ".csv") {
    await workbook.csv.read(Readable.from(buffer));
  } else {
    await workbook.xlsx.load(buffer);
  }

  const parts = [];

  workbook.eachSheet((sheet) => {
    const rows = [];
    sheet.eachRow((row) => {
      // row.values[0] فاضي دائمًا (ExcelJS بيرقّم الأعمدة من 1)
      rows.push(row.values.slice(1).map((v) => (v == null ? "" : String(v))));
    });
    if (rows.length === 0) return;

    const [headerRow, ...dataRows] = rows;
    parts.push(`## ${sheet.name}`, "");

    for (const row of dataRows) {
      if (row.every((cell) => cell.trim() === "")) continue;
      const line = headerRow.map((h, i) => `${h}: ${row[i] ?? ""}`).join(" | ");
      parts.push(`- ${line}`);
    }
    parts.push("");
  });

  return parts.join("\n").trim();
}

// fetch القابل للحقن (اختياري): CLI بيستخدم axios.get مباشرة (آمن، المشغّل هو يلي اختار
// الرابط). endpoint التسجيل الذاتي العام لازم يمرر urlGuard.safeGet بدلها — حماية SSRF
// (IP داخلية، إعادة توجيه، حجم الرد) لازمة هناك تحديدًا لأنه رابط من مستخدم مجهول نسبيًا.
async function defaultFetch(url) {
  // User-Agent متصفح حقيقي — مواقع كتير برا حماية Cloudflare/بوت بسيطة بترفض أي طلب
  // بـUser-Agent افتراضي لمكتبات HTTP بـ403، بغض النظر مين المرسل.
  return axios.get(url, {
    timeout: 20_000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
}

async function ingestWebsite(url, { fetch = defaultFetch } = {}) {
  const { data: html } = await fetch(url);
  const $ = cheerio.load(html);
  $("script, style, nav, footer, noscript").remove();

  // body.text() بتلزق نص العناصر ببعضها بدون فواصل — نحقن سطر جديد بعد كل عنصر-كتلة قبل الاستخراج
  $("br").replaceWith("\n");
  $("p, div, li, h1, h2, h3, h4, h5, h6, tr, td").after("\n");

  const text = $("body")
    .text()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return `> مصدر: ${url}\n\n${text}`;
}

function knowledgeFilePath(clientDir, baseName) {
  return path.join(clientDir, `source-${baseName}.md`);
}

const MIN_CHARS = 200;
const MAX_CHARS = 60_000; // بيتحقن كامل بكل رسالة — هاد سقف عملي قبل ما يصير غالي وبطيء
const MAX_NON_PRINTABLE_RATIO = 0.05;

const BOILERPLATE_PATTERNS = [
  /enable javascript/i,
  /يرجى تفعيل جافا سكريبت/,
  /accept cookies/i,
  /هذا الموقع يستخدم ملفات تعريف الارتباط/,
  /just a moment/i, // صفحة تحدّي Cloudflare
  /checking your browser/i,
];

// فحوصات آلية سريعة قبل ما نعرض الاستخراج للشركة (أو نعتمد عليه). مو بديل عن المراجعة
// البشرية، بس بيلتقط الحالات الواضحة (PDF ممسوح ضوئيًا بدون نص، صفحة كوكيز بدل المحتوى،
// نص تالف) قبل ما توصل أصلاً لخطوة "جرّب بوتك".
function sanityCheck(content, meta = {}) {
  const charCount = content.length;

  if (charCount < MIN_CHARS) {
    return {
      ok: false,
      warnings: [`النص المستخرج قصير جدًا (${charCount} حرف) — غالبًا PDF ممسوح ضوئيًا بدون طبقة نص، أو صفحة فاضية`],
      stats: { charCount },
    };
  }

  if (charCount > MAX_CHARS) {
    return {
      ok: false,
      warnings: [
        `النص المستخرج كبير جدًا (${charCount} حرف) — بيتحقن كامل بكل رسالة، رح يصير غالي وبطيء. لخّصه أو قسّمه قبل الاستخدام`,
      ],
      stats: { charCount },
    };
  }

  const nonPrintable = content.match(/[^\x20-\x7E؀-ۿݐ-ݿ\s]/g) || [];
  const nonPrintableRatio = nonPrintable.length / charCount;
  if (nonPrintableRatio > MAX_NON_PRINTABLE_RATIO) {
    return {
      ok: false,
      warnings: [
        `نسبة كبيرة من النص (${(nonPrintableRatio * 100).toFixed(0)}%) رموز غير مقروءة — الاستخراج غالبًا فشل أو الملف تالف`,
      ],
      stats: { charCount, nonPrintableRatio },
    };
  }

  const warnings = [];

  if (BOILERPLATE_PATTERNS.some((pattern) => pattern.test(content))) {
    warnings.push(
      "النص فيه إشارة على صفحة تحدٍّ/كوكيز بدل المحتوى الفعلي (مثلاً صفحة Cloudflare أو تنبيه جافا سكريبت) — راجعه"
    );
  }

  if (meta.pageCount > 0) {
    const charsPerPage = charCount / meta.pageCount;
    if (charsPerPage < 50) {
      warnings.push(
        `متوسط النص لكل صفحة قليل جدًا (${Math.round(charsPerPage)} حرف/صفحة) — احتمال إنه PDF فيه صفحات ممسوحة ضوئيًا بدون نص`
      );
    }
  }

  return { ok: true, warnings, stats: { charCount, nonPrintableRatio, pageCount: meta.pageCount } };
}

module.exports = { ingestPdfBuffer, ingestExcelBuffer, ingestWebsite, knowledgeFilePath, sanityCheck };
