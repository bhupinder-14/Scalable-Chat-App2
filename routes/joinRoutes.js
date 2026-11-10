const express = require("express");
const router = express.Router();
const Group = require("../models/group");
const { canAccessRoom } = require("../security/roomAccess");

router.get("/", async (req, res) => {
    try {
        const { roomid } = req.query;
        if (typeof roomid !== "string" || !/^[a-f\d]{24}$/i.test(roomid)) return res.status(404).send("Chat room not found");
        const group = await Group.findById(roomid).select("_id isPersonal participants");
        if (!group) return res.status(404).send("Chat room not found");
        if (!canAccessRoom(group, req.user._id)) return res.status(403).send("Not authorized to access this chat room");
        res.redirect(`/chat/${group._id}`);
    } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "join_room_failed", error: error.message }));
        res.status(500).send("Unable to join room");
    }
});

module.exports = router;
