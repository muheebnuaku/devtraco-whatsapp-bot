import config from "../config/index.js";
import { getSession, updateLeadData } from "./session.js";
import { syncLeadToCRM } from "./crmSync.js";

/**
 * Captures lead data extracted by the AI and scores the lead.
 */
export function captureLead(userId, leadData) {
  if (!leadData || typeof leadData !== "object") return null;

  // Clean up the captured data
  const clean = {};
  for (const [key, value] of Object.entries(leadData)) {
    if (value && String(value).trim()) {
      clean[key] = String(value).trim();
    }
  }

  if (Object.keys(clean).length === 0) return null;

  const session = updateLeadData(userId, clean);
  console.log(
    `[Lead] ${userId} — score: ${session.leadScore} — data:`,
    JSON.stringify(session.leadData)
  );

  const result = {
    leadData: session.leadData,
    score: session.leadScore,
    tier: getLeadTier(session.leadScore),
  };

  // Sync to Dynamics 365 CRM (async, non-blocking)
  if (session.leadScore >= config.leadScoring.warm) {
    const report = formatLeadReport(session);
    syncLeadToCRM(report).catch((err) =>
      console.error(`[CRM] Background sync failed for ${userId}:`, err.message)
    );
  }

  return result;
}

/**
 * Get lead tier label based on score
 */
export function getLeadTier(score) {
  if (score >= config.leadScoring.hot) return "HOT";
  if (score >= config.leadScoring.warm) return "WARM";
  return "COLD";
}

/**
 * Format lead report for admin/CRM
 */
export function formatLeadReport(session) {
  const ld = session.leadData;
  const tier = getLeadTier(session.leadScore);

  return {
    userId: session.userId,
    name: ld.name || "Unknown",
    email: ld.email || "Not provided",
    phone: ld.phone || session.userId,
    budget: ld.budget || "Not specified",
    propertyInterest: ld.propertyInterest || "Not specified",
    preferredLocation: ld.preferredLocation || "Not specified",
    timeline: ld.timeline || "Not specified",
    score: session.leadScore,
    tier,
    conversationLength: session.history.length,
    firstContact: session.history[0]?.timestamp || null,
    lastContact: session.lastActivity,
    consentGiven: session.consentGiven,
  };
}

/**
 * Check if a lead should be escalated based on score
 */
export function shouldAutoEscalate(session) {
  return session.leadScore >= config.leadScoring.hot;
}
