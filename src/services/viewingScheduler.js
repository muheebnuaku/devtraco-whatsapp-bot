import config from "../config/index.js";
import { isDBConnected } from "../db/connection.js";
import ViewingModel from "../db/models/Viewing.js";
import { syncViewingToCRM, addToRetryQueue as queueCRMRetry } from "./crmSync.js";

/**
 * Viewing scheduler — MongoDB-backed with in-memory fallback.
 */

const memoryViewings = new Map();
let viewingCounter = 0;

// ───────── Date resolution ─────────

/**
 * Resolve a human-friendly date string (e.g. "tomorrow", "Saturday", "2026-03-07")
 * into an ISO YYYY-MM-DD string. Returns null if unparseable.
 */
export function resolveDate(input) {
  if (!input || input === "To be confirmed") return null;

  const text = input.trim().toLowerCase();
  const now = new Date();

  // Already ISO format (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  // "today"
  if (text === "today") return toISO(now);

  // "tomorrow"
  if (text === "tomorrow") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return toISO(d);
  }

  // Day names: "monday", "tuesday", etc. — resolve to the next occurrence
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayIdx = dayNames.indexOf(text);
  if (dayIdx !== -1) {
    const d = new Date(now);
    const currentDay = d.getDay();
    let daysAhead = dayIdx - currentDay;
    if (daysAhead <= 0) daysAhead += 7; // next week if same or past
    d.setDate(d.getDate() + daysAhead);
    return toISO(d);
  }

  // "next monday", "next friday", etc.
  const nextDayMatch = text.match(/^next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (nextDayMatch) {
    const targetDay = dayNames.indexOf(nextDayMatch[1]);
    const d = new Date(now);
    const currentDay = d.getDay();
    let daysAhead = targetDay - currentDay;
    if (daysAhead <= 0) daysAhead += 7;
    d.setDate(d.getDate() + daysAhead);
    return toISO(d);
  }

  // Various date formats: "7th March", "March 7", "7/3/2026", "07-03-2026", etc.
  // Try Date.parse as fallback
  const parsed = new Date(input.trim());
  if (!isNaN(parsed.getTime())) {
    // If the parsed date is in the past (no year specified), assume next year
    if (parsed < now && !input.match(/\d{4}/)) {
      parsed.setFullYear(parsed.getFullYear() + 1);
    }
    return toISO(parsed);
  }

  // Ordinal dates: "7th March 2026", "March 7th", "7th March"
  const ordinalMatch = input.trim().match(/(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*(?:\s+(\d{4}))?/i);
  if (ordinalMatch) {
    const day = parseInt(ordinalMatch[1]);
    const monthStr = ordinalMatch[2].toLowerCase();
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const month = months.indexOf(monthStr.slice(0, 3));
    const year = ordinalMatch[3] ? parseInt(ordinalMatch[3]) : now.getFullYear();
    const d = new Date(year, month, day);
    if (d < now && !ordinalMatch[3]) d.setFullYear(d.getFullYear() + 1);
    return toISO(d);
  }

  return null;
}

/**
 * Resolve a human-friendly time string (e.g. "2pm", "10:00", "around 3pm")
 * into an HH:MM string. Returns null if unparseable.
 */
export function resolveTime(input) {
  if (!input || input === "To be confirmed") return null;

  const text = input.trim().toLowerCase().replace(/around\s*/i, "").replace(/\s+/g, "");

  // "14:00" or "14:30"
  if (/^\d{1,2}:\d{2}$/.test(text)) return text.padStart(5, "0");

  // "2pm", "10am", "3:30pm"
  const timeMatch = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1]);
    const min = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    const ampm = timeMatch[3]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }

  return null;
}

function toISO(date) {
  return date.toISOString().split("T")[0];
}

// ───────── Business hours validation ─────────

/**
 * Validate that a date+time falls within business hours (Mon-Fri, 8am-5pm)
 * Returns { valid: true } or { valid: false, reason: "..." }
 */
export function validateBusinessHours(dateStr, timeStr) {
  if (!dateStr) return { valid: true }; // can't validate without a date

  const date = new Date(dateStr);
  const dayOfWeek = date.getDay(); // 0=Sun, 6=Sat

  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return {
      valid: false,
      reason: `Property viewings are available Monday to Friday only. ${dateStr} falls on a ${dayOfWeek === 0 ? "Sunday" : "Saturday"}. Please choose a weekday.`,
    };
  }

  if (timeStr) {
    const [hour] = timeStr.split(":").map(Number);
    if (hour < 8 || hour >= 17) {
      return {
        valid: false,
        reason: `Viewings are available between 8:00 AM and 5:00 PM. The requested time (${timeStr}) is outside business hours. Please choose a time within this window.`,
      };
    }
  }

  return { valid: true };
}

