const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, minlength: 3, maxlength: 32, lowercase: true, trim: true },
    displayName: { type: String, required: true, maxlength: 32, trim: true },
    passwordHash: { type: String, required: true, select: false },
    passwordSalt: { type: String, required: true, select: false },
    sessionVersion: { type: Number, default: 0, select: false },
}, { timestamps: true });

module.exports = mongoose.models.User || mongoose.model("User", userSchema);
