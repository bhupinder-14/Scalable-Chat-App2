const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const ChatModel = require("../models/chat");
const { createPersistAndFanout } = require("../kafka/messagePipeline");

test("Kafka worker persists idempotently before publishing a Redis room event", async () => {
    let query;
    let update;
    let options;
    const redisEvents = [];
    const saved = {
        messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        roomid: "507f1f77bcf86cd799439011",
        senderId: "507f1f77bcf86cd799439012",
        sender: "Asha",
        content: "hello",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const Chat = { findOneAndUpdate(filter, updateDoc, opts) {
        query = filter;
        update = updateDoc;
        options = opts;
        return { lean: async () => saved };
    } };
    const pub = { async publish(channel, value) { redisEvents.push({ channel, data: JSON.parse(value) }); } };
    const persist = createPersistAndFanout({ Chat, pub });

    await persist({
        messageId: saved.messageId,
        roomid: saved.roomid,
        senderId: saved.senderId,
        sender: saved.sender,
        message: saved.content,
        socketId: "socket-a",
        requestId: saved.messageId,
        createdAt: saved.createdAt.toISOString(),
    });

    assert.deepEqual(query, { messageId: saved.messageId });
    assert.equal(update.$setOnInsert.messageId, saved.messageId);
    assert.equal(options.upsert, true);
    assert.equal(redisEvents.length, 1);
    assert.equal(redisEvents[0].channel, `room:${saved.roomid}`);
    assert.equal(redisEvents[0].data.message, "hello");
});

test("Mongoose timestamp regression is avoided and duplicate Kafka records preserve insert timestamps", async () => {
    const messageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const roomid = "507f1f77bcf86cd799439011";
    const senderId = "507f1f77bcf86cd799439012";
    const createdAt = new Date("2026-01-02T03:04:05.000Z");
    const updates = [];
    const saved = {
        messageId,
        roomid: new mongoose.Types.ObjectId(roomid),
        senderId: new mongoose.Types.ObjectId(senderId),
        sender: "Asha",
        content: "timestamp regression",
        createdAt,
    };
    const originalFindOneAndUpdate = ChatModel.collection.findOneAndUpdate;
    ChatModel.collection.findOneAndUpdate = async (_filter, update) => {
        updates.push(structuredClone(update));
        return saved;
    };

    try {
        // This is the pre-fix operation: Mongoose adds $set.updatedAt while
        // the application also supplies $setOnInsert.updatedAt.
        await ChatModel.findOneAndUpdate(
            { messageId },
            { $setOnInsert: { messageId, roomid, senderId, sender: "Asha", content: "timestamp regression", createdAt, updatedAt: createdAt } },
            { upsert: true, returnDocument: "after" },
        ).lean().exec();
        assert.ok(updates[0].$set.updatedAt instanceof Date);
        assert.ok(updates[0].$setOnInsert.updatedAt instanceof Date);

        const published = [];
        const persist = createPersistAndFanout({
            Chat: ChatModel,
            pub: { async publish(channel, value) { published.push({ channel, payload: JSON.parse(value) }); } },
        });
        const record = {
            messageId,
            roomid,
            senderId,
            sender: "Asha",
            message: "timestamp regression",
            createdAt: createdAt.toISOString(),
        };
        await persist(record);
        await persist(record);

        const pipelineUpdates = updates.slice(1);
        assert.equal(pipelineUpdates.length, 2);
        for (const update of pipelineUpdates) {
            assert.equal(update.$set, undefined, "timestamps:false should prevent Mongoose from adding $set.updatedAt");
            assert.equal(update.$setOnInsert.createdAt.getTime(), createdAt.getTime());
            assert.equal(update.$setOnInsert.updatedAt.getTime(), createdAt.getTime());
            assert.equal(update.$setOnInsert.content, "timestamp regression");
        }
        assert.equal(published.length, 2);
        assert.equal(published[0].payload.messageId, published[1].payload.messageId);
        assert.equal(published[0].payload.createdAt, createdAt.toISOString());
    } finally {
        ChatModel.collection.findOneAndUpdate = originalFindOneAndUpdate;
    }
});

test("Kafka worker rejects malformed or oversized message records", async () => {
    const persist = createPersistAndFanout({ Chat: {}, pub: {} });
    await assert.rejects(persist({ message: "x" }), /Invalid Kafka chat record/);
});
