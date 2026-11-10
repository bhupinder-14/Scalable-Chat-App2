const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
    messageId: { type: String, required: true, unique: true, sparse: true },
    content: { type: String, required: true, maxlength: 2000 },
    sender: { type: String, required: true, maxlength: 32 },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    roomid: { type: mongoose.Schema.Types.ObjectId, ref: "Group", required: true },
}, { timestamps: true });

chatSchema.index({ roomid: 1, createdAt: -1, _id: -1 });

const Chat = mongoose.models.Chat || mongoose.model("Chat", chatSchema);

module.exports = Chat;
