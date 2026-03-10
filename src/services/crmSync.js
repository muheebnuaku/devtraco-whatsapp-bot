import axios from "axios";
import config from "../config/index.js";

/**
 * Microsoft Dynamics 365 CRM Integration Service
 *
 * Authenticates via Azure AD (OAuth2 client credentials flow)
 * and syncs leads, contacts, and appointments to Dynamics 365.
 *
 * Required environment variables:
 *   DYNAMICS_ORG_URL     — e.g. https://devtraco.crm.dynamics.com
 *   DYNAMICS_TENANT_ID   — Azure AD tenant ID
 *   DYNAMICS_CLIENT_ID   — Azure AD app registration client ID
 *   DYNAMICS_CLIENT_SECRET — Azure AD app registration secret
 */

// ───────── State ─────────
let accessToken = null;
let tokenExpiry = 0;
const syncQueue = []; // retry queue for failed syncs
let isProcessingQueue = false;
const syncLog = []; // audit log (last 200 entries)
const MAX_LOG = 200;

// ───────── Auth ─────────

/**
 * Get a valid access token, refreshing if expired.
 */
async function getAccessToken() {
  if (!config.dynamics.enabled) {
    throw new Error("Dynamics 365 CRM integration is not configured");
  }

  // Return cached token if still valid (with 5-min buffer)
  if (accessToken && Date.now() < tokenExpiry - 300_000) {
    return accessToken;
  }

  const tokenUrl = `https://login.microsoftonline.com/${config.dynamics.tenantId}/oauth2/v2.0/token`;

  try {
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.dynamics.clientId,
      client_secret: config.dynamics.clientSecret,
      scope: `${config.dynamics.orgUrl}/.default`,
    });

    const res = await axios.post(tokenUrl, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    });

    accessToken = res.data.access_token;
    tokenExpiry = Date.now() + res.data.expires_in * 1000;

    logSync("AUTH", "SUCCESS", "Token acquired", { expiresIn: res.data.expires_in });
    return accessToken;
  } catch (err) {
    const azureDetail = err.response?.data?.error_description
      || err.response?.data?.error
      || JSON.stringify(err.response?.data)
      || "";
    logSync("AUTH", "ERROR", "Failed to acquire token", {
      error: err.message,
      azureError: azureDetail,
      status: err.response?.status,
    });
    const detailMsg = azureDetail ? ` — ${azureDetail}` : "";
    throw new Error(`Dynamics 365 auth failed: ${err.message}${detailMsg}`);
  }
}

/**
 * Make an authenticated API call to Dynamics 365 Web API.
 */
async function dynamicsApi(method, endpoint, data = null) {
  const token = await getAccessToken();
  const url = `${config.dynamics.orgUrl}/api/data/v9.2/${endpoint}`;

  try {
    const res = await axios({
      method,
      url,
      data,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        Prefer: 'return=representation',
      },
      timeout: 20000,
    });
    return res;
  } catch (err) {
    // If 401, clear token so next call re-auths
    if (err.response?.status === 401) {
      accessToken = null;
      tokenExpiry = 0;
    }
    throw err;
  }
}

// ───────── Lead Sync ─────────

/**
 * Sync a lead to Dynamics 365.
 * Creates a Contact + a Lead entity linked to it.
 *
 * @param {Object} leadReport — output from formatLeadReport()
 * @returns {Object} — { contactId, leadId } or null
 */
