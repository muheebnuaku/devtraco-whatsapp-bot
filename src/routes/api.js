import express from "express";
import {
  getAllSessions,
  getActiveSessionCount,
  getSession,
} from "../services/session.js";
import { formatLeadReport, getLeadTier } from "../services/leadCapture.js";
import { getAllProperties } from "../data/properties.js";
import { getAllViewings, getPendingViewingCount, updateViewingStatus } from "../services/viewingScheduler.js";
import { getCRMSyncStats, getCRMSyncLog, syncLeadToCRM } from "../services/crmSync.js";

const router = express.Router();

/**
 * GET /api/health — Health check
 */
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    activeSessions: getActiveSessionCount(),
  });
});

/**
 * GET /api/stats — Dashboard stats
 */
router.get("/stats", (req, res) => {
  const sessions = getAllSessions();

  const leads = {
    total: sessions.length,
    hot: sessions.filter((s) => s.leadScore >= 80).length,
    warm: sessions.filter((s) => s.leadScore >= 50 && s.leadScore < 80).length,
    cold: sessions.filter((s) => s.leadScore < 50).length,
  };

  const totalMessages = sessions.reduce((acc, s) => acc + s.history.length, 0);
  const escalated = sessions.filter((s) => s.state === "ESCALATED").length;

  res.json({
    activeSessions: getActiveSessionCount(),
    leads,
    totalMessages,
    escalated,
    properties: getAllProperties().length,
    pendingViewings: getPendingViewingCount(),
  });
});

/**
 * GET /api/leads — List all captured leads
 */
router.get("/leads", (req, res) => {
  const sessions = getAllSessions();
  const leads = sessions
    .filter((s) => s.leadScore > 0)
    .map(formatLeadReport)
    .sort((a, b) => b.score - a.score);

  res.json({ count: leads.length, leads });
});

/**
 * GET /api/leads/:userId — Get a specific lead
 */
router.get("/leads/:userId", (req, res) => {
  const session = getSession(req.params.userId);
  if (!session || session.leadScore === 0) {
    return res.status(404).json({ error: "Lead not found" });
  }
  res.json(formatLeadReport(session));
});

/**
 * GET /api/conversations/:userId — Get conversation history
 */
router.get("/conversations/:userId", (req, res) => {
  const session = getSession(req.params.userId);
  if (!session) {
    return res.status(404).json({ error: "Conversation not found" });
  }
  res.json({
    userId: session.userId,
    state: session.state,
    messageCount: session.history.length,
    history: session.history,
    leadScore: session.leadScore,
    leadTier: getLeadTier(session.leadScore),
  });
});

/**
 * GET /api/properties — List all properties
 */
router.get("/properties", (req, res) => {
  res.json({ properties: getAllProperties() });
});

/**
 * GET /api/viewings — List all viewing appointments
 */
router.get("/viewings", (req, res) => {
  const viewings = getAllViewings();
  res.json({
    total: viewings.length,
    pending: viewings.filter(v => v.status === "PENDING").length,
    confirmed: viewings.filter(v => v.status === "CONFIRMED").length,
    viewings,
  });
});

/**
 * PATCH /api/viewings/:id — Update viewing status (confirm/cancel)
 */
router.patch("/viewings/:id", (req, res) => {
  const { status } = req.body;
  if (!["CONFIRMED", "CANCELLED", "COMPLETED"].includes(status)) {
    return res.status(400).json({ error: "Invalid status. Use: CONFIRMED, CANCELLED, or COMPLETED" });
  }
  const viewing = updateViewingStatus(req.params.id, status);
  if (!viewing) {
    return res.status(404).json({ error: "Viewing not found" });
  }
  res.json(viewing);
});

/**
 * GET /api/conversations — List all conversations (summary)
 */
router.get("/conversations", (req, res) => {
  const sessions = getAllSessions();
  const convos = sessions.map((s) => ({
    userId: s.userId,
    state: s.state,
    messageCount: s.history.length,
    leadScore: s.leadScore,
    leadTier: getLeadTier(s.leadScore),
    lastMessage: s.history.length > 0 ? s.history[s.history.length - 1].content?.substring(0, 80) : null,
    lastActivity: s.lastActivity,
  }));
  res.json({ count: convos.length, conversations: convos });
});

/**
 * GET /api/crm/stats — CRM sync status & stats
 */
router.get("/crm/stats", (req, res) => {
  res.json(getCRMSyncStats());
});

/**
 * GET /api/crm/log — Full CRM sync audit log
 */
router.get("/crm/log", (req, res) => {
  res.json({ log: getCRMSyncLog() });
});

/**
 * POST /api/crm/sync/:userId — Manually trigger CRM sync for a lead
 */
router.post("/crm/sync/:userId", async (req, res) => {
  const session = getSession(req.params.userId);
  if (!session || session.leadScore === 0) {
    return res.status(404).json({ error: "Lead not found" });
  }
  try {
    const report = formatLeadReport(session);
    const result = await syncLeadToCRM(report);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
