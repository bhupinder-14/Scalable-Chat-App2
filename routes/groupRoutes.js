const express = require("express");
const router = express.Router();
const Group = require("../models/group");
const User = require("../models/user");
const rateLimit = require("../security/rateLimit");
const { sameOrigin } = require("../security/auth");
const { canAccessRoom } = require("../security/roomAccess");
const createGroupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });

router.get("/", async (req, res) => {
    try {
        const [groups, conversations, users] = await Promise.all([
            Group.find({ isPersonal: false }).sort({ _id: -1 }).limit(200),
            Group.find({ isPersonal: true, participants: req.user._id }).populate("participants", "displayName username").sort({ updatedAt: -1, _id: -1 }).limit(100),
            User.find({ _id: { $ne: req.user._id } }).select("username displayName").sort({ username: 1 }).limit(200).lean(),
        ]);
        res.render("home", { groups, conversations: conversations.filter((room) => canAccessRoom(room, req.user._id)), users, user: req.user });
    } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "group_list_failed", error: error.message }));
        res.status(500).send("Error fetching groups");
    }
});

router.post("/", sameOrigin, createGroupLimiter, async (req, res) => {
    try {
        const name = typeof req.body.name === "string" ? req.body.name.trim().slice(0, 100) : "";
        if (!name) return res.status(400).send("Group name is required");
        await Group.create({ name, createdBy: req.user._id, isPersonal: false });
        res.redirect("/group");
    } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "group_create_failed", error: error.message }));
        res.status(500).send("Unable to create group");
    }
});

router.post("/direct", sameOrigin, createGroupLimiter, async (req, res) => {
    const username = typeof req.body.username === "string" ? req.body.username.trim().toLowerCase() : "";
    if (!/^[a-z0-9_]{3,32}$/.test(username)) return res.status(400).send("Enter a valid username");
    try {
        const recipient = await User.findOne({ username }).select("_id username displayName").lean();
        if (!recipient || String(recipient._id) === String(req.user._id)) {
            return res.status(404).send("Choose another registered user");
        }
        const participants = [String(req.user._id), String(recipient._id)].sort();
        const pairKey = participants.join(":");
        let conversation;
        try {
            conversation = await Group.findOneAndUpdate(
                { pairKey },
                { $setOnInsert: { isPersonal: true, participants, pairKey, name: "", createdBy: req.user._id } },
                { new: true, upsert: true, setDefaultsOnInsert: true },
            );
        } catch (error) {
            if (error.code !== 11000) throw error;
            conversation = await Group.findOne({ pairKey });
        }
        if (!conversation || conversation.isPersonal !== true || !canAccessRoom(conversation, req.user._id)) {
            return res.status(403).send("Not authorized to access this chat room");
        }
        return res.redirect(`/chat/${conversation._id}`);
    } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "direct_room_create_failed", error: error.message }));
        return res.status(500).send("Unable to open direct conversation");
    }
});

module.exports = router;
