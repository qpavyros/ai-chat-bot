const CLINICS_LAUNCH_CODE = "clinics-launch-2026";

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
  normalizeCampaignCode,
};
