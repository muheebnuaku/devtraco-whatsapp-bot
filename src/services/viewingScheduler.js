import config from "../config/index.js";
import { syncViewingToCRM } from "./crmSync.js";

/**
 * In-memory viewing appointment store.
 * In production, replace with a database or calendar integration (Outlook/Calendly).
 */
const viewings = new Map(); // viewingId -> viewing
let viewingCounter = 0;

/**
 * Create a new viewing request
 */
export function createViewing({ userId, propertyId, propertyName, preferredDate, preferredTime, name, phone, email, notes }) {
  const id = `VW-${++viewingCounter}`;
  const viewing = {
    id,
    userId,
    propertyId,
    propertyName: propertyName || "Not specified",
    preferredDate: preferredDate || "To be confirmed",
    preferredTime: preferredTime || "To be confirmed",
    name: name || "Not provided",
    phone: phone || userId,
    email: email || "Not provided",
    notes: notes || "",
    status: "PENDING",    // PENDING, CONFIRMED, CANCELLED, COMPLETED
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  viewings.set(id, viewing);
  console.log(`[Viewing] Created ${id} for ${userId} — ${propertyName}`);
  // Sync to Dynamics 365 CRM (async, non-blocking)
  syncViewingToCRM(viewing).catch((err) =>
    console.error(`[CRM] Viewing sync failed for ${id}:`, err.message)
  );
  return viewing;
}

/**
 * Get all viewings for a user
 */
export function getUserViewings(userId) {
  return Array.from(viewings.values()).filter(v => v.userId === userId);
}

/**
 * Get all viewings (admin)
 */
export function getAllViewings() {
  return Array.from(viewings.values()).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Get viewing by ID
 */
export function getViewingById(id) {
  return viewings.get(id) || null;
}

/**
 * Update viewing status
 */
export function updateViewingStatus(id, status) {
  const viewing = viewings.get(id);
  if (!viewing) return null;
  viewing.status = status;
  viewing.updatedAt = Date.now();
  return viewing;
}

/**
 * Format viewing confirmation message for WhatsApp
 */
export function formatViewingConfirmation(viewing) {
  return [
    `📅 *Viewing Request Confirmed!*`,
    ``,
    `📋 Reference: *${viewing.id}*`,
    `🏠 Property: *${viewing.propertyName}*`,
    `📆 Date: ${viewing.preferredDate}`,
    `🕐 Time: ${viewing.preferredTime}`,
    `👤 Name: ${viewing.name}`,
    `📞 Phone: ${viewing.phone}`,
    ``,
    `Our team will confirm the exact time and send you directions shortly.`,
    ``,
    `📍 *Office:* ${config.company.address}`,
    `📞 *Contact:* ${config.company.cellPhone}`,
  ].join("\n");
}

/**
 * Get pending viewing count (for admin stats)
 */
export function getPendingViewingCount() {
  return Array.from(viewings.values()).filter(v => v.status === "PENDING").length;
}
