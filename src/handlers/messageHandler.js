import { generateResponse } from "../services/ai.js";
import { getSession, addMessage, updateState, setConsent } from "../services/session.js";
import { captureLead, shouldAutoEscalate } from "../services/leadCapture.js";
import {
  sendTextMessage,
  sendButtonMessage,
  sendListMessage,
  sendImageMessage,
  markAsRead,
} from "../services/whatsapp.js";
import { getAllProperties, getPropertyById, formatPropertyCard } from "../data/properties.js";
import { createViewing, formatViewingConfirmation, getUserViewings } from "../services/viewingScheduler.js";
import config from "../config/index.js";

// Base URL for serving uploaded images (needed for WhatsApp absolute URLs)
const BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://localhost:${config.port}`;

/**
 * Main conversation handler — routes every incoming message through the AI pipeline.
 */
export async function handleIncomingMessage(messagePayload) {
  const { from, messageId, type, text, interactive } = normalizePayload(messagePayload);

  if (!from || !messageId) return;

  // Mark as read immediately for good UX
  markAsRead(messageId);

  const session = await getSession(from);
  const userText = extractUserText(type, text, interactive);

  if (!userText) return; // unsupported message type

  // --- Command shortcuts ---
  const command = userText.trim().toLowerCase();

  if (command === "/reset" || command === "start over") {
    await updateState(from, "GREETING");
    session.history = [];
    await sendTextMessage(from, "🔄 Conversation reset! How can I help you today?");
    return;
  }

  if (command === "/menu" || command === "menu") {
    await sendMainMenu(from);
    return;
  }

  if (command === "/properties" || command === "view properties") {
    await sendPropertyList(from);
    return;
  }

  if (command === "/agent" || command === "speak to agent" || command === "human agent") {
    await handleEscalation(from, "Customer requested human agent");
    return;
  }

  if (command === "/viewings" || command === "my viewings") {
    await sendUserViewings(from);
    return;
  }

  // --- Handle interactive button/list replies ---
  if (type === "interactive") {
    const interactiveId = interactive?.button_reply?.id || interactive?.list_reply?.id || "";

    // GDPR consent responses
    if (interactiveId === "consent_accept") {
      await setConsent(from, true);
      await updateState(from, "ACTIVE");
      await sendTextMessage(from, "Thank you! 🙏 I'm happy to assist you. How can I help you find your perfect home today?");
      setTimeout(() => sendMainMenu(from), 1500);
      return;
    }
    if (interactiveId === "consent_decline") {
      await sendTextMessage(from, `No problem! If you change your mind, just send us a message anytime.\n\nYou can also reach us directly:\n📞 ${config.company.cellPhone}\n📧 ${config.company.email}`);
      return;
    }

    // Property detail view from list selection
    if (interactiveId.startsWith("property_")) {
      const propertyId = interactiveId.replace("property_", "");
      await sendPropertyDetail(from, propertyId);
      // Also feed it to the AI so conversation stays contextual
      await addMessage(from, "user", `Tell me about ${interactive?.list_reply?.title || propertyId}`);
      const aiResult = await generateAIResponseFull(from, session);
      if (aiResult.leadData) await captureLead(from, aiResult.leadData);
      await sendTextMessage(from, aiResult.text);
      return;
    }

    // Schedule viewing button from property detail
    if (interactiveId.startsWith("schedule_")) {
      const propertyId = interactiveId.replace("schedule_", "");
      const property = await getPropertyById(propertyId);
      const propertyName = property?.name || "a property";
      await addMessage(from, "user", `I'd like to schedule a viewing for ${propertyName}`);
      const aiResult = await generateAIResponseFull(from, session);
      if (aiResult.leadData) await captureLead(from, aiResult.leadData);
      await sendTextMessage(from, aiResult.text);
      if (aiResult.scheduleViewing) {
        await handleViewingSchedule(from, aiResult.scheduleViewing);
      }
      return;
    }

    // "View Properties" button
    if (interactiveId === "view_properties") {
      await sendPropertyList(from);
      return;
    }

    // "Schedule Visit" button
    if (interactiveId === "schedule_viewing") {
      await addMessage(from, "user", "I'd like to schedule a property viewing");
      const aiResult = await generateAIResponseFull(from, session);
      if (aiResult.leadData) await captureLead(from, aiResult.leadData);
      await sendTextMessage(from, aiResult.text);
      return;
    }

    // "Speak to Agent" button
    if (interactiveId === "speak_agent") {
      await handleEscalation(from, "Customer requested human agent via menu");
      return;
    }
  }

  // --- GDPR Consent check (first interaction) ---
  if (!session.consentGiven && session.history.length === 0) {
    await sendConsentRequest(from);
    return;
  }

  // If consent was asked but not yet given, remind them
  if (!session.consentGiven) {
    await sendConsentRequest(from);
    return;
  }

  // --- AI conversation pipeline ---
  await addMessage(from, "user", userText);
  const aiResult = await generateAIResponseFull(from, session);

  // Handle lead data capture
  if (aiResult.leadData) {
    await captureLead(from, aiResult.leadData);
  }

  // Log the conversation
  console.log(`[Chat] ${from} → ${userText}`);
  console.log(`[Chat] Bot → ${aiResult.text.slice(0, 150)}...`);

  // If AI referenced a specific property, send its image first
  if (aiResult.showProperty) {
    await sendPropertyImages(from, aiResult.showProperty);
  }

  // Send the response
  await sendTextMessage(from, aiResult.text);

  // If AI referenced a specific property, send action buttons after the text
  if (aiResult.showProperty) {
    const prop = await getPropertyById(aiResult.showProperty);
    if (prop) {
      await sendButtonMessage(
        from,
        `Interested in *${prop.name}*?`,
        [
          { id: `schedule_${prop.id}`, title: "Schedule Visit" },
          { id: "view_properties", title: "More Properties" },
          { id: "speak_agent", title: "Speak to Agent" },
        ],
        prop.name
      );
    }
  }

  // Handle viewing schedule from AI
  if (aiResult.scheduleViewing) {
    await handleViewingSchedule(from, aiResult.scheduleViewing);
  }

  // Auto-escalate hot leads
  const updatedSession = await getSession(from);
  if (shouldAutoEscalate(updatedSession) && updatedSession.state !== "ESCALATED") {
    await updateState(from, "ESCALATED");
    setTimeout(async () => {
      await sendTextMessage(
        from,
        "🌟 Great news! Based on our conversation, I'd love to connect you with one of our property consultants who can give you more personalized assistance. A team member will reach out to you shortly!"
      );
    }, 2000);
    console.log(`[Escalation] Auto-escalating HOT lead: ${from}`);
  }

  // Handle explicit escalation from AI
  if (aiResult.escalate) {
    await handleEscalation(from, aiResult.escalate);
  }
}