export async function syncLeadToCRM(leadReport) {
  if (!config.dynamics.enabled) {
    console.log("[CRM] Dynamics 365 not configured — skipping sync");
    return null;
  }

  const syncId = `lead-${leadReport.phone}-${Date.now()}`;

  // 1. Check if contact already exists (by phone)
  const existing = await findContactByPhone(leadReport.phone);

  let contactId;
  if (existing) {
    contactId = existing.contactid;
    await updateContact(contactId, leadReport);
    logSync("CONTACT", "UPDATED", `Updated contact ${contactId}`, { phone: leadReport.phone });
  } else {
    contactId = await createContact(leadReport);
    logSync("CONTACT", "CREATED", `Created contact ${contactId}`, { phone: leadReport.phone });
  }

  // 2. Create or update Lead entity
  const existingLead = await findLeadByPhone(leadReport.phone);
  let leadId;
  if (existingLead) {
    leadId = existingLead.leadid;
    await updateLead(leadId, leadReport);
    logSync("LEAD", "UPDATED", `Updated lead ${leadId}`, { phone: leadReport.phone, score: leadReport.score });
  } else {
    leadId = await createLead(leadReport, contactId);
    logSync("LEAD", "CREATED", `Created lead ${leadId}`, { phone: leadReport.phone, score: leadReport.score });
  }

  console.log(`[CRM] Lead synced — Contact: ${contactId}, Lead: ${leadId}`);
  return { contactId, leadId };
}

/**
 * Find a contact by phone number.
 */
async function findContactByPhone(phone) {
  const cleanPhone = phone.replace(/[^0-9]/g, "");
  const filter = `$filter=contains(telephone1,'${cleanPhone}') or contains(mobilephone,'${cleanPhone}')`;
  const res = await dynamicsApi("GET", `contacts?${filter}&$top=1`);
  return res.data.value?.[0] || null;
}

/**
 * Create a new contact in Dynamics 365.
 */
async function createContact(lead) {
  const [firstName, ...lastParts] = (lead.name || "WhatsApp Lead").split(" ");
  const lastName = lastParts.join(" ") || "(WhatsApp)";

  const contactData = {
    firstname: firstName,
    lastname: lastName,
    telephone1: lead.phone,
    emailaddress1: lead.email !== "Not provided" ? lead.email : null,
    description: buildContactDescription(lead),
    // Custom fields for the chatbot source
    leadsourcecode: 8, // 8 = Web (closest to chatbot)
  };

  const res = await dynamicsApi("POST", "contacts", contactData);

  // Extract ID from response or OData-EntityId header
  if (res.data?.contactid) return res.data.contactid;

  const entityId = res.headers?.["odata-entityid"] || "";
  const match = entityId.match(/contacts\(([^)]+)\)/);
  return match?.[1] || null;
}

/**
 * Update an existing contact.
 */
async function updateContact(contactId, lead) {
  const updateData = {
    description: buildContactDescription(lead),
  };

  if (lead.email && lead.email !== "Not provided") {
    updateData.emailaddress1 = lead.email;
  }
  if (lead.name && lead.name !== "Unknown") {
    const [firstName, ...lastParts] = lead.name.split(" ");
    updateData.firstname = firstName;
    if (lastParts.length > 0) updateData.lastname = lastParts.join(" ");
  }

  await dynamicsApi("PATCH", `contacts(${contactId})`, updateData);
}

/**
 * Build a rich description for the contact record.
 */
function buildContactDescription(lead) {
  return [
    `--- WhatsApp AI Chatbot Lead ---`,
    `Source: WhatsApp Chatbot`,
    `Lead Score: ${lead.score}/100 (${lead.tier})`,
    `Property Interest: ${lead.propertyInterest}`,
    `Budget: ${lead.budget}`,
    `Preferred Location: ${lead.preferredLocation}`,
    `Timeline: ${lead.timeline}`,
    `Consent Given: ${lead.consentGiven ? "Yes" : "No"}`,
    `First Contact: ${lead.firstContact ? new Date(lead.firstContact).toISOString() : "N/A"}`,
    `Last Contact: ${lead.lastContact ? new Date(lead.lastContact).toISOString() : "N/A"}`,
    `Messages: ${lead.conversationLength}`,
    `Updated: ${new Date().toISOString()}`,
  ].join("\n");
}

/**
 * Find a lead by phone number.
 */
async function findLeadByPhone(phone) {
  const cleanPhone = phone.replace(/[^0-9]/g, "");
  const filter = `$filter=contains(telephone1,'${cleanPhone}') or contains(mobilephone,'${cleanPhone}')`;
  const res = await dynamicsApi("GET", `leads?${filter}&$top=1`);
  return res.data.value?.[0] || null;
}

