const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const launchCampaign = require('../src/services/launchCampaign');

test('campaign constants and normalization', () => {
  assert.strictEqual(launchCampaign.CLINICS_LAUNCH_CODE, 'clinics-launch-2026');
  assert.strictEqual(launchCampaign.CLINICS_LAUNCH_DISCOUNT_PERCENT, 20);
  assert.strictEqual(launchCampaign.CLINICS_LAUNCH_LIMIT, 5);
  
  assert.strictEqual(launchCampaign.normalizeCampaignCode(' clinics-launch-2026 '), 'clinics-launch-2026');
  assert.strictEqual(launchCampaign.normalizeCampaignCode('invalid'), null);
  assert.strictEqual(launchCampaign.normalizeCampaignCode(null), null);
});

test('signup page forwards the campaign query', () => {
  const signupHtmlPath = path.join(__dirname, '..', 'src', 'public', 'signup.html');
  const signupHtml = fs.readFileSync(signupHtmlPath, 'utf8');
  assert.ok(signupHtml.includes('campaignCode: urlParams.get("campaign")'), 'signup.html should forward campaign param');
});

test('billing/admin static UI markers exist', () => {
  const billingHtmlPath = path.join(__dirname, '..', 'src', 'public', 'billing.html');
  const billingHtml = fs.readFileSync(billingHtmlPath, 'utf8');
  assert.ok(billingHtml.includes('campaignOffer'), 'billing.html should have campaignOffer marker');

  const adminHtmlPath = path.join(__dirname, '..', 'src', 'admin-pages', 'admin-client-detail.html');
  const adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');
  assert.ok(adminHtml.includes('id="campaign-banner"'), 'admin-client-detail.html should have campaign-banner marker');
});

test('campaign documentation contains required offer and stop-rule markers', () => {
  const docPath = path.join(__dirname, '..', 'docs', 'marketing', 'clinics-launch-2026.md');
  const docContent = fs.readFileSync(docPath, 'utf8');
  
  assert.ok(docContent.includes('أول خمس عيادات تسجّل أول دفعة'), 'Doc should define the first-payment claim rule');
  assert.ok(docContent.includes('الخصم ينتقل مع تغيير الباقة'), 'Doc should define plan-change pricing');
  assert.ok(docContent.includes('طالما أن الاشتراك مستمر'), 'Doc should define continuity');
  assert.ok(docContent.includes('7 أيام بعد انتهاء الاشتراك'), 'Doc should define the renewal grace');
  assert.ok(docContent.includes('يسقط الخصم نهائياً'), 'Doc should define permanent lapse');
  assert.ok(docContent.includes('عند صرف 25$ إذا كان عدد المحادثات الجدية أقل من 3'), 'Doc should contain the stop rule');
  assert.ok(docContent.includes('No cold bulk messaging'), 'Doc should prohibit cold bulk messaging');
});