// ───────── Available slots ─────────

/**
 * Get available viewing slots for a given date.
 * Slots run every hour from 8am to 4pm (last slot starts at 4pm, ends by 5pm).
 * Already-booked slots (PENDING or CONFIRMED) are excluded.
 */
export async function getAvailableSlots(dateStr, propertyId = null) {
  const ALL_SLOTS = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"];

  // Get existing viewings for this date
  let existingViewings = [];
  if (isDBConnected()) {
    try {
      const query = { preferredDate: dateStr, status: { $in: ["PENDING", "CONFIRMED"] } };
      if (propertyId) query.propertyId = propertyId;
      const docs = await ViewingModel.find(query).lean();
      existingViewings = docs.map(d => d.preferredTime);
    } catch {}
  } else {
    existingViewings = Array.from(memoryViewings.values())
      .filter(v => v.preferredDate === dateStr && ["PENDING", "CONFIRMED"].includes(v.status))
      .filter(v => !propertyId || v.propertyId === propertyId)
      .map(v => v.preferredTime);
  }

  // Filter out booked slots AND slots that are within 24 hours from now
  const cutoff = Date.now() + 24 * 60 * 60 * 1000;
  const available = ALL_SLOTS.filter(slot => {
    if (existingViewings.includes(slot)) return false;
    try {
      const slotTime = new Date(`${dateStr}T${slot}:00`);
      if (!isNaN(slotTime.getTime()) && slotTime.getTime() <= cutoff) return false;
    } catch {}
    return true;
  });
  return available;
}

// ───────── Get next counter value ─────────

async function getNextId() {
  if (isDBConnected()) {
    try {
      const last = await ViewingModel.findOne().sort({ createdAt: -1 }).lean();
      if (last) {
        const num = parseInt(last.viewingId.replace("VW-", ""), 10);
        return `VW-${(num || 0) + 1}`;
      }
    } catch {}
  }
  return `VW-${++viewingCounter}`;
}

// ───────── CRUD ─────────

