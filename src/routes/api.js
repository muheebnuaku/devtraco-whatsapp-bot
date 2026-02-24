import express from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import {
  getAllSessions,
  getActiveSessionCount,
  getSession,
} from "../services/session.js";
import { formatLeadReport, getLeadTier } from "../services/leadCapture.js";
import {
  getAllProperties,
  getPropertyById,
  createProperty,
  updateProperty,
  deleteProperty,
} from "../data/properties.js";
import { getAllViewings, getPendingViewingCount, updateViewingStatus } from "../services/viewingScheduler.js";
import { getCRMSyncStats, getCRMSyncLog, syncLeadToCRM } from "../services/crmSync.js";
import Image from "../db/models/Image.js";
import { isDBConnected } from "../db/connection.js";

const router = express.Router();

// Multer config — store in memory (then save to MongoDB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"), false);
    }
  },
});

/**
 * GET /api/health — Health check
 */
router.get("/health", async (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    activeSessions: await getActiveSessionCount(),
  });
});

/**
 * GET /api/stats — Dashboard stats
 */
router.get("/stats", async (req, res) => {
  const sessions = await getAllSessions();
  const properties = await getAllProperties();

  const leads = {
    total: sessions.length,
    hot: sessions.filter((s) => s.leadScore >= 80).length,
    warm: sessions.filter((s) => s.leadScore >= 50 && s.leadScore < 80).length,
    cold: sessions.filter((s) => s.leadScore < 50).length,
  };

  const totalMessages = sessions.reduce((acc, s) => acc + (s.history?.length || 0), 0);
  const escalated = sessions.filter((s) => s.state === "ESCALATED").length;

  res.json({
    activeSessions: await getActiveSessionCount(),
    leads,
    totalMessages,
    escalated,
    properties: properties.length,
    pendingViewings: await getPendingViewingCount(),
  });
});

/**
 * GET /api/leads — List all captured leads
 */
router.get("/leads", async (req, res) => {
  const sessions = await getAllSessions();
  const leads = sessions
    .filter((s) => s.leadScore > 0)
    .map(formatLeadReport)
    .sort((a, b) => b.score - a.score);

  res.json({ count: leads.length, leads });
});

/**
 * GET /api/leads/:userId — Get a specific lead
 */
router.get("/leads/:userId", async (req, res) => {
  const session = await getSession(req.params.userId);
  if (!session || session.leadScore === 0) {
    return res.status(404).json({ error: "Lead not found" });
  }
  res.json(formatLeadReport(session));
});

/**
 * GET /api/conversations — List all conversations (summary)
 */
router.get("/conversations", async (req, res) => {
  const sessions = await getAllSessions();
  const convos = sessions.map((s) => ({
    userId: s.userId,
    state: s.state,
    messageCount: s.history?.length || 0,
    leadScore: s.leadScore,
    leadTier: getLeadTier(s.leadScore),
    lastMessage: s.history?.length > 0 ? s.history[s.history.length - 1].content?.substring(0, 80) : null,
    lastActivity: s.lastActivity,
  }));
  res.json({ count: convos.length, conversations: convos });
});

/**
 * GET /api/conversations/:userId — Get conversation history
 */
router.get("/conversations/:userId", async (req, res) => {
  const session = await getSession(req.params.userId);
  if (!session) {
    return res.status(404).json({ error: "Conversation not found" });
  }
  res.json({
    userId: session.userId,
    state: session.state,
    messageCount: session.history?.length || 0,
    history: session.history || [],
    leadScore: session.leadScore,
    leadTier: getLeadTier(session.leadScore),
  });
});

/**
 * GET /api/properties — List all properties
 */
router.get("/properties", async (req, res) => {
  const properties = await getAllProperties();
  res.json({ properties });
});

/**
 * GET /api/properties/:id — Get a single property
 */
router.get("/properties/:id", async (req, res) => {
  const property = await getPropertyById(req.params.id);
  if (!property) {
    return res.status(404).json({ error: "Property not found" });
  }
  res.json(property);
});

/**
 * POST /api/properties — Create a new property
 */
