import express from "express";
import config from "../config/index.js";
import { handleIncomingMessage } from "../handlers/messageHandler.js";

const router = express.Router();

/**
 * GET /webhook — Verify webhook with Meta
 */
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.whatsapp.verifyToken) {
    console.log("[Webhook] Verified successfully");
    return res.status(200).send(challenge);
  }

  console.warn("[Webhook] Verification failed — token mismatch");
  res.sendStatus(403);
});

/**
 * POST /webhook — Receive WhatsApp messages
 */
router.post("/webhook", async (req, res) => {
  // Immediately acknowledge to avoid Meta retries
  res.sendStatus(200);

  try {
    const entry = req.body?.entry;
    if (!entry) return;

    for (const e of entry) {
      const changes = e.changes || [];
      for (const change of changes) {
        const value = change.value;

        // Process messages
        const messages = value?.messages || [];
        for (const message of messages) {
          const msgContent = message.text?.body
            || message.interactive?.button_reply?.title
            || message.interactive?.list_reply?.title
            || `[${message.type}]`;
          console.log(`[Message] From: ${message.from} | Type: ${message.type} | Content: ${msgContent}`);
          // Fire and forget — don't block the webhook response
          handleIncomingMessage(message).catch((err) => {
            console.error(`[Message] Handler error for ${message.from}:`, err.message);
          });
        }

        // Process status updates (delivered, read, etc.)
        const statuses = value?.statuses || [];
        for (const status of statuses) {
          console.log(
            `[Status] Message ${status.id} → ${status.status} (${status.recipient_id})`
          );
        }
      }
    }
  } catch (err) {
    console.error("[Webhook] Processing error:", err.message);
  }
});

export default router;
