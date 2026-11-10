process.env.MONGODB_TARGET = "local";
process.env.LOCAL_DB_URL = "mongodb://127.0.0.1:27017/test-only";
process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-characters";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const User = require("../models/user");
const { createToken, userFromCookieHeader } = require("../security/auth");

const USER_ID = "507f1f77bcf86cd799439011";

test("session version invalidates old cookies after logout", async () => {
    const originalFindById = User.findById;
    let currentVersion = 1;
    User.findById = () => ({ select: () => ({ lean: async () => ({
        _id: USER_ID,
        username: "member",
        displayName: "Member",
        sessionVersion: currentVersion,
    }) }) });
    try {
        const staleCookie = `chat_session=${createToken(USER_ID, 0)}`;
        assert.equal(await userFromCookieHeader(staleCookie), null);
        currentVersion = 0;
        assert.equal((await userFromCookieHeader(staleCookie))._id, USER_ID);
    } finally {
        User.findById = originalFindById;
    }
});

test("logout increments session version and disconnects this process's authenticated sockets", async () => {
    const routePath = require.resolve("../routes/authRoutes");
    const originalLoad = Module._load;
    let versionIncremented = false;
    let disconnectedUser = null;
    let cookieCleared = false;
    const mocks = {
        "../models/user": {
            async updateOne(filter, update) {
                assert.equal(String(filter._id), USER_ID);
                assert.deepEqual(update, { $inc: { sessionVersion: 1 } });
                versionIncremented = true;
            },
        },
        "../security/auth": {
            sameOrigin: (_req, _res, next) => next(),
            requireAuth: (_req, _res, next) => next(),
            hashPassword() {}, verifyPassword() {}, setSessionCookie() {},
            clearSessionCookie() { cookieCleared = true; },
        },
        "../security/socketRegistry": { disconnectUser(id) { disconnectedUser = String(id); } },
    };
    delete require.cache[routePath];
    Module._load = function(request, parent, isMain) {
        if (parent?.filename === routePath && Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
        return originalLoad.call(this, request, parent, isMain);
    };
    let router;
    try {
        router = require(routePath);
    } finally {
        Module._load = originalLoad;
        delete require.cache[routePath];
    }
    const handler = router.stack.find((layer) => layer.route?.path === "/logout").route.stack.at(-1).handle;
    const response = { redirected: null, redirect(url) { this.redirected = url; } };
    await handler({ user: { _id: USER_ID } }, response);
    assert.equal(versionIncremented, true);
    assert.equal(disconnectedUser, USER_ID);
    assert.equal(cookieCleared, true);
    assert.equal(response.redirected, "/auth");
});
