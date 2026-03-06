import { generateResponse } from "../services/ai.js";
import { getSession, addMessage, updateState, setConsent, updateLeadData } from "../services/session.js";
import { captureLead, shouldAutoEscalate } from "../services/leadCapture.js";
import {
  sendTextMessage,
  sendButtonMessage,
  sendListMessage,
  sendImageMessage,
  sendVideoMessage,
  markAsRead,
} from "../services/whatsapp.js";
import { getAllProperties, getPropertyById, formatPropertyCard } from "../data/properties.js";
import { createViewing, formatViewingPending, formatViewingConfirmed, getUserViewings, updateViewingStatus, resolveDate, resolveTime, formatDateNice, formatTimeNice, getAvailableSlots, validateBusinessHours, getNextBusinessDay } from "../services/viewingScheduler.js";
import { sendViewingConfirmationEmail } from "../services/email.js";
import config from "../config/index.js";

// Base URL for serving uploaded images (needed for WhatsApp absolute URLs)
const BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://localhost:${config.port}`;

// --- Message deduplication (prevents duplicate processing from webhook retries) ---
const recentMessageIds = new Set();
const DEDUP_TTL = 60_000; // 60 seconds

function isDuplicate(messageId) {
  if (recentMessageIds.has(messageId)) return true;
  recentMessageIds.add(messageId);
  setTimeout(() => recentMessageIds.delete(messageId), DEDUP_TTL);
  return false;
}

/**
 * Main conversation handler — routes every incoming message through the AI pipeline.
 */
