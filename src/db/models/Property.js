import mongoose from "mongoose";

const propertySchema = new mongoose.Schema({
  propertyId: { type: String, required: true, unique: true, index: true },
  name:        { type: String, required: true },
  location:    { type: String, required: true },
  type:        { type: String, required: true },  // Apartments, Townhouses, Townhomes, Hotel Apartments
  bedrooms:    [Number],          // e.g. [0, 1, 2, 3] — 0 = studio
  priceFrom:   { type: Number, required: true },
  currency:    { type: String, default: "USD" },
  amenities:   [String],
  status:      { type: String, default: "Now Selling" },
  images:      [String],
  videos:      [String],
  projectUrl:  String,
  description: String,
  active:      { type: Boolean, default: true },  // soft-delete toggle
}, {
  timestamps: true,
});

export default mongoose.model("Property", propertySchema);
