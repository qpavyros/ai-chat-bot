function ownershipError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

async function verifyEmbeddedSignupOwnership({ axios, graphVersion, appId, appSecret, code, phoneNumberId, wabaId }) {
  const base = `https://graph.facebook.com/${graphVersion}`;
  let tokenResponse;
  try {
    tokenResponse = await axios.get(`${base}/oauth/access_token`, {
      params: { client_id: appId, client_secret: appSecret, code },
      timeout: 15_000,
    });
    const accessToken = tokenResponse?.data?.access_token;
    if (!accessToken) throw ownershipError("whatsapp_ownership_failed", "Meta did not return an access token");

    const auth = { Authorization: `Bearer ${accessToken}` };
    const phoneResponse = await axios.get(`${base}/${encodeURIComponent(String(phoneNumberId))}`, {
      headers: auth,
      params: { fields: "id,waba_id" },
      timeout: 15_000,
    });
    const phone = phoneResponse?.data;
    if (!phone?.id || phone.id !== phoneNumberId) {
      throw ownershipError("whatsapp_ownership_mismatch", "Meta returned a different phone number");
    }
    if (wabaId && phone.waba_id !== wabaId) {
      throw ownershipError("whatsapp_ownership_mismatch", "Phone number is attached to a different WABA");
    }

    if (wabaId) {
      const wabaResponse = await axios.get(`${base}/${encodeURIComponent(String(wabaId))}`, {
        headers: auth,
        params: { fields: "id" },
        timeout: 15_000,
      });
      if (wabaResponse?.data?.id !== wabaId) {
        throw ownershipError("whatsapp_ownership_mismatch", "Meta returned a different WABA");
      }
    }
    return { accessToken, phoneNumberId, wabaId: phone.waba_id || wabaId || null };
  } catch (error) {
    if (error?.code === "whatsapp_ownership_mismatch" || error?.code === "whatsapp_ownership_failed") throw error;
    throw ownershipError("whatsapp_ownership_failed", "Meta ownership verification failed", error);
  }
}

module.exports = { verifyEmbeddedSignupOwnership };
