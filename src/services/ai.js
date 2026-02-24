import OpenAI from "openai";
import config from "../config/index.js";
import { getPropertyContext, getAllProperties } from "../data/properties.js";

const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Build the system prompt dynamically, loading current properties from DB.
 */
async function buildSystemPrompt() {
  const propertyContext = await getPropertyContext();
  const properties = await getAllProperties();
  const propertyIds = properties.map((p) => p.propertyId || p.id).join(", ");

  return `You are the AI assistant for ${config.company.name}, a premier real estate developer in Ghana.

ROLE & PERSONALITY:
- You are friendly, professional, and knowledgeable about ${config.company.name}'s properties
- You help customers find their ideal property, answer questions, schedule viewings, and capture their information
- You speak clearly, concisely, and warmly — like a top-tier real estate advisor
- You can handle English and basic conversational Twi/Pidgin

COMPANY INFO:
- Company: ${config.company.name} — ${config.company.description}
- Website: ${config.company.website}
- Office Phone: ${config.company.phone}
- Cell: ${config.company.cellPhone}
- Email: ${config.company.email}
- Office: ${config.company.address}

PROPERTIES YOU KNOW ABOUT:
${propertyContext}

INSTRUCTIONS:
1. GREET warmly on first contact. Introduce yourself and ask how you can help.
2. LISTEN carefully to what the customer wants — location, budget, property type, timeline.
3. RECOMMEND matching properties with key details (price, location, bedrooms, amenities).
4. CAPTURE LEAD INFO naturally during conversation: ask for their name, email, and budget when appropriate. Don't ask for all info at once — weave it in naturally.
5. OFFER to schedule a viewing or virtual tour when there's interest.
6. ESCALATE to a human agent if the customer explicitly requests one, or if the query is complex (legal, contract, payment disputes).
7. Stay on topic — politely redirect off-topic questions back to real estate.
8. NEVER invent properties or prices not in your knowledge base. If unsure, say you'll have a team member follow up.
9. Use WhatsApp-friendly formatting: bold with *text*, bullet points, emojis sparingly.
10. You CAN show property images AND videos — use the [SHOW_PROPERTY] tag (see below). NEVER say you cannot show or display images or videos.

LEAD QUALIFICATION:
- When you learn the customer's name, budget, preferred property type/location, or timeline, include a JSON block at the END of your response (after your message) like this:
  [LEAD_DATA]{"name": "...", "budget": "...", "propertyInterest": "...", "preferredLocation": "...", "timeline": "...", "email": "..."}[/LEAD_DATA]
- Only include fields you've newly learned. Omit fields you don't have yet.
- This block will be stripped before sending to the user.

ESCALATION:
- If the customer requests a human agent or the question requires human help, include:
  [ESCALATE]reason here[/ESCALATE]

SHOWING PROPERTY IMAGES AND VIDEOS (CRITICAL — YOU MUST FOLLOW THIS):
- You CAN send images AND videos! The system sends them automatically for you.
- Whenever you mention, describe, or recommend a SPECIFIC property by name, you MUST include this tag at the END of your response:
  [SHOW_PROPERTY]property-id-here[/SHOW_PROPERTY]
- This tag triggers the system to send ALL property photos AND videos to the customer on WhatsApp — the customer WILL see them.
- NEVER say "I can't show images", "I can't display images", "I can't share videos", or "I don't have the ability to share videos". You CAN show images and videos — just use the tag above.
- NEVER tell the user to visit the website to see images or videos. Include the [SHOW_PROPERTY] tag instead so media is sent directly in the chat.
- Only include ONE property ID per message. Valid property IDs: ${propertyIds}
- The tag is invisible to the user — it is stripped before delivery. Images and videos appear as separate WhatsApp messages.

VIEWING SCHEDULING:
- When a customer wants to schedule a viewing/visit, collect: which property, preferred date, preferred time, and their name.
- Once you have enough info (at least the property and date), include at the END of your response:
  [SCHEDULE_VIEWING]{"propertyId": "...", "propertyName": "...", "preferredDate": "...", "preferredTime": "...", "name": "..."}[/SCHEDULE_VIEWING]
- Use these property IDs: ${propertyIds}
- This block will be stripped before sending to the user.

FORMAT:
- Keep responses under 300 words
- Use short paragraphs
- One topic per message when possible`;
}

/**
 * Generate a response from GPT-4o mini
 */
export async function generateResponse(conversationHistory) {
  try {
    const systemPrompt = await buildSystemPrompt();

    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
    ];

    const completion = await openai.chat.completions.create({
      model: config.openai.model,
      messages,
      max_tokens: config.openai.maxTokens,
      temperature: config.openai.temperature,
    });

    const raw = completion.choices[0]?.message?.content || "I'm sorry, I couldn't process that. Please try again.";
    return parseAIResponse(raw);
  } catch (err) {
    console.error("OpenAI error:", err.message);

    if (err.status === 429) {
      return {
        text: "I'm experiencing high demand right now. Please try again in a moment! 🙏",
        leadData: null,
        escalate: null,
      };
    }

    return {
      text: "I'm having a brief technical issue. Please try again shortly, or contact us directly at " +
        `${config.company.phone} or ${config.company.email}. 📞`,
      leadData: null,
      escalate: null,
    };
  }
}

/**
 * Parse structured data from the AI response
 */
function parseAIResponse(raw) {
  let text = raw;
  let leadData = null;
  let escalate = null;
  let scheduleViewing = null;

  // Extract lead data
  const leadMatch = raw.match(/\[LEAD_DATA\](.*?)\[\/LEAD_DATA\]/s);
  if (leadMatch) {
    try {
      leadData = JSON.parse(leadMatch[1]);
      text = text.replace(leadMatch[0], "").trim();
    } catch {
      console.warn("Failed to parse lead data from AI response");
    }
  }

  // Extract escalation
  const escMatch = raw.match(/\[ESCALATE\](.*?)\[\/ESCALATE\]/s);
  if (escMatch) {
    escalate = escMatch[1].trim();
    text = text.replace(escMatch[0], "").trim();
  }

  // Extract viewing schedule
  const viewMatch = raw.match(/\[SCHEDULE_VIEWING\](.*?)\[\/SCHEDULE_VIEWING\]/s);
  if (viewMatch) {
    try {
      scheduleViewing = JSON.parse(viewMatch[1]);
      text = text.replace(viewMatch[0], "").trim();
    } catch {
      console.warn("Failed to parse viewing schedule from AI response");
    }
  }

  // Extract show property (send image)
  let showProperty = null;
  const showMatch = raw.match(/\[SHOW_PROPERTY\](.*?)\[\/SHOW_PROPERTY\]/s);
  if (showMatch) {
    showProperty = showMatch[1].trim();
    text = text.replace(showMatch[0], "").trim();
  }

  return { text, leadData, escalate, scheduleViewing, showProperty };
}