/**
 * Full AI response with structured data
 */
async function generateAIResponseFull(from, session) {
  const result = await generateResponse(session.history);
  await addMessage(from, "assistant", result.text);
  return result;
}

/**
 * Send GDPR/data consent request
 */
async function sendConsentRequest(to) {
  await sendTextMessage(
    to,
    `👋 *Welcome to Devtraco Plus!*\n\nI'm your AI property assistant. Before we begin, I'd like to let you know:\n\n📋 We collect basic information (name, email, preferences) to provide personalized property recommendations and improve your experience.\n\n🔒 Your data is secure and will only be used for property-related communication. You can request data deletion anytime.\n\nDo you consent to proceed?`
  );

  await sendButtonMessage(
    to,
    "Please confirm to continue:",
    [
      { id: "consent_accept", title: "✅ Yes, I agree" },
      { id: "consent_decline", title: "❌ No, thanks" },
    ],
    "Data Privacy",
    "We respect your privacy"
  );
}

/**
 * Send property images for a given propertyId (used by both AI pipeline and interactive list).
 */
async function sendPropertyImages(to, propertyId) {
  const property = await getPropertyById(propertyId);
  if (!property) return;

  if (property.images && property.images.length > 0) {
    try {
      let imageUrl = property.images[0];
      if (imageUrl.startsWith("/")) {
        imageUrl = `${BASE_URL}${imageUrl}`;
      }
      console.log(`[Property] Sending image for ${propertyId}: ${imageUrl}`);
      await sendImageMessage(
        to,
        imageUrl,
        `${property.name} — ${property.location}`
      );
    } catch (err) {
      console.warn(`[Property] Failed to send image for ${propertyId}:`, err.message);
    }
  } else {
    console.log(`[Property] No images available for ${propertyId}`);
  }
}

/**
 * Send detailed property view with image (triggered by interactive list selection)
 */
async function sendPropertyDetail(to, propertyId) {
  const property = await getPropertyById(propertyId);
  if (!property) return;

  // Send image
  await sendPropertyImages(to, propertyId);

  // Send property details
  const card = formatPropertyCard(property);
  await sendTextMessage(to, card);

  // Send action buttons
  await sendButtonMessage(
    to,
    `Interested in *${property.name}*?`,
    [
      { id: `schedule_${property.id}`, title: "Schedule Visit" },
      { id: "view_properties", title: "More Properties" },
      { id: "speak_agent", title: "Speak to Agent" },
    ],
    property.name
  );
}

