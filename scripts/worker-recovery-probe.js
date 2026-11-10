// Safe local fault-injection helper. It creates only uniquely identified probe
// messages; cleanup always requires the exact messageId printed by `fixture`.
const crypto = require("crypto");
const mongoose = require("mongoose");
const Redis = require("ioredis");
const connectDatabase = require("../config/db-config");
const { redisUrl, kafkaBrokers } = require("../config/server-config");
const Chat = require("../models/chat");
const { Kafka, Partitioners } = require("kafkajs");

const kafka = new Kafka({ clientId: "scalable-chat-recovery-probe", brokers: kafkaBrokers });
const topic = "Chats";
const groupId = "scalable-chat-local";
const validId = /^[a-f\d-]{36}$/i;

function validObjectId(value) {
    return mongoose.isValidObjectId(value);
}

function output(value) {
    console.log(JSON.stringify(value));
}

async function fixture() {
    const messageId = crypto.randomUUID();
    output({
        messageId,
        roomid: new mongoose.Types.ObjectId().toString(),
        senderId: new mongoose.Types.ObjectId().toString(),
        createdAt: new Date().toISOString(),
    });
}

async function observe(roomid, messageId, timeoutMs = 120_000, expectedEvents = 1) {
    if (!validObjectId(roomid) || !validId.test(messageId)) throw new Error("Expected valid roomid and messageId");
    const sub = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
    sub.on("error", (error) => console.error(JSON.stringify({ level: "warn", event: "probe_redis_reconnect", name: error.name, code: error.code })));
    await sub.connect();
    const channel = `room:${roomid}`;
    try {
        await sub.subscribe(channel);
        output({ event: "observer_ready", roomid, messageId, expectedEvents });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Timed out waiting for matching Redis event")), timeoutMs);
            let matchingEvents = 0;
            sub.on("message", (receivedChannel, value) => {
                if (receivedChannel !== channel) return;
                let event;
                try { event = JSON.parse(value); } catch { return; }
                if (event.messageId !== messageId) return;
                matchingEvents += 1;
                if (matchingEvents >= expectedEvents) {
                    clearTimeout(timer);
                    output({ event: "matching_redis_events", messageId, roomid, count: matchingEvents });
                    resolve();
                }
            });
        });
    } finally {
        await sub.unsubscribe(channel).catch(() => {});
        await sub.quit().catch(() => sub.disconnect());
    }
}

async function publish(messageId, roomid, senderId, createdAt, duplicate = false) {
    if (!validId.test(messageId) || !validObjectId(roomid) || !validObjectId(senderId) || Number.isNaN(Date.parse(createdAt))) {
        throw new Error("Expected valid fixture identifiers and ISO createdAt");
    }
    const producer = kafka.producer({ createPartitioner: Partitioners.LegacyPartitioner });
    try {
        await producer.connect();
        const original = { messageId, roomid, senderId, sender: "Recovery probe", message: `recovery probe ${messageId}`, createdAt };
        const first = await producer.send({ topic, messages: [{ key: messageId, value: JSON.stringify(original) }] });
        let second = null;
        if (duplicate) {
            const repeated = { ...original, message: "duplicate payload must not replace original", createdAt: new Date(Date.parse(createdAt) + 60_000).toISOString() };
            second = await producer.send({ topic, messages: [{ key: messageId, value: JSON.stringify(repeated) }] });
        }
        output({ event: "probe_enqueued", messageId, duplicate, offsets: [...first, ...(second || [])].map(({ partition, baseOffset }) => ({ partition, baseOffset })) });
    } finally {
        await producer.disconnect().catch(() => {});
    }
}

async function verify(messageId, expectedCreatedAt) {
    if (!validId.test(messageId) || Number.isNaN(Date.parse(expectedCreatedAt))) throw new Error("Expected valid messageId and ISO timestamp");
    await connectDatabase();
    try {
        const [count, saved] = await Promise.all([
            Chat.countDocuments({ messageId }),
            Chat.findOne({ messageId }).select({ content: 1, createdAt: 1, updatedAt: 1 }).lean(),
        ]);
        const expectedMessage = `recovery probe ${messageId}`;
        const correctTimestamp = Boolean(saved) && new Date(saved.createdAt).getTime() === Date.parse(expectedCreatedAt)
            && new Date(saved.updatedAt).getTime() === Date.parse(expectedCreatedAt);
        const originalContentPreserved = Boolean(saved) && saved.content === expectedMessage;
        output({ event: "probe_database_verification", messageId, count, found: Boolean(saved), correctTimestamp, originalContentPreserved });
        if (count !== 1 || !correctTimestamp || !originalContentPreserved) process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
    }
}

async function cleanup(messageId) {
    if (!validId.test(messageId)) throw new Error("Cleanup requires the exact UUID messageId");
    await connectDatabase();
    try {
        const result = await Chat.deleteOne({ messageId, sender: "Recovery probe", content: `recovery probe ${messageId}` });
        output({ event: "probe_cleanup", messageId, deletedCount: result.deletedCount });
    } finally {
        await mongoose.disconnect();
    }
}

async function offsets() {
    const admin = kafka.admin();
    try {
        await admin.connect();
        const data = await admin.fetchOffsets({ groupId, topic });
        const partitions = data.flatMap(({ partitions: values = [] }) => values.map(({ partition, offset, metadata }) => ({ partition, offset, metadata })));
        output({ event: "read_only_consumer_offsets", groupId, topic, partitions });
    } finally {
        await admin.disconnect().catch(() => {});
    }
}

async function main() {
    const [command, ...args] = process.argv.slice(2);
    if (command === "fixture") return fixture();
    if (command === "observe") return observe(args[0], args[1], Number(args[2]) || 120_000, Math.max(1, Number(args[3]) || 1));
    if (command === "publish") return publish(args[0], args[1], args[2], args[3], args[4] === "duplicate");
    if (command === "verify") return verify(args[0], args[1]);
    if (command === "cleanup") return cleanup(args[0]);
    if (command === "offsets") return offsets();
    throw new Error("Usage: fixture | observe <roomid> <messageId> [timeoutMs] | publish <messageId> <roomid> <senderId> <createdAt> [duplicate] | verify <messageId> <createdAt> | cleanup <messageId> | offsets");
}

if (require.main === module) {
    main().catch((error) => {
        console.error(JSON.stringify({ level: "error", event: "recovery_probe_failed", error: error.message }));
        process.exitCode = 1;
    });
}

module.exports = { main, fixture, observe, publish, verify, cleanup, offsets };
