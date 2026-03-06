import dotenv from "dotenv";
dotenv.config();

const config = {
  port: process.env.PORT || 3000,
  baseUrl: process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || "",

  // WhatsApp Business API
  whatsapp: {
    verifyToken: process.env.VERIFY_TOKEN,
    accessToken: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.PHONE_NUMBER_ID,
    apiVersion: "v22.0",
    get baseUrl() {
      return `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}`;
    },
  },

  // OpenAI
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-4o-mini",
    maxTokens: 500,     // bot replies are short — keeps generation fast
    temperature: 0.5,   // slightly lower for faster, more focused replies
  },

  // Session
  session: {
    ttlMinutes: 30, // conversation context window
    maxHistory: 10, // max messages kept in context (fewer = faster AI)
  },

  // MongoDB
  mongodb: {
    uri: process.env.MONGODB_URI || "",
    dbName: process.env.MONGODB_DB_NAME || "devtraco-bot",
  },

  // Rate limiting
  rateLimit: {
    windowMs: 60 * 1000,   // 1 minute
    maxRequests: 30,        // per user per window
  },

  // Lead scoring thresholds
  leadScoring: {
    hot: 80,
    warm: 50,
    cold: 0,
  },

  // Admin dashboard authentication
  admin: {
    username: process.env.ADMIN_USERNAME || "admin",
    password: process.env.ADMIN_PASSWORD || "devtraco2026",
    jwtSecret: process.env.JWT_SECRET || "devtraco-bot-secret-" + (process.env.WHATSAPP_TOKEN || "").slice(-8),
    tokenExpiry: 24 * 60 * 60 * 1000, // 24 hours
  },

  // Email (SMTP via Nodemailer — optional)
  email: {
    host: process.env.SMTP_HOST || "",
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@devtracoplus.com",
  },

  // Microsoft Dynamics 365 CRM
  dynamics: {
    enabled: !!(process.env.DYNAMICS_ORG_URL && process.env.DYNAMICS_CLIENT_ID),
    orgUrl: process.env.DYNAMICS_ORG_URL || "",
    tenantId: process.env.DYNAMICS_TENANT_ID || "",
    clientId: process.env.DYNAMICS_CLIENT_ID || "",
    clientSecret: process.env.DYNAMICS_CLIENT_SECRET || "",
  },

  // Company info for the AI system prompt
  company: {
    name: "Devtraco Plus",
    industry: "Real Estate Development",
    description:
      "Devtraco Plus is an industry leading real estate developer that has successfully created a unique niche for its exclusive premium quality housing units in prime areas of Accra, Ghana. Carved out of the well-known echelons of the Devtraco brand, our company promises nothing but excellence in delivery and service. All our developments possess a signature style and character, expertly designed to effectively function with modern finishings, and built with materials that reflect our commitment to quality. On offer are suites, studios, 1-2-3 bedroom apartments, and 5 bedroom townhouses for sale and rent in Accra, Ghana.",
    website: "https://devtracoplus.com",
    phone: "+233270000004",           // Office contact
    escalationWhatsApp: "+233592405403", // Escalation WhatsApp
    cellPhone: "+233270000004",
    email: "info@devtracoplus.com",
    address: "No. 8B, Sir Arku Korsah Road, Airport Residential Area, Accra, Ghana",
    tone: "premium",
    businessHours: "Monday – Friday, 8:00 AM – 5:00 PM",
    brandColors: { primary: "#000000", secondary: "#FFFFFF", accent: "Corporate Gold" },
  },
};

// Validate required env vars
const required = ["VERIFY_TOKEN", "WHATSAPP_TOKEN", "PHONE_NUMBER_ID", "OPENAI_API_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

export default config;