/**
 * Create a new lead entity in Dynamics 365.
 */
async function createLead(lead, contactId) {
  const [firstName, ...lastParts] = (lead.name || "WhatsApp Lead").split(" ");
  const lastName = lastParts.join(" ") || "(WhatsApp)";

  const leadData = {
    firstname: firstName,
    lastname: lastName,
    telephone1: lead.phone,
    mobilephone: lead.phone,
    emailaddress1: lead.email !== "Not provided" ? lead.email : null,
    subject: `WhatsApp Lead — ${lead.propertyInterest || "General Inquiry"}`,
    description: buildContactDescription(lead),
    leadsourcecode: 8,
    // Link to parent contact
    "parentcontactid@odata.bind": contactId ? `/contacts(${contactId})` : undefined,
    // Lead qualification
    leadqualitycode: lead.tier === "HOT" ? 1 : lead.tier === "WARM" ? 2 : 3,
    // Budget as revenue
    revenue: parseBudget(lead.budget),
  };

  // Remove undefined values
  Object.keys(leadData).forEach((k) => leadData[k] === undefined && delete leadData[k]);

  const res = await dynamicsApi("POST", "leads", leadData);

  if (res.data?.leadid) return res.data.leadid;
  const entityId = res.headers?.["odata-entityid"] || "";
  const match = entityId.match(/leads\(([^)]+)\)/);
  return match?.[1] || null;
}

/**
 * Update an existing lead.
 */
async function updateLead(leadId, lead) {
  const updateData = {
    subject: `WhatsApp Lead — ${lead.propertyInterest || "General Inquiry"}`,
    description: buildContactDescription(lead),
    leadqualitycode: lead.tier === "HOT" ? 1 : lead.tier === "WARM" ? 2 : 3,
    revenue: parseBudget(lead.budget),
  };

  if (lead.email && lead.email !== "Not provided") {
    updateData.emailaddress1 = lead.email;
  }

  await dynamicsApi("PATCH", `leads(${leadId})`, updateData);
}

// ───────── Viewing / Appointment Sync ─────────

/**
 * Sync a viewing appointment to Dynamics 365.
 *
 * @param {Object} viewing — from viewingScheduler.createViewing()
 * @returns {string|null} — Dynamics appointment ID
 */
export async function syncViewingToCRM(viewing) {
  if (!config.dynamics.enabled) return null;

  const appointmentData = {
    subject: `Property Viewing — ${viewing.propertyName}`,
    description: [
      `Viewing Ref: ${viewing.id}`,
      `Property: ${viewing.propertyName}`,
      `Contact: ${viewing.name}`,
      `Phone: ${viewing.phone}`,
      `Email: ${viewing.email}`,
      `Preferred Date: ${viewing.preferredDate}`,
      `Preferred Time: ${viewing.preferredTime}`,
      `Notes: ${viewing.notes || "None"}`,
      `Status: ${viewing.status}`,
      `Source: WhatsApp AI Chatbot`,
    ].join("\n"),
    location: "Devtraco Plus Sales Office",
    scheduledstart: parseViewingDateTime(viewing.preferredDate, viewing.preferredTime),
    scheduledend: parseViewingDateTimeEnd(viewing.preferredDate, viewing.preferredTime),
  };

  // Link to contact if we can find one
  const contact = await findContactByPhone(viewing.phone);
  if (contact) {
    appointmentData["regardingobjectid_contact@odata.bind"] = `/contacts(${contact.contactid})`;
  }

  const res = await dynamicsApi("POST", "appointments", appointmentData);

  const appointmentId = res.data?.activityid ||
    res.headers?.["odata-entityid"]?.match(/appointments\(([^)]+)\)/)?.[1] || null;

  logSync("APPOINTMENT", "CREATED", `Viewing ${viewing.id} synced`, {
    appointmentId,
    property: viewing.propertyName,
  });

  console.log(`[CRM] Viewing synced — Appointment: ${appointmentId}`);
  return appointmentId;
}

// ───────── Retry Queue ─────────

