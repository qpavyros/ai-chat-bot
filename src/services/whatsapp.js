const axios = require("axios");
const config = require("../config");

async function sendTextMessage(toPhoneNumber, phoneNumberId, text) {
  const url = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${phoneNumberId}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to: toPhoneNumber,
      type: "text",
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${config.whatsapp.token}`,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    }
  );
}

module.exports = { sendTextMessage };
