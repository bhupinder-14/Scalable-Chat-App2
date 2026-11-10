const mongoose = require("mongoose");
const {
    TransientInfrastructureError,
    isTransientMongoError,
    isTransientRedisError,
} = require("../worker/retryPolicy");

function createPersistAndFanout({ Chat, pub }) {
    return async function persistAndFanout(record) {
        if (!record || typeof record.messageId !== "string" || !/^[a-f\d-]{36}$/i.test(record.messageId)
            || !mongoose.isValidObjectId(record.roomid) || !mongoose.isValidObjectId(record.senderId)
            || typeof record.sender !== "string" || !record.sender.trim() || record.sender.length > 32
            || typeof record.message !== "string" || !record.message.trim() || record.message.length > 2000) {
            throw new Error("Invalid Kafka chat record");
        }
        const timestamp = Number.isNaN(Date.parse(record.createdAt)) ? new Date() : new Date(record.createdAt);
        let saved;
        try {
            saved = await Chat.findOneAndUpdate(
                { messageId: record.messageId },
                { $setOnInsert: {
                    messageId: record.messageId,
                    roomid: record.roomid,
                    senderId: record.senderId,
                    sender: record.sender,
                    content: record.message,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                } },
                { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, timestamps: false },
            ).lean();
        } catch (error) {
            if (isTransientMongoError(error, mongoose.connection.readyState)) {
                throw new TransientInfrastructureError("mongodb", error);
            }
            throw error;
        }

        try {
            await pub.publish(`room:${record.roomid}`, JSON.stringify({
                messageId: saved.messageId,
                roomid: String(saved.roomid),
                senderId: String(saved.senderId),
                sender: saved.sender,
                message: saved.content,
                createdAt: saved.createdAt.toISOString(),
                socketId: record.socketId,
                requestId: record.requestId,
            }));
        } catch (error) {
            if (isTransientRedisError(error, pub.status)) {
                throw new TransientInfrastructureError("redis", error);
            }
            throw error;
        }
        console.log(JSON.stringify({ level: "info", event: "message_persisted", messageId: saved.messageId, roomid: String(saved.roomid) }));
    };
}

module.exports = { createPersistAndFanout };
