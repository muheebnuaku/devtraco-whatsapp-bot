import config from "../config/index.js";
import { isDBConnected } from "../db/connection.js";
import ViewingModel from "../db/models/Viewing.js";
import { syncViewingToCRM } from "./crmSync.js";

/**
 * Viewing scheduler — MongoDB-backed with in-memory fallback.
 */

const memoryViewings = new Map();
let viewingCounter = 0;

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
  const id = await getNextId();
  const viewing = {
    viewingId: id,
    id,  // alias for backward compat
    userId,
    propertyId: propertyId || "unknown",
    propertyName: propertyName || "Not specified",
    preferredDate: preferredDate || "To be confirmed",
    preferredTime: preferredTime || "To be confirmed",
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
  syncViewingToCRM(viewing).catch((err) =>
    console.error(`[CRM] Viewing sync failed for ${id}:`, err.message)
  );

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
        { new: true }
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
    `📆 Preferred Date: ${viewing.preferredDate}`,
    `🕐 Preferred Time: ${viewing.preferredTime}`,
    `👤 Name: ${viewing.name}`,
    ``,
    `Your request is being reviewed by our team. You will receive a confirmation message once it is approved.`,
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
    `📆 Date: ${viewing.preferredDate}`,
    `🕐 Time: ${viewing.preferredTime}`,
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
