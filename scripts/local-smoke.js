const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const connectDatabase = require("../config/db-config");
const { pub, sub } = require("../redis/redisClient");
const Chat = require("../models/chat");
const { connectProducer, produceMessage, disconnectProducer } = require("../kafka/kafka");

async function main() {
    const messageId = crypto.randomUUID();
    const roomid = new mongoose.Types.ObjectId().toString();
    const senderId = new mongoose.Types.ObjectId().toString();
    const channel = `room:${roomid}`;
    let resolveEvent;
    let rejectEvent;
    const redisEvent = new Promise((resolve, reject) => {
        resolveEvent = resolve;
        rejectEvent = reject;
    });
    const timer = setTimeout(() => rejectEvent(new Error("Timed out waiting for worker Redis publication")), 20_000);
    let databaseReady = false;

    try {
        await connectDatabase();
        databaseReady = true;
        await Chat.init();
        await Promise.all([pub.connect(), sub.connect()]);
        await connectProducer();
        sub.on("message", (receivedChannel, serialized) => {
            if (receivedChannel !== channel) return;
            const payload = JSON.parse(serialized);
            if (payload.messageId === messageId) resolveEvent(payload);
        });
        await sub.subscribe(channel);
        await produceMessage({
            messageId,
            roomid,
            senderId,
            sender: "Local infrastructure smoke test",
            message: `local verification ${messageId}`,
            createdAt: new Date().toISOString(),
        });

        const event = await redisEvent;
        assert.equal(event.messageId, messageId, "Redis event should carry the Kafka message ID");
        assert.equal(event.roomid, roomid, "Redis event should use the expected room channel");
        const saved = await Chat.findOne({ messageId }).lean();
        assert.ok(saved, "Kafka worker should persist the record in MongoDB");
        assert.equal(saved.content, event.message, "MongoDB and Redis should contain the same message");
        const copies = await Chat.countDocuments({ messageId });
        assert.equal(copies, 1, "Idempotent persistence should leave one MongoDB document");
        console.log(JSON.stringify({ level: "info", event: "local_infrastructure_smoke_passed", messageId, roomid, checks: ["kafka", "redis", "mongodb"] }));
    } finally {
        clearTimeout(timer);
        if (databaseReady) await Chat.deleteOne({ messageId }).catch(() => {});
        await sub.unsubscribe(channel).catch(() => {});
        await Promise.allSettled([disconnectProducer(), pub.quit(), sub.quit(), mongoose.disconnect()]);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(JSON.stringify({ level: "error", event: "local_infrastructure_smoke_failed", error: error.message }));
        process.exitCode = 1;
    });
}

module.exports = { main };
