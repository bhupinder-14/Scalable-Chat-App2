const crypto = require("crypto");
const mongoose = require("mongoose");
const { sub } = require("../redis/redisClient");
const Group = require("../models/group");
const socketRegistry = require("../security/socketRegistry");
const { produceMessage } = require("../kafka/kafka");
const { canAccessRoom } = require("../security/roomAccess");

const onlineUsers = new Map();
const connectionCounts = new Map();
const MESSAGE_WINDOW_MS = 10_000;
const MESSAGE_LIMIT = 8;
const CONNECTION_LIMIT = 4;

function removeFromRoom(io, socket) {
    const { user, roomid } = socket.data;
    if (!roomid || !user || !onlineUsers.has(roomid)) return Promise.resolve();
    const users = onlineUsers.get(roomid);
    const userId = String(user._id);
    const presence = users.get(userId);
    if (presence) presence.sockets.delete(socket.id);
    if (presence && presence.sockets.size === 0) {
        users.delete(userId);
        io.to(roomid).emit("user_left", presence.name);
    }
    io.to(roomid).emit("update_online_users", Array.from(users.values(), (entry) => entry.name));
    if (users.size === 0) {
        onlineUsers.delete(roomid);
        return sub.unsubscribe(`room:${roomid}`).catch((error) => {
            console.error(JSON.stringify({ level: "error", event: "redis_unsubscribe_failed", error: error.message }));
        });
    }
    return Promise.resolve();
}

module.exports = (io) => {
    io.on("connection", (socket) => {
        const user = socket.data.user;
        const userId = String(user._id);
        const activeConnections = connectionCounts.get(userId) || 0;
        if (activeConnections >= CONNECTION_LIMIT) {
            socket.emit("server_error", "Too many active connections");
            socket.disconnect(true);
            return;
        }
        connectionCounts.set(userId, activeConnections + 1);
        socketRegistry.register(socket);
        socket.data.messageWindow = { started: Date.now(), count: 0 };
        console.log(JSON.stringify({ level: "info", event: "socket_connected", socketId: socket.id, userId }));

        socket.on("join_room", async (data = {}, acknowledge = () => {}) => {
            const roomid = typeof data.roomid === "string" ? data.roomid : "";
            if (!mongoose.isValidObjectId(roomid)) return acknowledge({ ok: false, error: "Invalid room" });
            try {
                const group = await Group.findById(roomid).select("_id isPersonal participants");
                if (!group) return acknowledge({ ok: false, error: "Room not found" });
                if (!canAccessRoom(group, userId)) return acknowledge({ ok: false, error: "Not authorized to access this room" });
                if (socket.data.roomid && socket.data.roomid !== roomid) {
                    const previousRoom = socket.data.roomid;
                    await removeFromRoom(io, socket);
                    await socket.leave(previousRoom);
                    socket.data.roomid = null;
                }
                await socket.join(roomid);
                if (!onlineUsers.has(roomid)) onlineUsers.set(roomid, new Map());
                if (!onlineUsers.get(roomid).has(userId)) onlineUsers.get(roomid).set(userId, { name: user.displayName, sockets: new Set() });
                onlineUsers.get(roomid).get(userId).sockets.add(socket.id);
                socket.data.roomid = roomid;
                await sub.subscribe(`room:${roomid}`);
                io.to(roomid).emit("update_online_users", Array.from(onlineUsers.get(roomid).values(), (entry) => entry.name));
                acknowledge({ ok: true });
            } catch (error) {
                if (socket.data.roomid === roomid) {
                    await removeFromRoom(io, socket);
                    socket.data.roomid = null;
                }
                await socket.leave(roomid);
                console.error(JSON.stringify({ level: "error", event: "room_join_failed", error: error.message }));
                acknowledge({ ok: false, error: "Unable to join this room" });
            }
        });

        socket.on("new_msg", async (data = {}, acknowledge = () => {}) => {
            const roomid = typeof data.roomid === "string" ? data.roomid : "";
            const message = typeof data.message === "string" ? data.message.trim() : "";
            const window = socket.data.messageWindow;
            const now = Date.now();
            if (now - window.started >= MESSAGE_WINDOW_MS) socket.data.messageWindow = { started: now, count: 0 };
            if (++socket.data.messageWindow.count > MESSAGE_LIMIT) {
                acknowledge({ ok: false, error: "You are sending messages too quickly" });
                return;
            }
            if (!mongoose.isValidObjectId(roomid) || !message || message.length > 2000) {
                acknowledge({ ok: false, error: "Invalid message" });
                return;
            }
            const requestId = typeof data.requestId === "string" && /^[a-f\d-]{36}$/i.test(data.requestId)
                ? data.requestId : crypto.randomUUID();
            try {
                const group = await Group.findById(roomid).select("_id isPersonal participants");
                if (!group) {
                    acknowledge({ ok: false, error: "Room not found" });
                    return;
                }
                if (!canAccessRoom(group, userId)) {
                    acknowledge({ ok: false, error: "Not authorized to access this room" });
                    if (socket.data.roomid === roomid) {
                        await removeFromRoom(io, socket);
                        await socket.leave(roomid);
                        socket.data.roomid = null;
                    }
                    return;
                }
                if (socket.data.roomid !== roomid) {
                    acknowledge({ ok: false, error: "Join this room before sending" });
                    return;
                }
                await produceMessage({
                    messageId: requestId,
                    roomid,
                    sender: user.displayName,
                    senderId: userId,
                    message,
                    socketId: socket.id,
                    requestId,
                    createdAt: new Date().toISOString(),
                });
                acknowledge({ ok: true, requestId, queued: true });
            } catch (error) {
                console.error(JSON.stringify({ level: "error", event: "message_publish_failed", error: error.message }));
                acknowledge({ ok: false, error: "Message could not be sent" });
            }
        });

        socket.on("disconnect", async () => {
            socketRegistry.unregister(socket);
            await removeFromRoom(io, socket);
            socket.data.roomid = null;
            const remaining = (connectionCounts.get(userId) || 1) - 1;
            if (remaining <= 0) connectionCounts.delete(userId);
            else connectionCounts.set(userId, remaining);
        });
    });

    sub.on("message", async (channel, serialized) => {
        let data;
        try {
            data = JSON.parse(serialized);
            if (!data || channel !== `room:${data.roomid}` || !mongoose.isValidObjectId(data.roomid)
                || typeof data.messageId !== "string" || typeof data.senderId !== "string"
                || typeof data.sender !== "string" || typeof data.message !== "string" || data.message.length > 2000) {
                throw new Error("Invalid Redis message payload");
            }
            io.to(data.roomid).emit("msg_rcvd", {
                messageId: data.messageId,
                roomid: data.roomid,
                sender: data.sender,
                senderId: data.senderId,
                message: data.message,
                createdAt: data.createdAt,
            });
            if (data.socketId && data.requestId) io.to(data.socketId).emit("message_status", { requestId: data.requestId, ok: true });
        } catch (error) {
            console.error(JSON.stringify({ level: "error", event: "message_persist_failed", channel, error: error.message }));
            if (data && data.socketId && data.requestId) io.to(data.socketId).emit("message_status", { requestId: data.requestId, ok: false });
        }
    });
};
