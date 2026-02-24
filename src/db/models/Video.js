import mongoose from "mongoose";

const videoSchema = new mongoose.Schema(
  {
    // Unique identifier
    videoId: { type: String, required: true, unique: true },

    // Which property this video belongs to
    propertyId: { type: String, required: true, index: true },

    // Original filename
    filename: { type: String, default: "" },

    // MIME type (video/mp4, video/webm, etc.)
    contentType: { type: String, required: true },

    // Video binary data stored as Buffer
    data: { type: Buffer, required: true },

    // File size in bytes
    size: { type: Number, default: 0 },

    // Optional caption / description
    caption: { type: String, default: "" },

    // Sort order for multiple videos per property
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model("Video", videoSchema);
