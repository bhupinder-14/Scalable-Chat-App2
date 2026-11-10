const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const callerId = "507f1f77bcf86cd799439011";
const partnerId = "507f1f77bcf86cd799439012";
const outsiderId = "507f1f77bcf86cd799439013";
const roomid = "507f1f77bcf86cd799439014";

function getRouteHandler(modulePath, mocks, path) {
    const resolved = require.resolve(modulePath);
    const originalLoad = Module._load;
    delete require.cache[resolved];
    Module._load = function(request, parent, isMain) {
        if (parent?.filename === resolved && Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const router = require(resolved);
        const route = router.stack.find((layer) => layer.route?.path === path).route;
        return route.stack[0].handle;
    } finally {
        Module._load = originalLoad;
        delete require.cache[resolved];
    }
}

function responseRecorder() {
    return {
        code: 200,
        body: null,
        rendered: null,
        status(code) { this.code = code; return this; },
        send(body) { this.body = body; return this; },
        render(view, data) { this.rendered = { view, data }; return this; },
    };
}

test("private conversation participant can retrieve history", async () => {
    let historyQueries = 0;
    const group = { _id: roomid, isPersonal: true, participants: [callerId, partnerId] };
    const handler = getRouteHandler("../routes/chatRoutes", {
        "../models/group": { findById: () => ({ populate: async () => group }) },
        "../models/chat": { find: () => { historyQueries += 1; return { sort() { return this; }, limit: async () => [] }; } },
    }, "/:roomid");
    const res = responseRecorder();
    await handler({ params: { roomid }, user: { _id: callerId, displayName: "Member" } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.rendered.view, "index");
    assert.equal(historyQueries, 1);
});

test("third user is denied private history before any message query", async () => {
    let historyQueries = 0;
    const group = { _id: roomid, isPersonal: true, participants: [callerId, partnerId] };
    const handler = getRouteHandler("../routes/chatRoutes", {
        "../models/group": { findById: () => ({ populate: async () => group }) },
        "../models/chat": { find: () => { historyQueries += 1; throw new Error("History must not be queried"); } },
    }, "/:roomid");
    const res = responseRecorder();
    await handler({ params: { roomid }, user: { _id: outsiderId, displayName: "Outsider" } }, res);
    assert.equal(res.code, 403);
    assert.match(res.body, /Not authorized/);
    assert.equal(historyQueries, 0);
});

test("missing private classification and nonexistent rooms fail closed in HTTP history", async () => {
    for (const group of [{ _id: roomid }, null]) {
        const handler = getRouteHandler("../routes/chatRoutes", {
            "../models/group": { findById: () => ({ populate: async () => group }) },
            "../models/chat": { find: () => { throw new Error("History must not be queried"); } },
        }, "/:roomid");
        const res = responseRecorder();
        await handler({ params: { roomid }, user: { _id: callerId, displayName: "Member" } }, res);
        assert.equal(res.code, group ? 403 : 404);
    }
    const malformedIdHandler = getRouteHandler("../routes/chatRoutes", {}, "/:roomid");
    const malformed = responseRecorder();
    await malformedIdHandler({ params: { roomid: "not-an-object-id" }, user: { _id: callerId } }, malformed);
    assert.equal(malformed.code, 404);
});
