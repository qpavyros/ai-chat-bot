#!/usr/bin/env node
/**
 * تجربة حية لمسار الرسائل الصوتية: توليد ملف صوتي محلي (صوت Windows) → إرساله
 * عبر services/transcribe.js الفعلي إلى Groq → طباعة النص المستخرج.
 *
 * الاستخدام: npm run test:voice
 * بدون أي أثر جانبي على بيانات العملاء — نداء واحد للمزود فقط.
 */

const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const WAV_PATH = path.join(__dirname, "..", "data", ".voice-test.wav");

function pickVoiceAndText() {
  // نفضّل صوت عربي لو مثبت، وإلا إنجليزي مع تعطيل فرض اللغة العربية بالتحويل
  let voices = "";
  try {
    voices = execSync(
      `powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture }"`,
      { encoding: "utf8" }
    );
  } catch {
    return { psVoice: null, text: "Hello, this is a voice transcription test.", skipLanguage: true };
  }

  const lines = voices.split("\n").map((l) => l.trim()).filter(Boolean);
  const arabic = lines.find((l) => /ar/i.test(l));
  if (arabic) {
    return { psVoice: arabic.split("|")[0], text: "مرحبا، هاي رسالة صوتية تجريبية لفحص التحويل.", skipLanguage: false };
  }
  const english = lines.find((l) => /en/i.test(l));
  return {
    psVoice: english ? english.split("|")[0] : null,
    text: "Hello, this is a voice transcription test.",
    skipLanguage: true,
  };
}

async function main() {
  if (!process.env.TRANSCRIBE_API_KEY) {
    console.error("❌ TRANSCRIBE_API_KEY مش موجود بـ.env");
    console.error("   ضيف السطر: TRANSCRIBE_API_KEY=gsk_...");
    process.exitCode = 1;
    return;
  }

  // توليد الصوت بصوت Windows
  const { psVoice, text, skipLanguage } = pickVoiceAndText();
  console.log(`🎙️ عم أولّد صوت تجريبي${psVoice ? ` (${psVoice})` : " (الصوت الافتراضي)"}`);
  const escaped = text.replace(/'/g, "''");
  const voiceArg = psVoice ? `$synth.SelectVoice('${psVoice}');` : "";
  execSync(
    `powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; ${voiceArg} $synth.SetOutputToWaveFile('${WAV_PATH.replace(/\\/g, "\\\\")}'); $synth.Speak('${escaped}'); $synth.Dispose()"`,
    { stdio: "pipe" }
  );
  const buffer = fs.readFileSync(WAV_PATH);
  console.log(`✅ انولّد ${buffer.length} بايت`);

  if (skipLanguage) {
    // نص إنجليزي + فرض لغة ar = نتيجة مضللة — نعطلها لهالاختبار بس
    process.env.TRANSCRIBE_LANGUAGE = "";
  }

  const transcribe = require("../src/services/transcribe");
  console.log(`📤 عم يبعث لـGroq (${process.env.TRANSCRIBE_MODEL || "whisper-large-v3-turbo"})...`);
  const started = Date.now();
  const transcript = await transcribe.transcribeAudioBuffer(buffer, "voice-test.wav");
  const ms = Date.now() - started;

  console.log(`\n✅ نجح التحويل خلال ${ms}ms`);
  console.log(`📝 النص المستخرج: "${transcript}"`);
  console.log(`💬 المتوقع تقريبًا: "${text}"`);
}

main()
  .catch((err) => {
    console.error("\n❌ فشل:", err.response?.status || "", err.response?.data || err.message);
    if (err.response?.status === 401) console.error("   المفتاح غير صالح — تأكد من نسخه كامل");
    if (err.response?.status === 413 || /rate|limit/i.test(err.message)) {
      console.error("   تجاوز حدود الباقة المجانية مؤقتًا — جرب بعد شوي");
    }
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.unlinkSync(WAV_PATH);
    } catch {}
  });
