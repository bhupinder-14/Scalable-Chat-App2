const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

const ROOM = "507f1f77bcf86cd799439011";
const ALICE = "507f1f77bcf86cd799439012";
const BOB = "507f1f77bcf86cd799439013";
const OUTSIDER = "507f1f77bcf86cd799439014";

function createHarness(initialGroup) {
    let group = initialGroup;
    const redisPath = require.resolve("../redis/redisClient");
    const groupPath = require.resolve("../models/group");
    const kafkaPath = require.resolve("../kafka/kafka");
    const handlerPath = require.resolve("../sockets/socketHandlers");
    const originalLoad = Module._load;
    const sub = new EventEmitter();
    sub.subscribe = async () => 1;
    sub.unsubscribe = async () => 0;
    const published = [];
    const kafka = { async produceMessage(data) { published.push(data); } };
    const mocks = {
        [redisPath]: { pub: {}, sub },
        [groupPath]: { findById: (id) => ({ select: async () => String(id) === String(group?._id) ? group : null }) },
        [kafkaPath]: kafka,
    };
    for (const file of [redisPath, groupPath, kafkaPath, handlerPath]) delete require.cache[file];
    Module._load = function(request, parent, isMain) {
        if (parent?.filename === handlerPath) {
            if (request === "../redis/redisClient") return mocks[redisPath];
            if (request === "../models/group") return mocks[groupPath];
            if (request === "../kafka/kafka") return mocks[kafkaPath];
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    let registerHandlers;
    try {
        registerHandlers = require(handlerPath);
    } finally {
        Module._load = originalLoad;
    }
    const ioHandlers = new Map();
    const broadcasts = [];
    const io = {
        on(event, callback) { ioHandlers.set(event, callback); },
        to(room) { return { emit(event, data) { broadcasts.push({ room, event, data }); } }; },
    };
    registerHandlers(io);
    const sockets = [];
    function connect(id, userId, displayName) {
        const handlers = new Map();
        const socket = {
            id,
            data: { user: { _id: userId, displayName } },
            handlers,
            emitted: [],
            async join() {},
            async leave() {},
            on(event, callback) { handlers.set(event, callback); },
            emit(event, data) { this.emitted.push({ event, data }); },
            disconnect() {},
        };
        sockets.push(socket);
        ioHandlers.get("connection")(socket);
        return socket;
    }
    return {
        connect, sockets, broadcasts, published, sub,
        setGroup(value) { group = value; },
        async cleanup() {
            for (const socket of sockets) await socket.handlers.get("disconnect")?.();
            delete require.cache[handlerPath];
        },
    };
}

function emitAck(socket, event, data) {
    return new Promise((resolve) => socket.handlers.get(event)(data, resolve));
}

test("public room allows authenticated members to join and send via Kafka/Redis confirmation", async () => {
    const harness = createHarness({ _id: ROOM, isPersonal: false, participants: [] });
    try {
        const alice = harness.connect("socket-a", ALICE, "Asha");
        const bob = harness.connect("socket-b", BOB, "Ravi");
        assert.deepEqual(await emitAck(alice, "join_room", { roomid: ROOM }), { ok: true });
        assert.deepEqual(await emitAck(bob, "join_room", { roomid: ROOM }), { ok: true });
        const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const acknowledgement = await emitAck(alice, "new_msg", { roomid: ROOM, message: "hello", sender: "Impersonated", requestId });
        assert.deepEqual(acknowledgement, { ok: true, requestId, queued: true });
        assert.equal(harness.published.length, 1);
        assert.equal(harness.published[0].sender, "Asha");
        assert.equal(harness.published[0].senderId, ALICE);
        assert.equal(harness.published[0].message, "hello");
        harness.sub.emit("message", `room:${ROOM}`, JSON.stringify({ ...harness.published[0], createdAt: new Date().toISOString() }));
        await new Promise(setImmediate);
        assert.ok(harness.broadcasts.some((entry) => entry.event === "msg_rcvd" && entry.data.sender === "Asha"));
        assert.ok(harness.broadcasts.some((entry) => entry.event === "message_status" && entry.data.ok));
    } finally {
        await harness.cleanup();
    }
});

test("both private participants can join; an outsider cannot join or send to the guessed room ID", async () => {
    const harness = createHarness({ _id: ROOM, isPersonal: true, participants: [ALICE, BOB] });
    try {
        const alice = harness.connect("socket-a", ALICE, "Asha");
        const bob = harness.connect("socket-b", BOB, "Ravi");
        const outsider = harness.connect("socket-c", OUTSIDER, "Guest");
        assert.deepEqual(await emitAck(alice, "join_room", { roomid: ROOM }), { ok: true });
        assert.deepEqual(await emitAck(bob, "join_room", { roomid: ROOM }), { ok: true });
        assert.deepEqual(await emitAck(outsider, "join_room", { roomid: ROOM }), {
            ok: false,
            error: "Not authorized to access this room",
        });
        assert.deepEqual(await emitAck(outsider, "join_room", { roomid: "507f1f77bcf86cd799439099" }), {
            ok: false,
            error: "Room not found",
        });
        const sendResult = await emitAck(outsider, "new_msg", {
            roomid: ROOM,
            message: "should not be sent",
            requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        });
        assert.deepEqual(sendResult, { ok: false, error: "Not authorized to access this room" });
        assert.equal(harness.published.length, 0);
    } finally {
        await harness.cleanup();
    }
});

test("socket send rechecks private membership after a room has been joined", async () => {
    const harness = createHarness({ _id: ROOM, isPersonal: true, participants: [ALICE, BOB] });
    try {
        const bob = harness.connect("socket-b", BOB, "Ravi");
        assert.deepEqual(await emitAck(bob, "join_room", { roomid: ROOM }), { ok: true });
        harness.setGroup({ _id: ROOM, isPersonal: true, participants: [ALICE, OUTSIDER] });
        const result = await emitAck(bob, "new_msg", { roomid: ROOM, message: "membership changed" });
        assert.deepEqual(result, { ok: false, error: "Not authorized to access this room" });
        assert.equal(harness.published.length, 0);
    } finally {
        await harness.cleanup();
    }
});