export async function handleIncomingMessage(messagePayload) {
  const { from, messageId, type, text, interactive } = normalizePayload(messagePayload);

  if (!from || !messageId) return;

  // Deduplicate webhook retries
  if (isDuplicate(messageId)) {
    console.log(`[Dedup] Skipping duplicate message ${messageId}`);
    return;
  }

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
      session.metadata = session.metadata || {};
      session.metadata.consentDeclined = false;

      // Check if the user was trying to schedule a viewing before consent
      const pendingProperty = session.metadata.pendingViewingProperty;
      delete session.metadata.pendingViewingProperty;

      // If name already collected (user was in limited mode), go straight to ACTIVE
      if (session.leadData?.name) {
        await updateState(from, "ACTIVE");

        // Resume pending viewing flow instead of generic welcome
        if (pendingProperty && pendingProperty !== "general") {
          const property = await getPropertyById(pendingProperty);
          const propertyName = property?.name || "the property";
          await sendTextMessage(from, `Thank you for your consent, *${session.leadData.name}*! 🙏\n\nLet's continue with scheduling your visit to *${propertyName}*.`);
          session.metadata.scheduling = pendingProperty;
          await addMessage(from, "user", `I'd like to schedule a viewing for ${propertyName}`);
          const aiResult = await generateAIResponseFull(from, session);
          if (aiResult.leadData) await captureLead(from, aiResult.leadData);
          await sendTextMessage(from, aiResult.text);
          if (aiResult.scheduleViewing) {
            await handleViewingSchedule(from, aiResult.scheduleViewing);
          }
        } else if (pendingProperty === "general") {
          await sendTextMessage(from, `Thank you for your consent, *${session.leadData.name}*! 🙏\n\nLet's schedule your property viewing. Which property are you interested in visiting?`);
          await sendPropertyList(from);
        } else {
          await sendTextMessage(from, `Thank you for your consent, *${session.leadData.name}*! 🙏\n\nYou now have full access. How may I assist you today?`);
          setTimeout(() => sendMainMenu(from), 1500);
        }
      } else {
        await updateState(from, "AWAITING_NAME");
        await sendTextMessage(from, "Thank you for your consent! 🙏\n\nBefore we proceed, may I have your name, please?");
      }
      return;
    }
    if (interactiveId === "consent_decline") {
      session.metadata = session.metadata || {};
      session.metadata.consentDeclined = true;
      await updateState(from, "AWAITING_NAME");
      await sendTextMessage(from, `No problem at all! Your privacy is important to us. 🔒\n\nYou can still browse our properties and learn about what we offer. However, please note that scheduling viewings and personalised services will require your consent.\n\nBefore we begin, may I have your name so I can address you properly?`);
      return;
    }

    // Property detail view from list selection
    if (interactiveId.startsWith("property_")) {
      const propertyId = interactiveId.replace("property_", "");
      const property = await getPropertyById(propertyId);
      if (!property) return;

      // 1. Send property card (emoji-formatted details)
      const card = formatPropertyCard(property);
      await sendTextMessage(from, card);

      // 2. Send ALL images
      await sendPropertyImages(from, propertyId);

      // 3. Generate and send AI description
      await addMessage(from, "user", `Tell me about ${interactive?.list_reply?.title || propertyId}`);
      const aiResult = await generateAIResponseFull(from, session);
      if (aiResult.leadData) await captureLead(from, aiResult.leadData);
      await sendTextMessage(from, aiResult.text);

      // 4. Track cooldown to prevent re-display in the next 5 minutes
      session.metadata = session.metadata || {};
      session.metadata.lastPropertyButtons = { propertyId, time: Date.now() };

      // 5. Send "What would you like to do?" action buttons
      const propertyButtons = property.status === "Sold Out"
        ? [
            { id: "view_properties", title: "More Properties" },
            { id: "speak_agent", title: "Speak to Agent" },
          ]
        : [
            { id: `schedule_${property.id}`, title: "Schedule Visit" },
            { id: "view_properties", title: "More Properties" },
            { id: "speak_agent", title: "Speak to Agent" },
          ];
      await sendButtonMessage(
        from,
        property.status === "Sold Out"
          ? `This property is currently *sold out*. Would you like to explore other options?`
          : `What would you like to do?`,
        propertyButtons,
        property.name
      );
      return;
    }

    // Schedule viewing button from property detail
    if (interactiveId.startsWith("schedule_")) {
      // Check consent before allowing viewing
      if (!session.consentGiven) {
        session.metadata = session.metadata || {};
        session.metadata.pendingViewingProperty = interactiveId.replace("schedule_", "");
        await sendConsentForViewing(from);
        return;
      }
      const propertyId = interactiveId.replace("schedule_", "");
      const property = await getPropertyById(propertyId);
      const propertyName = property?.name || "a property";
      // Set scheduling flag to suppress duplicate property buttons
      session.metadata = session.metadata || {};
      session.metadata.scheduling = propertyId;
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
      // Check consent before allowing viewing
      if (!session.consentGiven) {
        session.metadata = session.metadata || {};
        session.metadata.pendingViewingProperty = "general";
        await sendConsentForViewing(from);
        return;
      }
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

  // --- GDPR Consent check (first interaction only) ---
  if (!session.consentGiven && !session.metadata?.consentDeclined && session.history.length === 0) {
    await sendConsentRequest(from);
    return;
  }

  // --- Name collection (after consent, before main conversation) ---
  if (session.state === "AWAITING_NAME") {
    let name = userText.trim();
    // Extract name from phrases like "My name is John" or "I'm John"
    const nameMatch = name.match(/(?:my name is|i'm|i am|it's|call me)\s+(.+)/i);
    if (nameMatch) name = nameMatch[1].trim();
    name = name.replace(/[.!,]+$/, '').trim(); // clean trailing punctuation

    if (name.length > 0 && name.length < 100 && !name.startsWith('/')) {
      await updateLeadData(from, { name });
      await updateState(from, "ACTIVE");
      await addMessage(from, "user", userText);
      await addMessage(from, "assistant", `Welcome, ${name}! How may I assist you today?`);
      await sendTextMessage(from, `Welcome, *${name}*! 🌟\n\nIt's a pleasure to have you here. How may I assist you in finding your perfect home today?`);
      setTimeout(() => sendMainMenu(from), 1500);
    } else {
      await sendTextMessage(from, "I'd love to address you properly. Could you please share your name?");
    }
    return;
  }

  // --- Email collection after viewing ---
  if (session.state === "AWAITING_EMAIL") {
    const emailMatch = userText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (emailMatch) {
      const email = emailMatch[0];
      await updateLeadData(from, { email });
      await updateState(from, "ACTIVE");
      await addMessage(from, "user", userText);

      // Send confirmation email if viewing exists
      const viewingId = session.metadata?.lastViewingId;
      if (viewingId) {
        const viewing = await (await import("../services/viewingScheduler.js")).getViewingById(viewingId);
        if (viewing) {
          const emailResult = await sendViewingConfirmationEmail(email, viewing);
          if (emailResult.sent) {
            await sendTextMessage(from, `📧 Thank you! A confirmation email has been sent to *${email}*.`);
          } else {
            await sendTextMessage(from, `📧 Thank you! We've noted your email: *${email}*. Our team will send you a detailed confirmation shortly.`);
          }
        } else {
          await sendTextMessage(from, `📧 Thank you! We've noted your email: *${email}*.`);
        }
      } else {
        await sendTextMessage(from, `📧 Thank you! We've noted your email: *${email}*.`);
      }
      await addMessage(from, "assistant", `Thank you, email noted: ${email}`);
      await sendTextMessage(from, `Is there anything else I can help you with? 😊`);
      return;
    }

    // User typed "skip" or "no" or didn't provide email
    const skip = userText.trim().toLowerCase();
    if (skip === "skip" || skip === "no" || skip === "no thanks" || skip === "later") {
      await updateState(from, "ACTIVE");
      await sendTextMessage(from, `No problem! If you'd like to provide your email later, just let me know. 😊\n\nIs there anything else I can help you with?`);
      return;
    }

    // Didn't look like an email — prompt again
    await sendTextMessage(from, `Please provide a valid email address, or type *skip* if you'd prefer not to.`);
    return;
  }

  // --- Viewing confirmation interception ---
  // When a viewing date/time was proposed and we're waiting for the client to confirm
  if (session.metadata?.pendingViewing) {
    const answer = userText.trim().toLowerCase();
    const isPositive = /^(yes|yeah|yep|yh|sure|ok|okay|correct|confirmed?|that'?s?\s*(right|correct|fine|good|great|perfect)|go ahead|proceed|please|pls|book it|y)$/i.test(answer);
    const isNegative = /^(no|nah|nope|wrong|change|cancel|not?\s*(right|correct)|different)$/i.test(answer);

    if (isPositive) {
      const pending = session.metadata.pendingViewing;
      delete session.metadata.pendingViewing;
      await addMessage(from, "user", userText);
      await confirmAndCreateViewing(from, pending);
      return;
    }

    if (isNegative) {
      delete session.metadata.pendingViewing;
      await addMessage(from, "user", userText);
      await sendTextMessage(from, "No problem! Please let me know your preferred date and time, and I'll arrange a new viewing for you. 😊");
      await addMessage(from, "assistant", "No problem! Please let me know your preferred date and time, and I'll arrange a new viewing for you.");
      return;
    }
    // If unclear, fall through to AI pipeline
  }

  // --- Suggested-date interception ---
  // When a viewing was rejected and the system suggested an alternative date,
  // intercept time-only replies (e.g. "10", "10am", "2pm") and use the suggested date.
  if (session.metadata?.suggestedDate && session.metadata?.suggestedProperty) {
    const timeCandidate = resolveTime(userText.trim());
    if (timeCandidate) {
      const sugDate = session.metadata.suggestedDate;
      const sugProp = session.metadata.suggestedProperty;
      console.log(`[Scheduling] Intercepted time-only reply "${userText}" — using suggested date ${sugDate}`);

      // Clear suggested context before creating
      delete session.metadata.suggestedDate;
      delete session.metadata.suggestedProperty;

      await addMessage(from, "user", userText);

      await handleViewingSchedule(from, {
        propertyId: sugProp.id,
        propertyName: sugProp.name,
        preferredDate: sugDate,
        preferredTime: timeCandidate,
        name: session.leadData?.name || "Not provided",
      });
      return;
    }
  }

  // --- AI conversation pipeline ---
  const pipelineStart = Date.now();
  await addMessage(from, "user", userText);
  const aiResult = await generateAIResponseFull(from, session);
  const aiDone = Date.now();

  // --- Post-AI processing (non-blocking where possible) ---

  // Lead capture runs in background — doesn't block the reply
  const leadWork = (async () => {
    if (aiResult.leadData) {
      await captureLead(from, aiResult.leadData);
    } else {
      const fallbackLead = extractLeadFromConversation(userText, aiResult.text, session);
      if (fallbackLead && Object.keys(fallbackLead).length > 0) {
        await captureLead(from, fallbackLead);
        console.log(`[Fallback] Extracted lead data from conversation:`, JSON.stringify(fallbackLead));
      }
    }
    if (aiResult.scheduleViewing) {
      const viewingLead = {};
      if (aiResult.scheduleViewing.name) viewingLead.name = aiResult.scheduleViewing.name;
      if (aiResult.scheduleViewing.propertyName) viewingLead.propertyInterest = aiResult.scheduleViewing.propertyName;
      if (Object.keys(viewingLead).length > 0) {
        await captureLead(from, viewingLead);
      }
    }
  })();

  // Fallback property detection (sync — fast, no DB call)
  if (!aiResult.showProperty) {
    const detected = await detectPropertyInText(aiResult.text);
    if (detected) {
      aiResult.showProperty = detected;
      console.log(`[Fallback] Detected property in AI text: ${detected}`);
    }
  }

  // Strip refusal text
  aiResult.text = cleanImageRefusals(aiResult.text);

  console.log(`[Chat] ${from} → ${userText}`);
  console.log(`[Chat] Bot → ${aiResult.text.slice(0, 150)}...`);

  // Detect if user is explicitly asking for images/photos
  const userExplicitlyAskedForImages = isExplicitImageRequest(userText);

  // Send media + text reply (this is the user-facing latency)
  const skipMedia = !!aiResult.scheduleViewing;
  const isScheduling = !!session.metadata?.scheduling;
  const lastButtons = session.metadata?.lastPropertyButtons;
  const recentlyShown = lastButtons &&
    lastButtons.propertyId === aiResult.showProperty &&
    (Date.now() - lastButtons.time) < 5 * 60 * 1000;
  // Also suppress if a viewing was recently booked for this property
  const viewingJustBooked = !!session.metadata?.lastViewingId;
  // Allow re-sending images when user explicitly asks for them
  const suppressPropertyUI = skipMedia || isScheduling || (recentlyShown && !userExplicitlyAskedForImages) || viewingJustBooked;

  if (aiResult.showProperty && !suppressPropertyUI) {
    // Send property card first, then images
    const showProp = await getPropertyById(aiResult.showProperty);
    if (showProp) {
      const card = formatPropertyCard(showProp);
      await sendTextMessage(from, card);
    }
    await sendPropertyImages(from, aiResult.showProperty);
  }

  await sendTextMessage(from, aiResult.text);
  const replySent = Date.now();
  console.log(`[Perf] Pipeline: AI=${aiDone - pipelineStart}ms | Reply=${replySent - aiDone}ms | Total=${replySent - pipelineStart}ms`);

  // --- Post-reply work (user already has the message) ---

  if (aiResult.showProperty && !suppressPropertyUI) {
    const prop = await getPropertyById(aiResult.showProperty);
    if (prop) {
      session.metadata = session.metadata || {};
      session.metadata.lastPropertyButtons = { propertyId: aiResult.showProperty, time: Date.now() };
      const pipelineButtons = prop.status === "Sold Out"
        ? [
            { id: "view_properties", title: "More Properties" },
            { id: "speak_agent", title: "Speak to Agent" },
          ]
        : [
            { id: `schedule_${prop.id}`, title: "Schedule Visit" },
            { id: "view_properties", title: "More Properties" },
            { id: "speak_agent", title: "Speak to Agent" },
          ];
      await sendButtonMessage(
        from,
        prop.status === "Sold Out"
          ? `This property is currently *sold out*. Would you like to explore other options?`
          : `What would you like to do?`,
        pipelineButtons,
        prop.name
      );
    }
  }

  if (aiResult.scheduleViewing) {
    await handleViewingSchedule(from, aiResult.scheduleViewing);
  }

  // Wait for background lead work to finish
  await leadWork;

  // Auto-escalate hot leads — only after sufficient conversation depth
  // Require at least 10 messages so the client has time to explore properties,
  // ask questions, view images, and potentially schedule a viewing before escalation.
  const updatedSession = await getSession(from);
  const hasEnoughDepth = updatedSession.history.length >= 10;
  if (shouldAutoEscalate(updatedSession) && updatedSession.state !== "ESCALATED" && hasEnoughDepth) {
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
    `👋 *Welcome to Devtraco Plus!*\n\nI'm your dedicated property assistant, here to help you discover premium residences across Accra's finest neighbourhoods.\n\nBefore we begin, a note on your privacy:\n\n📋 We may collect your name, contact information, and preferences to provide you with a tailored property experience.\n\n🔒 Your information is secure. We have suitable physical, electronic, and managerial procedures in place to safeguard your data. We will not sell, distribute, or lease your personal information to third parties unless required by law.\n\nFor our full privacy policy, please visit devtracoplus.com or email info@devtracoplus.com.\n\nDo you consent to proceed?`
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
 * Re-ask for consent when a non-consented user tries to book a viewing
 */
async function sendConsentForViewing(to) {
  await sendTextMessage(
    to,
    `To schedule a property viewing, we'll need to collect some of your details (name, contact, preferences) to coordinate with our team.\n\n🔒 Your information is secure and will only be used for this purpose.\n\nWould you like to provide your consent so we can arrange the viewing?`
  );

  await sendButtonMessage(
    to,
    "Your consent is needed to proceed:",
    [
      { id: "consent_accept", title: "✅ Yes, I agree" },
      { id: "speak_agent", title: "📞 Speak to Agent" },
    ],
    "Consent Required"
  );
}

/**
 * Fallback lead extraction: scan user message for budget, location, name patterns.
 * Only extracts data that isn't already captured in the session.
 */
function extractLeadFromConversation(userText, aiText, session) {
  const lead = {};
  const existing = session.leadData || {};
  const text = userText.toLowerCase();

  // Budget: match $XXX,XXX or XXX,XXX$ or XXXK or XXX dollars etc.
  if (!existing.budget) {
    const budgetMatch = userText.match(/\$\s?[\d,]+(?:\.\d+)?(?:k|m)?|\b[\d,]+(?:\.\d+)?\s*(?:dollars?|usd|\$)/i);
    if (budgetMatch) {
      lead.budget = budgetMatch[0].trim();
    }
  }

  // Preferred location: match known Ghana locations
  if (!existing.preferredLocation) {
    const locations = [
      "east legon", "cantonments", "roman ridge", "airport residential",
      "ridge", "labone", "osu", "dzorwulu", "north ridge", "adjiringanor",
      "tse addo", "la", "accra", "tema", "kumasi", "takoradi", "spintex",
      "trasacco", "au village", "community 25", "sakumono", "ashongman",
    ];
    for (const loc of locations) {
      if (text.includes(loc)) {
        lead.preferredLocation = loc.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
        break;
      }
    }
  }

  // Property interest: check if AI response mentions a specific property by name
  if (!existing.propertyInterest) {
    // Look for property names in the AI text context (e.g., "You've chosen Acasia Apartments")
    const propertyPatterns = [
      /(?:chosen|selected|interested in|recommend)\s+\*?([A-Z][A-Za-z\s']+?)(?:\*|!|\.|,|\n)/,
    ];
    for (const pat of propertyPatterns) {
      const match = aiText.match(pat);
      if (match && match[1].trim().length > 3) {
        lead.propertyInterest = match[1].trim();
        break;
      }
    }
  }

  // Email
  if (!existing.email) {
    const emailMatch = userText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (emailMatch) {
      lead.email = emailMatch[0];
    }
  }

  return lead;
}

/**
 * Fallback: detect a property name mentioned in AI text when SHOW_PROPERTY tag was omitted.
 * Returns the propertyId if a single property is clearly being discussed, otherwise null.
 */
async function detectPropertyInText(text) {
  try {
    const properties = await getAllProperties();
    const lower = text.toLowerCase();
    const matches = properties.filter(p => {
      const name = (p.name || "").toLowerCase();
      return name && lower.includes(name);
    });
    // Only auto-send if exactly one property is clearly referenced
    if (matches.length === 1) {
      return matches[0].propertyId || matches[0].id;
    }
  } catch (err) {
    console.warn("[Fallback] detectPropertyInText error:", err.message);
  }
  return null;
}

/**
 * Detect if user message is explicitly requesting images/photos of a property.
 */
function isExplicitImageRequest(text) {
  const lower = text.toLowerCase().trim();
  return /\b(show|send|see|view|get)\b.*\b(image|images|photo|photos|picture|pictures|pic|pics)\b/i.test(lower)
    || /\b(image|images|photo|photos|picture|pictures|pic|pics)\b.*\b(please|pls)?\b/i.test(lower)
    || /^(images?|photos?|pictures?|pics?)$/i.test(lower)
    || /\bi\s+(mean|want|need)\s+(an?\s+)?(image|photo|picture|pic)/i.test(lower);
}

/**
 * Strip sentences where the AI says it cannot show/display images.
 * These are incorrect — the system CAN send images via the SHOW_PROPERTY mechanism.
 */
function cleanImageRefusals(text) {
  // Remove sentences where AI says it cannot show/display/share images or videos.
  // Use can.?t to handle smart quotes (Unicode U+2019 right single quote vs ASCII)
  // Also remove "visit the website/link to see/watch" redirect sentences.
  //
  // Strategy: first strip entire lines that contain refusal + redirect combos,
  // then strip remaining individual refusal sentences.
  let cleaned = text;

  // Strip full lines/paragraphs that contain a refusal about images/videos
  // (handles multi-clause sentences with URLs containing dots)
  cleaned = cleaned.replace(
    /^.*?(?:can.?t|cannot|unable to|don.?t have the ability to)\s+(?:show|display|send|share)\s+(?:images|videos?|photos?|pictures?|visuals?).*$/gim,
    ""
  );

  // Strip "visit/follow this link ... to watch/see" redirect sentences
  cleaned = cleaned.replace(
    /^.*?(?:visit|follow|check out)\s+(?:this\s+)?link.*?(?:watch|see|view).*$/gim,
    ""
  );

  // Strip "you can find videos/images on our website" redirect sentences
  cleaned = cleaned.replace(
    /^.*?(?:you can find|check out)\s+(?:videos?|images?|photos?|visuals?|more visual content).*?(?:website|link).*$/gim,
    ""
  );

  // Clean up leftover blank lines
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned || text; // fallback to original if everything got stripped
}

/**
 * Send ALL property images and videos for a given propertyId.
 */
async function sendPropertyImages(to, propertyId) {
  const property = await getPropertyById(propertyId);
  if (!property) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Build all media tasks and send in parallel with a small stagger
  const tasks = [];

  if (property.images && property.images.length > 0) {
    property.images.forEach((img, i) => {
      tasks.push(async () => {
        await sleep(i * 300); // small stagger to preserve order
        let imageUrl = img.startsWith("/") ? `${BASE_URL}${img}` : img;
        const caption = i === 0
          ? `${property.name} — ${property.location} (${i + 1}/${property.images.length})`
          : `${property.name} (${i + 1}/${property.images.length})`;
        console.log(`[Property] Sending image ${i + 1}/${property.images.length} for ${propertyId}`);
        await sendImageMessage(to, imageUrl, caption);
      });
    });
  } else {
    console.log(`[Property] No images available for ${propertyId}`);
  }

  if (property.videos && property.videos.length > 0) {
    const imgCount = property.images ? property.images.length : 0;
    property.videos.forEach((vid, i) => {
      tasks.push(async () => {
        await sleep((imgCount + i) * 300);
        let videoUrl = vid.startsWith("/") ? `${BASE_URL}${vid}` : vid;
        const caption = `${property.name} — Video ${i + 1}/${property.videos.length}`;
        console.log(`[Property] Sending video ${i + 1}/${property.videos.length} for ${propertyId}`);
        await sendVideoMessage(to, videoUrl, caption);
      });
    });
  }

  // Fire all in parallel — stagger keeps them roughly ordered
  await Promise.all(tasks.map((fn) => fn().catch((err) => {
    console.warn(`[Property] Media send failed for ${propertyId}:`, err.message);
  })));
}

/**
 * Send detailed property view — card text → images → action buttons.
 * Used by non-AI flows (e.g. /properties command). For the interactive
 * list selection, the property_ handler orchestrates the full flow
 * (card → images → AI description → buttons).
 */
async function sendPropertyDetail(to, propertyId) {
  const property = await getPropertyById(propertyId);
  if (!property) return;

  // 1. Send property card text first
  const card = formatPropertyCard(property);
  await sendTextMessage(to, card);

  // 2. Send ALL images
  await sendPropertyImages(to, propertyId);

  // 3. Send action buttons
  const detailButtons = property.status === "Sold Out"
    ? [
        { id: "view_properties", title: "More Properties" },
        { id: "speak_agent", title: "Speak to Agent" },
      ]
    : [
        { id: `schedule_${property.id}`, title: "Schedule Visit" },
        { id: "view_properties", title: "More Properties" },
        { id: "speak_agent", title: "Speak to Agent" },
      ];
  await sendButtonMessage(
    to,
    property.status === "Sold Out"
      ? `This property is currently *sold out*. Would you like to explore other options?`
      : `What would you like to do?`,
    detailButtons,
    property.name
  );
}

/**
 * Handle viewing schedule from AI response
 */
async function handleViewingSchedule(to, scheduleData) {
  const session = await getSession(to);

  // Block viewing without consent
  if (!session.consentGiven) {
    session.metadata = session.metadata || {};
    if (scheduleData.propertyId && scheduleData.propertyId !== "unknown") {
      session.metadata.pendingViewingProperty = scheduleData.propertyId;
    } else {
      session.metadata.pendingViewingProperty = "general";
    }
    await sendConsentForViewing(to);
    return;
  }

  // Block viewing for sold-out properties
  if (scheduleData.propertyId && scheduleData.propertyId !== "unknown") {
    const property = await getPropertyById(scheduleData.propertyId);
    if (property && property.status === "Sold Out") {
      const msg = `We appreciate your interest in *${property.name}*! Unfortunately, this property is currently *sold out* — all units have been taken.\n\nI'd be happy to suggest similar available properties. Would you like me to recommend alternatives?`;
      await sendTextMessage(to, msg);
      await addMessage(to, "assistant", msg);
      return;
    }
  }

  // Resolve the date/time now so we can show the client the interpreted result
  const resolvedDate = resolveDate(scheduleData.preferredDate) || scheduleData.preferredDate || "To be confirmed";
  const resolvedTime = resolveTime(scheduleData.preferredTime) || scheduleData.preferredTime || "To be confirmed";

  // Pre-validate business hours
  if (resolvedDate && resolvedDate !== "To be confirmed") {
    const bizCheck = validateBusinessHours(resolvedDate, resolvedTime !== "To be confirmed" ? resolvedTime : null);
    if (!bizCheck.valid) {
      await sendTextMessage(to, `⚠️ ${bizCheck.reason}`);
      await addMessage(to, "assistant", `⚠️ ${bizCheck.reason}`);
      return;
    }
  }

  // Pre-validate 24-hour advance rule
  if (resolvedDate && resolvedDate !== "To be confirmed") {
    const requestedDate = new Date(resolvedDate + (resolvedTime !== "To be confirmed" ? `T${resolvedTime}:00` : "T23:59:59"));
    const minDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    if (!isNaN(requestedDate.getTime()) && requestedDate < minDate) {
      const nextBiz = getNextBusinessDay();
      const slots = await getAvailableSlots(nextBiz, scheduleData.propertyId);
      const slotText = slots.length > 0
        ? `\n\nThe next available date is *${formatDateNice(nextBiz)}*. Available slots:\n${slots.map(s => `• ${formatTimeNice(s)}`).join("\n")}`
        : "";
      const reason = `All property viewings must be scheduled at least 24 hours in advance. Please choose a later date.${slotText}`;
      await sendTextMessage(to, `⚠️ ${reason}`);
      session.metadata = session.metadata || {};
      if (nextBiz) {
        session.metadata.suggestedDate = nextBiz;
        session.metadata.suggestedProperty = {
          id: scheduleData.propertyId || "unknown",
          name: scheduleData.propertyName || "Not specified",
        };
      }
      await addMessage(to, "assistant", `⚠️ ${reason}`);
      return;
    }
  }

  const dateDisplay = formatDateNice(resolvedDate);
  const timeDisplay = formatTimeNice(resolvedTime);
  const propertyName = scheduleData.propertyName || "Not specified";
  const clientName = scheduleData.name || session.leadData?.name || "Valued Client";

  // Store pending viewing in session for confirmation
  session.metadata = session.metadata || {};
  session.metadata.pendingViewing = {
    ...scheduleData,
    resolvedDate,
    resolvedTime,
  };

  // Ask client to confirm
  const confirmMsg = `${clientName}, I'd like to schedule your viewing for *${propertyName}* on *${dateDisplay}* at *${timeDisplay}*.\n\nIs that correct?`;
  await sendTextMessage(to, confirmMsg);
  await addMessage(to, "assistant", confirmMsg);
}

/**
 * Actually create the viewing after client confirms.
 */
async function confirmAndCreateViewing(to, pendingData) {
  const session = await getSession(to);

  const viewing = await createViewing({
    userId: to,
    propertyId: pendingData.propertyId || "unknown",
    propertyName: pendingData.propertyName || "Not specified",
    preferredDate: pendingData.resolvedDate || pendingData.preferredDate || "To be confirmed",
    preferredTime: pendingData.resolvedTime || pendingData.preferredTime || "To be confirmed",
    name: pendingData.name || session.leadData?.name || "Not provided",
    phone: to,
    email: session.leadData?.email || "Not provided",
    notes: pendingData.notes || "",
  });

  // Handle rejections (slot taken, etc.)
  if (viewing.rejected) {
    await sendTextMessage(to, `⚠️ ${viewing.reason}`);
    session.metadata = session.metadata || {};
    if (viewing.suggestedDate) {
      session.metadata.suggestedDate = viewing.suggestedDate;
      session.metadata.suggestedProperty = {
        id: pendingData.propertyId || "unknown",
        name: pendingData.propertyName || "Not specified",
      };
    }
    await addMessage(to, "assistant", `⚠️ ${viewing.reason}`);
    return;
  }

  // Success — clear scheduling flag
  session.metadata = session.metadata || {};
  session.metadata.scheduling = null;
  session.metadata.suggestedDate = null;
  session.metadata.suggestedProperty = null;
  session.metadata.lastViewingId = viewing.viewingId;

  const clientName = viewing.name !== "Not provided" ? viewing.name : "Valued Client";
  const dateDisplay = formatDateNice(viewing.preferredDate);
  const timeDisplay = formatTimeNice(viewing.preferredTime);

  // Send submission confirmation
  const submissionMsg = [
    `I have submitted your viewing request for *${viewing.propertyName}* on *${dateDisplay} at ${timeDisplay}*. ✅`,
    ``,
    `📋 Reference: *${viewing.viewingId}*`,
    ``,
    `You will receive a confirmation call or message shortly, along with the contact details of your assigned Sales Executive.`,
    ``,
    `If you have any further questions or need assistance, please feel free to reach out. Thank you for choosing Devtraco Plus! 🙏`,
  ].join("\n");

  await sendTextMessage(to, submissionMsg);
  await addMessage(to, "assistant", submissionMsg);

  // Auto-confirm viewing after 10 seconds and notify customer
  setTimeout(async () => {
    try {
      const confirmed = await updateViewingStatus(viewing.viewingId, "CONFIRMED");
      if (confirmed) {
        await sendTextMessage(to, formatViewingConfirmed(confirmed));
        console.log(`[Viewing] Auto-confirmed ${viewing.viewingId} for ${to}`);

        // Send email if we have one
        if (session.leadData?.email && session.leadData.email !== "Not provided") {
          await sendViewingConfirmationEmail(session.leadData.email, confirmed);
        }

        // Ask for email after confirmation if not yet collected
        if (!session.leadData?.email || session.leadData.email === "Not provided") {
          setTimeout(async () => {
            await updateState(to, "AWAITING_EMAIL");
            await sendTextMessage(to, `📧 To send you a confirmation email with all the details, could you please share your email address?\n\nType *skip* if you'd prefer not to.`);
          }, 2000);
        }
      }
    } catch (err) {
      console.error(`[Viewing] Auto-confirm failed for ${viewing.viewingId}:`, err.message);
    }
  }, 10000);
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
        title: p.name.slice(0, 24),
        description: `${p.location} — From $${p.priceFrom.toLocaleString()}${p.status === "Sold Out" ? " (Sold Out)" : ""}`.slice(0, 72),
      })),
    });
  }
  if (houses.length > 0) {
    sections.push({
      title: "Townhouses & Townhomes",
      rows: houses.slice(0, 3).map((p) => ({
        id: `property_${p.id}`,
        title: p.name.slice(0, 24),
        description: `${p.location} — From $${p.priceFrom.toLocaleString()}${p.status === "Sold Out" ? " (Sold Out)" : ""}`.slice(0, 72),
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
    `👤 *Connecting you with a team member*\n\nI'm transferring you to one of our property consultants who'll be able to assist you further.\n\n📞 You can also reach us directly:\n• Call/WhatsApp: ${config.company.escalationWhatsApp}\n• Email: ${config.company.email}\n\n🕒 Business Hours: ${config.company.businessHours}\n\nA team member will respond shortly. Thank you for your patience! 🙏`
  );

  // Send client details to agent via WhatsApp
  try {
    const session = await getSession(to);
    const lead = session.leadData || {};
    const name = lead.name || "Not provided";
    const phone = lead.phone || to;
    const email = lead.email || "Not provided";
    const budget = lead.budget || "Not provided";
    const interest = lead.propertyInterest || "Not provided";
    const location = lead.preferredLocation || "Not provided";

    const agentNumber = config.company.escalationWhatsApp.replace("+", "");
    await sendTextMessage(
      agentNumber,
      `🔔 *New Client Escalation*\n\n` +
      `👤 *Name:* ${name}\n` +
      `📱 *Phone:* +${phone}\n` +
      `📧 *Email:* ${email}\n` +
      `💰 *Budget:* ${budget}\n` +
      `🏠 *Property Interest:* ${interest}\n` +
      `📍 *Preferred Location:* ${location}\n\n` +
      `📝 *Reason:* ${reason}\n\n` +
      `Please reach out to the client as soon as possible.`
    );
    console.log(`[Escalation] Sent client info to agent ${agentNumber}`);
  } catch (err) {
    console.error(`[Escalation] Failed to notify agent:`, err.message);
  }

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
