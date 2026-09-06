const CLINICS_LAUNCH_CODE = "clinics-launch-2026";
const CLINICS_LAUNCH_DISCOUNT_PERCENT = 20;
const CLINICS_LAUNCH_LIMIT = 5;
const CLINICS_LAUNCH_GRACE_DAYS = 7;

function normalizeCampaignCode(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === CLINICS_LAUNCH_CODE) {
    return CLINICS_LAUNCH_CODE;
  }
  return null;
}

module.exports = {
  CLINICS_LAUNCH_CODE,
  CLINICS_LAUNCH_DISCOUNT_PERCENT,
  CLINICS_LAUNCH_LIMIT,
  CLINICS_LAUNCH_GRACE_DAYS,
  normalizeCampaignCode,
};
