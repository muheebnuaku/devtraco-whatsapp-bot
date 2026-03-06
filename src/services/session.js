import config from "../config/index.js";
import { isDBConnected } from "../db/connection.js";
import SessionModel from "../db/models/Session.js";

/**
 * Session service — MongoDB-backed with in-memory fallback.
 *
 * The in-memory cache keeps hot sessions for fast access.
 * MongoDB provides persistence across server restarts.
 */

const cache = new Map(); // userId -> session (in-memory hot cache)

// ───────── Core API ─────────

export async function getSession(userId) {
  // Check cache first
  let session = cache.get(userId);

  if (session) {
    const elapsed = (Date.now() - session.lastActivity) / 1000 / 60;
    if (elapsed > config.session.ttlMinutes) {
      cache.delete(userId);
      // Reset conversation state but PRESERVE history and lead data
      return await resetSession(userId, session);
    }
    session.lastActivity = Date.now();
    return session;
  }

  // Try loading from MongoDB
  if (isDBConnected()) {
    try {
      const doc = await SessionModel.findOne({ userId }).lean();
      if (doc) {
        session = docToSession(doc);
        const elapsed = (Date.now() - session.lastActivity) / 1000 / 60;
        if (elapsed > config.session.ttlMinutes) {
          // Reset conversation state but PRESERVE history and lead data
          return await resetSession(userId, session);
        }
        session.lastActivity = Date.now();
        cache.set(userId, session);
        return session;
      }
    } catch (err) {
      console.error("[Session] DB load failed:", err.message);
    }
  }

  return await createSession(userId);
}

/**
 * Read-only session retrieval for dashboard/admin — no TTL enforcement,
 * no session reset. Returns null if session doesn't exist.
 */
export async function getSessionReadOnly(userId) {
  // Check cache first
  const cached = cache.get(userId);
  if (cached) return cached;

  // Try loading from MongoDB without TTL check
  if (isDBConnected()) {
    try {
      const doc = await SessionModel.findOne({ userId }).lean();
      if (doc) return docToSession(doc);
    } catch (err) {
      console.error("[Session] DB readOnly load failed:", err.message);
    }
  }

  return null;
}

export async function createSession(userId) {
  const session = {
    userId,
    history: [],
    state: "GREETING",
    leadData: {
      name: null,
      email: null,
      phone: userId,
      budget: null,
      propertyInterest: null,
      preferredLocation: null,
      timeline: null,
    },
    leadScore: 0,
    lastActivity: Date.now(),
    consentGiven: false,
    metadata: {},
  };
  cache.set(userId, session);
  persistSession(session); // fire-and-forget
  return session;
}

/**
 * Reset a session after TTL expiry — clears conversation state
 * but PRESERVES history and lead data for dashboard/CRM purposes.
 */
async function resetSession(userId, oldSession) {
  const session = {
    userId,
    history: oldSession?.history || [],         // keep full history
    state: "GREETING",                          // reset conversation flow
    leadData: oldSession?.leadData || {
      name: null, email: null, phone: userId,
      budget: null, propertyInterest: null,
      preferredLocation: null, timeline: null,
    },
    leadScore: oldSession?.leadScore || 0,       // keep score
    lastActivity: Date.now(),
    consentGiven: oldSession?.consentGiven || false,
    metadata: oldSession?.metadata || {},
  };
  cache.set(userId, session);
  persistSession(session);
  return session;
}

export async function addMessage(userId, role, content) {
  const session = await getSession(userId);
  session.history.push({ role, content, timestamp: Date.now() });

  if (session.history.length > config.session.maxHistory) {
    session.history = session.history.slice(-config.session.maxHistory);
  }

  session.lastActivity = Date.now();
  persistSession(session);
  return session;
}

export async function updateState(userId, newState) {
  const session = await getSession(userId);
  session.state = newState;
  session.lastActivity = Date.now();
  persistSession(session);
  return session;
}

export async function updateLeadData(userId, data) {
  const session = await getSession(userId);
  Object.assign(session.leadData, data);
  session.lastActivity = Date.now();
  recalculateLeadScore(session);
  persistSession(session);
  return session;
}

export async function setConsent(userId, consent) {
  const session = await getSession(userId);
  session.consentGiven = consent;
  persistSession(session);
  return session;
}

export async function deleteSession(userId) {
  cache.delete(userId);
  if (isDBConnected()) {
    try { await SessionModel.deleteOne({ userId }); } catch {}
  }
}

export async function deleteAllSessions() {
  const count = cache.size;
  cache.clear();
  if (isDBConnected()) {
    try {
      const result = await SessionModel.deleteMany({});
      console.log(`[Session] Deleted ${result.deletedCount} sessions from DB`);
    } catch (err) {
      console.error("[Session] DB deleteAll failed:", err.message);
    }
  }
  console.log(`[Session] Cleared ${count} cached sessions`);
}

export async function getAllSessions() {
  if (isDBConnected()) {
    try {
      const docs = await SessionModel.find({}).lean();
      return docs.map(docToSession);
    } catch (err) {
      console.error("[Session] DB getAllSessions failed:", err.message);
    }
  }
  return Array.from(cache.values());
}

export async function getActiveSessionCount() {
  if (isDBConnected()) {
    try {
      const cutoff = Date.now() - config.session.ttlMinutes * 60 * 1000;
      return await SessionModel.countDocuments({ lastActivity: { $gte: cutoff } });
    } catch {}
  }
  return cache.size;
}

// ───────── Persistence ─────────

async function persistSession(session) {
  if (!isDBConnected()) return;
  try {
    await SessionModel.findOneAndUpdate(
      { userId: session.userId },
      {
        userId: session.userId,
        history: session.history,
        state: session.state,
        leadData: session.leadData,
        leadScore: session.leadScore,
        lastActivity: session.lastActivity,
        consentGiven: session.consentGiven,
        metadata: session.metadata,
      },
      { upsert: true, returnDocument: 'after' }
    );
  } catch (err) {
    console.error("[Session] Persist failed:", err.message);
  }
}

function docToSession(doc) {
  return {
    userId: doc.userId,
    history: doc.history || [],
    state: doc.state || "GREETING",
    leadData: doc.leadData || { name: null, email: null, phone: doc.userId, budget: null, propertyInterest: null, preferredLocation: null, timeline: null },
    leadScore: doc.leadScore || 0,
    lastActivity: doc.lastActivity || Date.now(),
    consentGiven: doc.consentGiven || false,
    metadata: doc.metadata || {},
  };
}

// ───────── Lead Scoring ─────────

function recalculateLeadScore(session) {
  let score = 0;
  const ld = session.leadData;

  if (ld.name) score += 15;
  if (ld.email) score += 20;
  if (ld.budget) score += 15;
  if (ld.propertyInterest) score += 15;
  if (ld.preferredLocation) score += 10;
  if (ld.timeline) score += 10;

  if (session.history.length > 5) score += 5;
  if (session.history.length > 10) score += 5;
  if (session.consentGiven) score += 5;

  session.leadScore = Math.min(score, 100);
}
