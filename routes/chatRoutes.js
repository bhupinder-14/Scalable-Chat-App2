const express = require("express");
const router = express.Router();
const Group = require("../models/group");
const Chat = require("../models/chat");
const mongoose = require("mongoose");
const { canAccessRoom } = require("../security/roomAccess");

router.get("/:roomid", async (req, res) => {
    try {
        const { roomid } = req.params;
        const user = req.user.displayName;

        if (!mongoose.isValidObjectId(roomid)) return res.status(404).send("Chat room not found");
        const group = await Group.findById(roomid).populate("participants", "displayName username");
        if (!group) return res.status(404).send("Chat room not found");
        if (!canAccessRoom(group, req.user._id)) return res.status(403).send("Not authorized to access this chat room");
        const chats = (await Chat.find({ roomid }).sort({ createdAt: -1, _id: -1 }).limit(500)).reverse();

        const directRecipient = group.isPersonal
            ? group.participants.find((participant) => String(participant._id) !== String(req.user._id))
            : null;
        const groupname = group.isPersonal ? `Conversation with ${directRecipient?.displayName || "another user"}` : group.name;
        res.render("index", { roomid, user, userId: String(req.user._id), groupname, previousmsgs: chats });
    } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "chat_page_failed", error: error.message }));
        res.status(500).send("Unable to load chat room");
    }
});

module.exports = router;
