import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import config from "./src/config/index.js";
import { connectDB } from "./src/db/connection.js";
import { seedProperties } from "./src/data/properties.js";
import webhookRoutes from "./src/routes/webhook.js";
import apiRoutes from "./src/routes/api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ---------- Middleware ----------
// Trust proxy (required for Render, Heroku, etc. behind reverse proxy)
app.set("trust proxy", 1);

app.use(express.json({ limit: "1mb" }));

// Serve static files (dashboard)
app.use("/static", express.static(path.join(__dirname, "public")));

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});
app.use("/webhook", limiter);

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (req.path !== "/api/health") {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// ---------- Routes ----------
app.use(webhookRoutes);
app.use("/api", apiRoutes);

// Dashboard
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// Root
app.get("/", (req, res) => {
  res.json({
    service: "Devtraco WhatsApp AI Chatbot",
    status: "running",
    version: "1.0.0",
    endpoints: {
      webhook: "/webhook",
      dashboard: "/dashboard",
      health: "/api/health",
      stats: "/api/stats",
      leads: "/api/leads",
      properties: "/api/properties",
    },
  });
});

// ---------- Error handler ----------
app.use((err, req, res, next) => {
  console.error("[Server Error]", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// ---------- Start ----------
async function start() {
  // Connect to MongoDB
  const dbConnected = await connectDB();
  if (dbConnected) {
    await seedProperties();
  }

  app.listen(config.port, () => {
    console.log(`\n🤖 Devtraco WhatsApp AI Chatbot`);
    console.log(`   Server running on port ${config.port}`);
    console.log(`   Database:   ${dbConnected ? "MongoDB Atlas ✅" : "In-memory (no persistence) ⚠️"}`);
    console.log(`   Webhook:    http://localhost:${config.port}/webhook`);
    console.log(`   Dashboard:  http://localhost:${config.port}/dashboard`);
    console.log(`   API:        http://localhost:${config.port}/api/health`);
    console.log(`   Model:      ${config.openai.model}\n`);

    // Keep-alive ping to prevent Render free-tier cold starts (every 14 min)
    const BASE_URL = process.env.BASE_URL;
    if (BASE_URL) {
      setInterval(async () => {
        try {
          const res = await fetch(`${BASE_URL}/api/health`);
          console.log(`[Keep-Alive] Ping ${res.status}`);
        } catch (err) {
          console.warn(`[Keep-Alive] Ping failed:`, err.message);
        }
      }, 14 * 60 * 1000); // 14 minutes
      console.log(`   Keep-Alive: Enabled (every 14 min) ✅\n`);
    }
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});