import { isDBConnected } from "../db/connection.js";
import PropertyModel from "../db/models/Property.js";

/**
 * Property service — MongoDB-backed with hardcoded fallback.
 *
 * Admins can add/edit/delete properties via the dashboard.
 * The AI reads from MongoDB so it always has the latest data.
 */

// ───────── Default seed data (used only if DB is empty or disconnected) ─────────
const DEFAULT_PROPERTIES = [
  {
    propertyId: "arlo-cantonments",
    name: "Arlo Cantonments",
    location: "Cantonments, Accra",
    type: "Apartments",
    bedrooms: [0, 1, 2, 3],
    priceFrom: 83000,
    currency: "USD",
    amenities: [],
    status: "Now Selling",
    images: ["https://devtracoplus.com/site/assets/files/1409/arlo-image-975-x-620.jpg"],
    projectUrl: "https://arlo.devtracoplus.com",
    description: "Anchored in the prestigious and serene suburb of Cantonments, ARLO is a curated collection of residences ranging from studios to three-bedroom apartments.",
  },
  {
    propertyId: "the-address",
    name: "The Address",
    location: "Roman Ridge, Accra",
    type: "Apartments",
    bedrooms: [0, 1, 2, 3],
    priceFrom: 89000,
    currency: "USD",
    amenities: [],
    status: "Now Selling",
    images: ["https://devtracoplus.com/site/assets/files/1399/address.jpg"],
    projectUrl: "https://theaddress.devtracoplus.com",
    description: "A prestigious collection of luxury apartments in Roman Ridge. The Address comes in studio, 1, 2 & 3 bedroom apartments and Penthouses.",
  },
  {
    propertyId: "the-edge",
    name: "The Edge",
    location: "Accra",
    type: "Apartments",
    bedrooms: [0, 1, 2, 3],
    priceFrom: 99000,
    currency: "USD",
    amenities: [],
    status: "Now Selling",
    images: [],
    projectUrl: "https://devtracoplus.com/projects/the-edge",
    description: "A mixed-use development designed to promote an urban quarters where people can live and enjoy life at the same time.",
  },
  {
    propertyId: "nova",
    name: "NoVA",
    location: "Accra",
    type: "Apartments",
    bedrooms: [0, 1, 2, 3],
    priceFrom: 141347,
    currency: "USD",
    amenities: [],
    status: "Now Selling",
    images: [],
    projectUrl: "https://nova.devtracoplus.com",
    description: "A mixed-use ultra modern urban lifestyle development. NoVA comes in studios, 1, 2 and 3 bedroom apartments.",
  },
  {
    propertyId: "acasia-apartments",
    name: "Acasia Apartments",
    location: "Accra",
    type: "Apartments",
    bedrooms: [1, 2, 3],
    priceFrom: 145000,
    currency: "USD",
    amenities: [],
    status: "Now Selling",
    images: [],
    projectUrl: "https://devtracoplus.com/projects/acasia-apartments",
    description: "An iconic symbol of luxury, quality and convenience for discerning homeowners in the heart of Accra.",
  },
  {
    propertyId: "avant-garde",
    name: "Avant Garde",
    location: "Accra",
    type: "Apartments",
    bedrooms: [1, 2, 3],
    priceFrom: 170000,
    currency: "USD",
    amenities: [],
    status: "Now Selling",
    images: [],
    projectUrl: "https://devtracoplus.com/projects/the-avantgarde",
    description: "Designed to an exceptionally high standard, crafted to reflect residents' expectations of uncompromising quality and originality.",
  },
  {
    propertyId: "henriettas-residences",
    name: "Henrietta's Residences",
    location: "Cantonments, Accra",
    type: "Apartments",
    bedrooms: [1, 2, 3],
    priceFrom: 245000,
    currency: "USD",
    amenities: [],
    status: "Now Selling",
    images: [],
    projectUrl: "https://devtracoplus.com/projects/henriettas-residences",
    description: "Located in Cantonments with brave design features and strategic proximity to notable landmarks.",
  },
  {
    propertyId: "forte-residences",
    name: "Forte Residences",
    location: "Accra / Tema",
    type: "Townhouses",
    bedrooms: [2, 3, 4],
    priceFrom: 270720,
    currency: "USD",
    amenities: ["Gated Community"],
    status: "Now Selling",
    images: ["https://devtracoplus.com/site/assets/files/1336/about-forte.jpg"],
    projectUrl: "https://forte.devtracoplus.com",
    description: "Luxury living in a gated community. 2 to 4.5-bedroom townhouses that take residential living to the next level.",
  },
  {
    propertyId: "the-pelican",
    name: "The Pelican Hotel Apartments",
    location: "Accra",
    type: "Hotel Apartments",
    bedrooms: [],
    priceFrom: 274125,
    currency: "USD",
    amenities: ["Hotel Investment", "Managed Returns"],
    status: "Now Selling",
    images: ["https://devtracoplus.com/site/assets/files/1347/pelican_ext_02_night_landscape.jpg"],
    projectUrl: "https://pelican.devtracoplus.com",
    description: "Invest in a hotel apartment in Accra. A proven and successful hotel investment model with managed returns.",
  },
  {
    propertyId: "the-niiyo",
    name: "The Niiyo",
    location: "Dzorwulu, Accra",
    type: "Apartments",
    bedrooms: [1, 2, 3],
    priceFrom: 275000,
    currency: "USD",
    amenities: [],
    status: "Now Selling",
    images: [],
    projectUrl: "https://devtracoplus.com/projects/the-niiyo",
    description: "A residential oasis in Dzorwulu — the ultimate in simple and comfortable contemporary living.",
  },
  {
    propertyId: "palmers-place",
    name: "Palmer's Place",
    location: "Accra",
    type: "Townhomes",
    bedrooms: [3, 4],
    priceFrom: 760000,
    currency: "USD",
    amenities: [],
    status: "Limited Availability",
    images: [],
    projectUrl: "https://devtracoplus.com/projects/palmers-place",
    description: "An exclusive development of seven modern townhomes with uncompromised, first class workmanship.",
  },
  {
    propertyId: "acasia-townhomes",
    name: "Acasia Townhomes",
    location: "Accra",
    type: "Townhomes",
    bedrooms: [3, 4, 5],
    priceFrom: 850000,
    currency: "USD",
    amenities: [],
    status: "Limited Availability",
    images: [],
    projectUrl: "https://devtracoplus.com/projects/acasia",
    description: "An iconic symbol of luxury, quality and convenience for discerning homeowners in the heart of Accra.",
  },
];

