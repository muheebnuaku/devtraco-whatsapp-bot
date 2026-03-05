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
import { createViewing, formatViewingPending, formatViewingConfirmed, getUserViewings, updateViewingStatus, resolveDate, resolveTime, formatDateNice, formatTimeNice, getAvailableSlots } from "../services/viewingScheduler.js";
import { sendViewingConfirmationEmail } from "../services/email.js";
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
      await updateState(from, "AWAITING_NAME");
      await sendTextMessage(from, "Thank you for your consent! 🙏\n\nBefore we proceed, may I have your name, please?");
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
      const clientName = session.leadData?.name || "Valued Client";
      await sendTextMessage(from, `Thank you for your preferred date and time, ${clientName}. I will schedule your viewing for *${sugProp.name}* on *${formatDateNice(sugDate)} at ${formatTimeNice(timeCandidate)}*.\n\nLet me arrange that for you.`);
      await addMessage(from, "assistant", `Scheduling viewing for ${sugProp.name} on ${sugDate} at ${timeCandidate}`);

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

  // Send media + text reply (this is the user-facing latency)
  const skipMedia = !!aiResult.scheduleViewing;
  const isScheduling = !!session.metadata?.scheduling;
  const lastButtons = session.metadata?.lastPropertyButtons;
  const recentlyShown = lastButtons &&
    lastButtons.propertyId === aiResult.showProperty &&
    (Date.now() - lastButtons.time) < 5 * 60 * 1000;
  const suppressPropertyUI = skipMedia || isScheduling || recentlyShown;

  if (aiResult.showProperty && !suppressPropertyUI) {
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
      await sendButtonMessage(
        from,
        `What would you like to do?`,
        [
          { id: `schedule_${prop.id}`, title: "Schedule Visit" },
          { id: "view_properties", title: "More Properties" },
          { id: "speak_agent", title: "Speak to Agent" },
        ],
        prop.name
      );
    }
  }

  if (aiResult.scheduleViewing) {
    await handleViewingSchedule(from, aiResult.scheduleViewing);
  }

  // Wait for background lead work to finish
  await leadWork;

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
    `What would you like to do?`,
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
    name: scheduleData.name || session.leadData?.name || "Not provided",
    phone: to,
    email: session.leadData?.email || "Not provided",
    notes: scheduleData.notes || "",
  });

  // Handle rejections (24-hour rule, business hours, slot taken)
  if (viewing.rejected) {
    await sendTextMessage(to, `⚠️ ${viewing.reason}`);
    // Store suggested date/property so next time-only reply uses it
    session.metadata = session.metadata || {};
    if (viewing.suggestedDate) {
      session.metadata.suggestedDate = viewing.suggestedDate;
      session.metadata.suggestedProperty = {
        id: scheduleData.propertyId || "unknown",
        name: scheduleData.propertyName || "Not specified",
      };
    }
    // Add to conversation history so AI has context
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
      }
    } catch (err) {
      console.error(`[Viewing] Auto-confirm failed for ${viewing.viewingId}:`, err.message);
    }
  }, 10000);

  // Ask for email if not yet collected
  setTimeout(async () => {
    if (!session.leadData?.email || session.leadData.email === "Not provided") {
      await updateState(to, "AWAITING_EMAIL");
      await sendTextMessage(to, `📧 To send you a confirmation email with all the details, could you please share your email address?\n\nType *skip* if you'd prefer not to.`);
    }
  }, 3000);
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
        description: `${p.location} — From $${p.priceFrom.toLocaleString()}`.slice(0, 72),
      })),
    });
  }
  if (houses.length > 0) {
    sections.push({
      title: "Townhouses & Townhomes",
      rows: houses.slice(0, 3).map((p) => ({
        id: `property_${p.id}`,
        title: p.name.slice(0, 24),
        description: `${p.location} — From $${p.priceFrom.toLocaleString()}`.slice(0, 72),
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
    `👤 *Connecting you with a team member*\n\nI'm transferring you to one of our property consultants who'll be able to assist you further.\n\n📞 You can also reach us directly:\n• Office: ${config.company.phone}\n• WhatsApp: ${config.company.escalationWhatsApp}\n• Email: ${config.company.email}\n\n🕒 Business Hours: ${config.company.businessHours}\n\nA team member will respond shortly. Thank you for your patience! 🙏`
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