export async function createViewing({ userId, propertyId, propertyName, preferredDate, preferredTime, name, phone, email, notes }) {
  // Resolve human-friendly dates/times to standard formats
  const resolvedDate = resolveDate(preferredDate) || preferredDate || "To be confirmed";
  const resolvedTime = resolveTime(preferredTime) || preferredTime || "To be confirmed";

  // Validate business hours (Mon-Fri, 8am-5pm)
  if (resolvedDate && resolvedDate !== "To be confirmed") {
    const bizCheck = validateBusinessHours(resolvedDate, resolvedTime !== "To be confirmed" ? resolvedTime : null);
    if (!bizCheck.valid) {
      console.log(`[Viewing] Rejected — business hours: ${bizCheck.reason}`);
      return { rejected: true, reason: bizCheck.reason };
    }
  }

  // Validate 24-hour advance booking rule
  if (resolvedDate && resolvedDate !== "To be confirmed") {
    const requestedDate = new Date(resolvedDate + (resolvedTime !== "To be confirmed" ? `T${resolvedTime}:00` : "T23:59:59"));
    const minDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
    if (!isNaN(requestedDate.getTime()) && requestedDate < minDate) {
      console.log(`[Viewing] Rejected — date ${resolvedDate} ${resolvedTime} is less than 24 hours away`);
      // Get available slots for the next business day
      const nextBiz = getNextBusinessDay();
      const slots = await getAvailableSlots(nextBiz, propertyId);
      const slotText = slots.length > 0
        ? `\n\nThe next available date is *${formatDateNice(nextBiz)}*. Available slots:\n${slots.map(s => `• ${formatTimeNice(s)}`).join("\n")}`
        : "";
      return {
        rejected: true,
        reason: `All property viewings must be scheduled at least 24 hours in advance. Please choose a later date.${slotText}`,
        suggestedDate: nextBiz,
      };
    }
  }

  // Check slot availability
  if (resolvedDate !== "To be confirmed" && resolvedTime !== "To be confirmed") {
    const slots = await getAvailableSlots(resolvedDate, propertyId);
    if (!slots.includes(resolvedTime)) {
      const slotText = slots.length > 0
        ? `Available slots for *${formatDateNice(resolvedDate)}*:\n${slots.map(s => `• ${formatTimeNice(s)}`).join("\n")}`
        : `No slots available on ${formatDateNice(resolvedDate)}. Please choose another date.`;
      console.log(`[Viewing] Rejected — slot ${resolvedTime} on ${resolvedDate} not available`);
      return { rejected: true, reason: `The ${formatTimeNice(resolvedTime)} slot on ${formatDateNice(resolvedDate)} is not available.\n\n${slotText}`, suggestedDate: resolvedDate };
    }
  }

  const id = await getNextId();
  const viewing = {
    viewingId: id,
    id,  // alias for backward compat
    userId,
    propertyId: propertyId || "unknown",
    propertyName: propertyName || "Not specified",
    preferredDate: resolvedDate,
    preferredTime: resolvedTime,
    name: name || "Not provided",
    phone: phone || userId,
    email: email || "Not provided",
    notes: notes || "",
    status: "PENDING",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  if (isDBConnected()) {
    try {
      const doc = new ViewingModel(viewing);
      await doc.save();
    } catch (err) {
      console.error("[Viewing] DB save failed:", err.message);
      memoryViewings.set(id, viewing);
    }
  } else {
    memoryViewings.set(id, viewing);
  }

  console.log(`[Viewing] Created ${id} for ${userId} — ${propertyName}`);

  // Sync to Dynamics 365 CRM (async, non-blocking)
  syncViewingToCRM(viewing).catch((err) => {
    console.error(`[CRM] Viewing sync failed for ${id}:`, err.message);
    queueCRMRetry({ type: "viewing", data: viewing, attempts: 0 });
  });

  return viewing;
}

export async function getUserViewings(userId) {
  if (isDBConnected()) {
    try {
      const docs = await ViewingModel.find({ userId }).sort({ createdAt: -1 }).lean();
      return docs.map(docToViewing);
    } catch (err) {
      console.error("[Viewing] DB getUserViewings failed:", err.message);
    }
  }
  return Array.from(memoryViewings.values()).filter((v) => v.userId === userId);
}

export async function getAllViewings() {
  if (isDBConnected()) {
    try {
      const docs = await ViewingModel.find().sort({ createdAt: -1 }).lean();
      return docs.map(docToViewing);
    } catch (err) {
      console.error("[Viewing] DB getAllViewings failed:", err.message);
    }
  }
  return Array.from(memoryViewings.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getViewingById(id) {
  if (isDBConnected()) {
    try {
      const doc = await ViewingModel.findOne({ viewingId: id }).lean();
      return doc ? docToViewing(doc) : null;
    } catch {}
  }
  return memoryViewings.get(id) || null;
}

export async function updateViewingStatus(id, status) {
  if (isDBConnected()) {
    try {
      const doc = await ViewingModel.findOneAndUpdate(
        { viewingId: id },
        { status, updatedAt: Date.now() },
        { returnDocument: 'after' }
      ).lean();
      return doc ? docToViewing(doc) : null;
    } catch (err) {
      console.error("[Viewing] DB updateStatus failed:", err.message);
    }
  }
  const viewing = memoryViewings.get(id);
  if (!viewing) return null;
  viewing.status = status;
  viewing.updatedAt = Date.now();
  return viewing;
}

export async function getPendingViewingCount() {
  if (isDBConnected()) {
    try {
      return await ViewingModel.countDocuments({ status: "PENDING" });
    } catch {}
  }
  return Array.from(memoryViewings.values()).filter((v) => v.status === "PENDING").length;
}

/**
 * Format viewing confirmation message for WhatsApp
 */
export function formatViewingPending(viewing) {
  return [
    `📅 *Viewing Request Received!*`,
    ``,
    `📋 Reference: *${viewing.viewingId || viewing.id}*`,
    `🏠 Property: *${viewing.propertyName}*`,
    `📆 Preferred Date: ${formatDateNice(viewing.preferredDate)}`,
    `🕐 Preferred Time: ${formatTimeNice(viewing.preferredTime)}`,
    `👤 Name: ${viewing.name}`,
    ``,
    `Your request is being reviewed by our team. A viewing is only confirmed once you receive a confirmation call/message and the assigned Sales Executive's contact details.`,
    ``,
    `📌 *Please Note:*`,
    `• Arrive on time — a 15-minute grace period applies`,
    `• Provide at least 3 hours' notice for cancellations or rescheduling`,
    `• You may be asked to present valid ID`,
    `• Please wear appropriate footwear on site`,
    ``,
    `📍 *Office:* ${config.company.address}`,
    `📞 *Contact:* ${config.company.cellPhone}`,
  ].join("\n");
}

export function formatViewingConfirmed(viewing) {
  return [
    `✅ *Viewing Confirmed!*`,
    ``,
    `📋 Reference: *${viewing.viewingId || viewing.id}*`,
    `🏠 Property: *${viewing.propertyName}*`,
    `📆 Date: ${formatDateNice(viewing.preferredDate)}`,
    `🕐 Time: ${formatTimeNice(viewing.preferredTime)}`,
    `👤 Name: ${viewing.name}`,
    ``,
    `Your viewing has been confirmed by our team! We look forward to seeing you.`,
    ``,
    `📍 *Office:* ${config.company.address}`,
    `📞 *Contact:* ${config.company.cellPhone}`,
  ].join("\n");
}

export function formatViewingCancelled(viewing) {
  return [
    `❌ *Viewing Cancelled*`,
    ``,
    `📋 Reference: *${viewing.viewingId || viewing.id}*`,
    `🏠 Property: *${viewing.propertyName}*`,
    ``,
    `Unfortunately, your viewing has been cancelled. If you'd like to reschedule, please let us know!`,
    ``,
    `📞 *Contact:* ${config.company.cellPhone}`,
  ].join("\n");
}

// ───────── Helpers ─────────

function docToViewing(doc) {
  return {
    id: doc.viewingId,
    viewingId: doc.viewingId,
    userId: doc.userId,
    propertyId: doc.propertyId,
    propertyName: doc.propertyName,
    preferredDate: doc.preferredDate,
    preferredTime: doc.preferredTime,
    name: doc.name,
    phone: doc.phone,
    email: doc.email,
    notes: doc.notes,
    status: doc.status,
    createdAt: doc.createdAt ? new Date(doc.createdAt).getTime() : Date.now(),
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).getTime() : Date.now(),
  };
}

/**
 * Get the next business day (Mon-Fri) where the earliest slot (8:00 AM) is
 * at least 24 hours away from now. This prevents showing a date where
 * only some of the morning slots are within the 24h window.
 */
export function getNextBusinessDay() {
  const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000);
  // Start at 8:00 AM on the same calendar day as cutoff
  const d = new Date(cutoff);
  d.setHours(8, 0, 0, 0);
  // If 8 AM on that day is still within the cutoff window, move to the next day
  if (d.getTime() <= cutoff.getTime()) {
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
  }
  // Skip weekends
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return toISO(d);
}

/**
 * Format YYYY-MM-DD to "Monday, 10 March 2026"
 */
export function formatDateNice(dateStr) {
  try {
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  } catch {
    return dateStr;
  }
}

/**
 * Format HH:MM to "10:00 AM"
 */
export function formatTimeNice(timeStr) {
  if (!timeStr || timeStr === "To be confirmed") return timeStr || "To be confirmed";
  try {
    const [h, m] = timeStr.split(":").map(Number);
    if (isNaN(h) || isNaN(m)) return timeStr;
    const ampm = h >= 12 ? "PM" : "AM";
    const hour12 = h % 12 || 12;
    return `${hour12}:${String(m).padStart(2, "0")} ${ampm}`;
  } catch {
    return timeStr;
  }
}

// ───────── Bulk operations ─────────

export async function deleteViewing(id) {
  if (isDBConnected()) {
    try {
      await ViewingModel.deleteOne({ viewingId: id });
    } catch (err) {
      console.error("[Viewing] DB delete failed:", err.message);
    }
  }
  memoryViewings.delete(id);
  console.log(`[Viewing] Deleted ${id}`);
}

export async function deleteAllViewings() {
  if (isDBConnected()) {
    try {
      const result = await ViewingModel.deleteMany({});
      console.log(`[Viewing] Deleted ${result.deletedCount} viewings from DB`);
    } catch (err) {
      console.error("[Viewing] DB deleteAll failed:", err.message);
    }
  }
  const count = memoryViewings.size;
  memoryViewings.clear();
  viewingCounter = 0;
  console.log(`[Viewing] Cleared ${count} in-memory viewings`);
}
