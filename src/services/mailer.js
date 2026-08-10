// إرسال إيميل عبر SMTP (nodemailer). لو ما في SMTP_HOST بالـ .env، بيرجع لوضع تطوير:
// يطبع رابط التحقق بالـ console بدل ما يبعته فعليًا — هيك تقدر تبني/تجرب كل فلو التسجيل
// الذاتي قبل ما يصير عندك مزوّد SMTP حقيقي (Brevo فيه باقة مجانية، أو Gmail SMTP بـ app password).

const nodemailer = require("nodemailer");
const config = require("../config");

let transporter = null;
let transporterAttempted = false;

function getTransporter() {
  if (transporterAttempted) return transporter;
  transporterAttempted = true;

  if (!config.smtp.host) return null;

  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return transporter;
}

async function sendVerificationEmail(toEmail, verifyUrl) {
  const t = getTransporter();

  if (!t) {
    console.warn(
      `[mailer] SMTP مو مُعرّف — وضع تطوير. رابط التحقق (بدل ما يُبعت بالإيميل فعليًا):\n${verifyUrl}`
    );
    return { sent: false, devFallback: true };
  }

  await t.sendMail({
    from: config.smtp.from,
    to: toEmail,
    subject: "أكّد إيميلك لتفعيل بوت خدمة العملاء تبعك",
    text: `اضغط الرابط التالي لتأكيد إيميلك والمتابعة بإعداد البوت:\n\n${verifyUrl}\n\nالرابط صالح لمدة 24 ساعة.`,
  });

  return { sent: true };
}

module.exports = { sendVerificationEmail };
