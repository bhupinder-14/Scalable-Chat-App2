const mongoose = require('mongoose');

const groupSchema = new mongoose.Schema({
    name: { type: String, trim: true, maxlength: 100, default: "" },
    isPersonal: { type: Boolean, default: false },
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    pairKey: { type: String, unique: true, sparse: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });

groupSchema.index({ participants: 1 });

const Group = mongoose.models.Group || mongoose.model("Group", groupSchema);

module.exports = Group;