router.post("/properties", async (req, res) => {
  try {
    const property = await createProperty(req.body);
    res.status(201).json(property);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * PUT /api/properties/:id — Update an existing property
 */
router.put("/properties/:id", async (req, res) => {
  try {
    const property = await updateProperty(req.params.id, req.body);
    if (!property) {
      return res.status(404).json({ error: "Property not found" });
    }
    res.json(property);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /api/properties/:id — Delete a property
 */
router.delete("/properties/:id", async (req, res) => {
  try {
    const result = await deleteProperty(req.params.id);
    if (!result) {
      return res.status(404).json({ error: "Property not found" });
    }
    // Also remove all associated images from DB
    const deleted = await Image.deleteMany({ propertyId: req.params.id });
    console.log(`[API] Deleted property ${req.params.id} + ${deleted.deletedCount} images`);
    res.json({ success: true, message: "Property deleted" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/viewings — List all viewing appointments
 */
router.get("/viewings", async (req, res) => {
  const viewings = await getAllViewings();
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
router.patch("/viewings/:id", async (req, res) => {
  const { status } = req.body;
  if (!["CONFIRMED", "CANCELLED", "COMPLETED"].includes(status)) {
    return res.status(400).json({ error: "Invalid status. Use: CONFIRMED, CANCELLED, or COMPLETED" });
  }
  const viewing = await updateViewingStatus(req.params.id, status);
  if (!viewing) {
    return res.status(404).json({ error: "Viewing not found" });
  }
  res.json(viewing);
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
  const session = await getSession(req.params.userId);
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

// ========== IMAGE UPLOAD & SERVING ==========

/**
 * POST /api/properties/:id/images — Upload images for a property (max 5 at once)
 */
router.post("/properties/:id/images", upload.array("images", 5), async (req, res) => {
  if (!isDBConnected()) {
    return res.status(503).json({ error: "Database not connected" });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No image files provided" });
  }

  try {
    const propertyId = req.params.id;
    // Verify property exists
    const property = await getPropertyById(propertyId);
    if (!property) {
      return res.status(404).json({ error: "Property not found" });
    }

    // Count existing images for ordering
    const existingCount = await Image.countDocuments({ propertyId });

    const savedImages = [];
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const imageId = uuidv4();
      const image = new Image({
        imageId,
        propertyId,
        filename: file.originalname,
        contentType: file.mimetype,
        data: file.buffer,
        size: file.size,
        caption: req.body.caption || "",
        order: existingCount + i,
      });
      await image.save();
      savedImages.push({
        imageId,
        filename: file.originalname,
        size: file.size,
        url: `/api/images/${imageId}`,
      });
    }

    // Update property's images array with the serve URLs
    const allImages = await Image.find({ propertyId }).sort({ order: 1 }).select("imageId");
    const imageUrls = allImages.map((img) => `/api/images/${img.imageId}`);
    const updated = await updateProperty(propertyId, { images: imageUrls });
    console.log(`[API] Updated property ${propertyId} images: ${imageUrls.length} URLs, saved=${!!updated}`);

    res.status(201).json({ uploaded: savedImages.length, images: savedImages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/images/:imageId — Serve an image (publicly accessible for WhatsApp)
 */
router.get("/images/:imageId", async (req, res) => {
  try {
    const image = await Image.findOne({ imageId: req.params.imageId });
    if (!image) {
      return res.status(404).json({ error: "Image not found" });
    }
    res.set("Content-Type", image.contentType);
    res.set("Cache-Control", "public, max-age=86400"); // cache 24h
    res.send(image.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/properties/:id/images — List images for a property
 */
router.get("/properties/:id/images", async (req, res) => {
  try {
    const images = await Image.find({ propertyId: req.params.id })
      .sort({ order: 1 })
      .select("imageId filename contentType size caption order createdAt");
    res.json({
      propertyId: req.params.id,
      count: images.length,
      images: images.map((img) => ({
        imageId: img.imageId,
        filename: img.filename,
        size: img.size,
        caption: img.caption,
        url: `/api/images/${img.imageId}`,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/images/:imageId — Delete a single image
 */
router.delete("/images/:imageId", async (req, res) => {
  if (!isDBConnected()) {
    return res.status(503).json({ error: "Database not connected" });
  }
  try {
    const image = await Image.findOneAndDelete({ imageId: req.params.imageId });
    if (!image) {
      return res.status(404).json({ error: "Image not found" });
    }
    // Update property's images array
    const remaining = await Image.find({ propertyId: image.propertyId }).sort({ order: 1 }).select("imageId");
    const imageUrls = remaining.map((img) => `/api/images/${img.imageId}`);
    await updateProperty(image.propertyId, { images: imageUrls });

    res.json({ success: true, message: "Image deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