// ───────── Helpers ─────────

/**
 * Parse bedrooms from various input formats into an array of numbers.
 * Accepts: [1,2,3], "1,2,3", "1-3 Bedroom", "3,4", etc.
 */
function parseBedrooms(val) {
  if (!val) return [];
  if (Array.isArray(val)) {
    return val.map(Number).filter(n => !isNaN(n));
  }
  if (typeof val === "number") return [val];
  if (typeof val === "string") {
    // Handle "1-3 Bedroom" or "1-3" range format
    const rangeMatch = val.match(/^(\d+)\s*[-–]\s*(\d+)/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]);
      const end = parseInt(rangeMatch[2]);
      const arr = [];
      for (let i = start; i <= end; i++) arr.push(i);
      return arr;
    }
    // Handle comma-separated "1,2,3" or "1, 2, 3"
    return val.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  }
  return [];
}

// ───────── Normalize DB doc to plain object ─────────

function docToProperty(doc) {
  return {
    id: doc.propertyId,
    propertyId: doc.propertyId,
    name: doc.name,
    location: doc.location,
    type: doc.type,
    bedrooms: doc.bedrooms || [],
    priceFrom: doc.priceFrom,
    currency: doc.currency || "USD",
    amenities: doc.amenities || [],
    status: doc.status || "Now Selling",
    images: doc.images || [],
    projectUrl: doc.projectUrl || "",
    description: doc.description || "",
    active: doc.active !== false,
  };
}

function defaultToProperty(d) {
  return { ...d, id: d.propertyId, active: true };
}

// ───────── Seed DB with defaults ─────────

export async function seedProperties() {
  if (!isDBConnected()) return;
  try {
    const count = await PropertyModel.countDocuments();
    if (count === 0) {
      await PropertyModel.insertMany(DEFAULT_PROPERTIES);
      console.log(`[Properties] Seeded ${DEFAULT_PROPERTIES.length} properties into MongoDB`);
    } else {
      console.log(`[Properties] ${count} properties already in MongoDB`);
    }
  } catch (err) {
    console.error("[Properties] Seed failed:", err.message);
  }
}

// ───────── Query API ─────────

export async function getAllProperties() {
  if (isDBConnected()) {
    try {
      const docs = await PropertyModel.find({ active: true }).lean();
      return docs.map(docToProperty);
    } catch (err) {
      console.error("[Properties] DB query failed:", err.message);
    }
  }
  return DEFAULT_PROPERTIES.map(defaultToProperty);
}

