import axios from "axios";
import config from "../config/index.js";

const { whatsapp } = config;

/**
 * Send a plain text message via WhatsApp Business API
 */
export async function sendTextMessage(to, text) {
  return sendMessage(to, { type: "text", text: { body: text } });
}

/**
 * Send an image message
 */
export async function sendImageMessage(to, imageUrl, caption = "") {
  return sendMessage(to, {
    type: "image",
    image: { link: imageUrl, caption },
  });
}

/**
 * Send a video message
 */
export async function sendVideoMessage(to, videoUrl, caption = "") {
  return sendMessage(to, {
    type: "video",
    video: { link: videoUrl, caption },
  });
}

/**
 * Send a document message
 */
export async function sendDocumentMessage(to, documentUrl, filename, caption = "") {
  return sendMessage(to, {
    type: "document",
    document: { link: documentUrl, filename, caption },
  });
}

/**
 * Send interactive buttons (up to 3)
 */
export async function sendButtonMessage(to, bodyText, buttons, headerText = "", footerText = "") {
  const action = {
    buttons: buttons.map((btn, i) => ({
      type: "reply",
      reply: { id: btn.id || `btn_${i}`, title: btn.title.slice(0, 20) },
    })),
  };

  const interactive = { type: "button", body: { text: bodyText }, action };
  if (headerText) interactive.header = { type: "text", text: headerText };
  if (footerText) interactive.footer = { text: footerText };

  return sendMessage(to, { type: "interactive", interactive });
}

/**
 * Send interactive list message
 */
export async function sendListMessage(to, bodyText, buttonText, sections, headerText = "", footerText = "") {
  const interactive = {
    type: "list",
    body: { text: bodyText },
    action: { button: buttonText, sections },
  };
  if (headerText) interactive.header = { type: "text", text: headerText };
  if (footerText) interactive.footer = { text: footerText };

  return sendMessage(to, { type: "interactive", interactive });
}

/**
 * Mark a message as read
 */
export async function markAsRead(messageId) {
  try {
    await axios.post(
      `${whatsapp.baseUrl}/messages`,
      { messaging_product: "whatsapp", status: "read", message_id: messageId },
      { headers: getHeaders() }
    );
  } catch (err) {
    console.error("Failed to mark as read:", err.response?.data || err.message);
  }
}

/**
 * Core message sender with retry logic
 */
async function sendMessage(to, messagePayload, retries = 2) {
  const payload = { messaging_product: "whatsapp", to, ...messagePayload };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(
        `${whatsapp.baseUrl}/messages`,
        payload,
        { headers: getHeaders(), timeout: 10000 }
      );
      return response.data;
    } catch (err) {
      const status = err.response?.status;
      if (attempt < retries && status && status >= 500) {
        await sleep(1000 * (attempt + 1)); // exponential back-off
        continue;
      }
      console.error(
        `WhatsApp send failed (attempt ${attempt + 1}):`,
        err.response?.data || err.message
      );
      throw err;
    }
  }
}

function getHeaders() {
  return {
    Authorization: `Bearer ${whatsapp.accessToken}`,
    "Content-Type": "application/json",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