/**
 * Add a failed sync to the retry queue.
 * Exported so callers (viewingScheduler, leadCapture) can queue first-time failures.
 */
export function addToRetryQueue(item) {
  if (item.attempts >= 3) {
    logSync("RETRY", "ABANDONED", `Gave up after 3 attempts: ${item.type}`, item.data);
    return;
  }
  syncQueue.push({ ...item, nextRetry: Date.now() + (item.attempts + 1) * 60_000 });
  console.log(`[CRM] Queued for retry (attempt ${item.attempts + 1}): ${item.type}`);

  // Start processing if not already
  if (!isProcessingQueue) processRetryQueue();
}

/**
 * Process the retry queue periodically.
 */
async function processRetryQueue() {
  if (syncQueue.length === 0) {
    isProcessingQueue = false;
    return;
  }
  isProcessingQueue = true;

  const now = Date.now();
  const ready = syncQueue.filter((item) => item.nextRetry <= now);

  for (const item of ready) {
    const idx = syncQueue.indexOf(item);
    if (idx > -1) syncQueue.splice(idx, 1);

    item.attempts++;
    try {
      if (item.type === "lead") {
        await syncLeadToCRM(item.data);
      } else if (item.type === "viewing") {
        await syncViewingToCRM(item.data);
      }
      // Only log success if we get here without throwing
      logSync("RETRY", "SUCCESS", `Retried ${item.type} successfully`, { attempts: item.attempts });
    } catch (err) {
      // Log the error and re-queue (attempt count preserved from item.attempts)
      logSync(item.type === "viewing" ? "APPOINTMENT" : "LEAD", "ERROR",
        `Failed to sync ${item.type}: ${err.message}`,
        item.type === "viewing" ? { viewingId: item.data?.id || item.data?.viewingId } : { phone: item.data?.phone });
      addToRetryQueue(item); // attempts already incremented above
    }
  }

  // Check again in 60 seconds
  setTimeout(processRetryQueue, 60_000);
}

// ───────── Helpers ─────────

/**
 * Parse budget string to a number.
 */
function parseBudget(budget) {
  if (!budget || budget === "Not specified") return null;
  const nums = budget.replace(/[^0-9.]/g, "");
  const val = parseFloat(nums);
  return isNaN(val) ? null : val;
}

/**
 * Parse a viewing date/time into ISO format for Dynamics.
 */
function parseViewingDateTime(dateStr, timeStr) {
  try {
    const combined = `${dateStr} ${timeStr}`;
    const d = new Date(combined);
    if (isNaN(d.getTime())) return new Date().toISOString();
    return d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function parseViewingDateTimeEnd(dateStr, timeStr) {
  try {
    const combined = `${dateStr} ${timeStr}`;
    const d = new Date(combined);
    if (isNaN(d.getTime())) d.setTime(Date.now());
    d.setHours(d.getHours() + 1); // 1-hour viewing
    return d.toISOString();
  } catch {
    const d = new Date();
    d.setHours(d.getHours() + 1);
    return d.toISOString();
  }
}

// ───────── Sync Log ─────────

function logSync(entity, status, message, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    entity,
    status,
    message,
    details,
  };
  syncLog.unshift(entry);
  if (syncLog.length > MAX_LOG) syncLog.pop();
}

/**
 * Get the CRM sync log for the dashboard.
 */
export function getCRMSyncLog() {
  return syncLog;
}

/**
 * Get CRM sync stats for the dashboard.
 */
export function getCRMSyncStats() {
  const successes = syncLog.filter((e) => e.status === "CREATED" || e.status === "UPDATED" || e.status === "SUCCESS");
  const errors = syncLog.filter((e) => e.status === "ERROR");

  return {
    enabled: config.dynamics.enabled,
    orgUrl: config.dynamics.enabled ? config.dynamics.orgUrl : null,
    totalSyncs: successes.length,
    totalErrors: errors.length,
    queueSize: syncQueue.length,
    lastSync: syncLog.length > 0 ? syncLog[0].timestamp : null,
    recentLog: syncLog.slice(0, 20),
  };
}