export async function getPropertyById(id) {
  if (isDBConnected()) {
    try {
      const doc = await PropertyModel.findOne({ propertyId: id, active: true }).lean();
      return doc ? docToProperty(doc) : null;
    } catch (err) {
      console.error("[Properties] DB getById failed:", err.message);
    }
  }
  const found = DEFAULT_PROPERTIES.find((p) => p.propertyId === id);
  return found ? defaultToProperty(found) : null;
}

export async function searchProperties({ location, type, minBudget, maxBudget, bedrooms } = {}) {
  const all = await getAllProperties();
  return all.filter((p) => {
    if (location && !p.location.toLowerCase().includes(location.toLowerCase())) return false;
    if (type && !p.type.toLowerCase().includes(type.toLowerCase())) return false;
    if (maxBudget && p.priceFrom > maxBudget) return false;
    if (minBudget && p.priceFrom < minBudget) return false;
    if (bedrooms && !p.bedrooms.includes(bedrooms)) return false;
    return true;
  });
}

// ───────── Admin CRUD ─────────

export async function createProperty(data) {
  if (!isDBConnected()) throw new Error("Database not connected");

  // Generate ID from name if not provided
  const propertyId = data.propertyId || data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

  const property = new PropertyModel({
    propertyId,
    name: data.name,
    location: data.location,
    type: data.type || "Apartments",
    bedrooms: parseBedrooms(data.bedrooms),
    priceFrom: data.priceFrom,
    currency: data.currency || "USD",
    amenities: data.amenities || [],
    status: data.status || "Now Selling",
    images: data.images || [],
    projectUrl: data.projectUrl || "",
    description: data.description || "",
    active: true,
  });

  await property.save();
  console.log(`[Properties] Created: ${property.name} (${propertyId})`);
  return docToProperty(property.toObject());
}

export async function updateProperty(propertyId, updates) {
  if (!isDBConnected()) throw new Error("Database not connected");

  // Parse bedrooms if provided
  if (updates.bedrooms !== undefined) {
    updates.bedrooms = parseBedrooms(updates.bedrooms);
  }

  const doc = await PropertyModel.findOneAndUpdate(
    { propertyId },
    { $set: updates },
    { new: true }
  );
  if (!doc) return null;
  console.log(`[Properties] Updated: ${doc.name} (${propertyId})`);
  return docToProperty(doc.toObject());
}

export async function deleteProperty(propertyId) {
  if (!isDBConnected()) throw new Error("Database not connected");

  // Soft delete
  const doc = await PropertyModel.findOneAndUpdate(
    { propertyId },
    { active: false },
    { new: true }
  );
  if (!doc) return null;
  console.log(`[Properties] Deleted (soft): ${doc.name} (${propertyId})`);
  return docToProperty(doc.toObject());
}

// ───────── WhatsApp Formatting ─────────

export function formatPropertyCard(property) {
  let beds;
  if (!property.bedrooms || property.bedrooms.length === 0) {
    beds = "🏨 Investment Property";
  } else if (property.bedrooms.includes(0)) {
    const others = property.bedrooms.filter((b) => b > 0);
    beds = `🛏️ Studio${others.length ? `, ${others.join(", ")} bedroom` : ""}`;
  } else {
    beds = `🛏️ ${property.bedrooms.join(", ")} bedroom`;
  }

  return [
    `🏠 *${property.name}*`,
    `📍 ${property.location}`,
    `${beds}`,
    `💰 From $${property.priceFrom.toLocaleString()}`,
    `📋 ${property.status}`,
    ``,
    property.description,
    property.projectUrl ? `\n🔗 Learn more: ${property.projectUrl}` : "",
  ].join("\n");
}

/**
 * Build property context for the AI system prompt.
 * Dynamically generated from the database.
 */
export async function getPropertyContext() {
  const properties = await getAllProperties();

  return properties.map((p, i) => {
    let beds;
    if (!p.bedrooms || p.bedrooms.length === 0) {
      beds = "Investment Property";
    } else if (p.bedrooms.includes(0)) {
      const others = p.bedrooms.filter((b) => b > 0);
      beds = `Studio${others.length ? `, ${others.join(", ")} bedroom` : ""}`;
    } else {
      beds = `${p.bedrooms.join(", ")} bedroom`;
    }

    return [
      `${i + 1}. *${p.name}* — ${p.location}`,
      `   - Type: ${p.type} (${beds})`,
      `   - Price: Starting from $${p.priceFrom.toLocaleString()}`,
      `   - Status: ${p.status}`,
      p.description ? `   - ${p.description}` : "",
      p.projectUrl ? `   - Link: ${p.projectUrl}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}