/**
 * Handle viewing schedule from AI response
 */
async function handleViewingSchedule(to, scheduleData) {
  const session = await getSession(to);
  const viewing = await createViewing({
    userId: to,
    propertyId: scheduleData.propertyId || "unknown",
    propertyName: scheduleData.propertyName || "Not specified",
    preferredDate: scheduleData.preferredDate || "To be confirmed",
    preferredTime: scheduleData.preferredTime || "To be confirmed",
    name: scheduleData.name || session.leadData.name || "Not provided",
    phone: to,
    email: session.leadData.email || "Not provided",
    notes: scheduleData.notes || "",
  });

  // Send confirmation
  setTimeout(async () => {
    await sendTextMessage(to, formatViewingConfirmation(viewing));
  }, 1500);
}

/**
 * Send user's viewing history
 */
async function sendUserViewings(to) {
  const viewings = await getUserViewings(to);
  if (viewings.length === 0) {
    await sendTextMessage(to, "📅 You don't have any scheduled viewings yet. Would you like to schedule one?");
    return;
  }

  const lines = viewings.map((v, i) =>
    `${i + 1}. *${v.propertyName}*\n   📋 Ref: ${v.id}\n   📆 ${v.preferredDate} at ${v.preferredTime}\n   📌 Status: ${v.status}`
  );

  await sendTextMessage(to, `📅 *Your Scheduled Viewings*\n\n${lines.join("\n\n")}`);
}

/**
 * Send main menu with quick action buttons
 */
async function sendMainMenu(to) {
  await sendButtonMessage(
    to,
    "What would you like to do? Choose an option below or just type your question! 😊",
    [
      { id: "view_properties", title: "🏠 View Properties" },
      { id: "schedule_viewing", title: "📅 Schedule Visit" },
      { id: "speak_agent", title: "👤 Speak to Agent" },
    ],
    "Devtraco Assistant",
    "Type 'menu' anytime to see this again"
  );
}

/**
 * Send the property listing (WhatsApp allows max 10 rows per list)
 */
async function sendPropertyList(to) {
  const properties = await getAllProperties();

  // Split into sections of max 10 total rows
  const apartments = properties.filter(p => p.type === "Apartments" || p.type === "Hotel Apartments");
  const houses = properties.filter(p => p.type === "Townhouses" || p.type === "Townhomes");

  const sections = [];
  if (apartments.length > 0) {
    sections.push({
      title: "Apartments",
      rows: apartments.slice(0, 7).map((p) => ({
        id: `property_${p.id}`,
        title: p.name,
        description: `${p.location} — From $${p.priceFrom.toLocaleString()}`,
      })),
    });
  }
  if (houses.length > 0) {
    sections.push({
      title: "Townhouses & Townhomes",
      rows: houses.slice(0, 3).map((p) => ({
        id: `property_${p.id}`,
        title: p.name,
        description: `${p.location} — From $${p.priceFrom.toLocaleString()}`,
      })),
    });
  }

  await sendListMessage(
    to,
    "Here are our available properties. Tap below to explore! 🏡",
    "Browse Properties",
    sections,
    "Devtraco Plus Properties"
  );
}

/**
 * Handle escalation to human agent
 */
async function handleEscalation(to, reason) {
  await updateState(to, "ESCALATED");
  await sendTextMessage(
    to,
    `👤 *Connecting you with a team member*\n\nI'm transferring you to one of our property consultants who'll be able to help you further.\n\n📞 You can also reach us directly:\n• Office: ${config.company.phone}\n• Cell: ${config.company.cellPhone}\n• Email: ${config.company.email}\n\nA team member will respond shortly. Thank you for your patience! 🙏`
  );
  console.log(`[Escalation] ${to} — Reason: ${reason}`);
}

/**
 * Normalize the incoming WhatsApp payload
 */
function normalizePayload(messagePayload) {
  return {
    from: messagePayload.from,
    messageId: messagePayload.id,
    type: messagePayload.type,
    text: messagePayload.text?.body || "",
    interactive: messagePayload.interactive || null,
  };
}

/**
 * Extract readable user text from different message types
 */
function extractUserText(type, text, interactive) {
  switch (type) {
    case "text":
      return text;
    case "interactive":
      if (interactive?.type === "button_reply") {
        return interactive.button_reply?.title || interactive.button_reply?.id;
      }
      if (interactive?.type === "list_reply") {
        return interactive.list_reply?.title || interactive.list_reply?.id;
      }
      return null;
    case "image":
    case "video":
    case "document":
      return "I sent a media file";
    case "location":
      return "I shared my location";
    default:
      return null;
  }
}
