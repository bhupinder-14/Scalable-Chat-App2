const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveMongoTarget } = require("../config/database-target");

test("database target must be explicit", () => {
    assert.throws(() => resolveMongoTarget({}), /Missing required environment variable MONGODB_TARGET/);
});

test("unknown database target fails with supported choices", () => {
    assert.throws(() => resolveMongoTarget({ MONGODB_TARGET: "automatic" }), /Supported values are "local" and "atlas"/);
});

test("local target selects the local URI even when Atlas DB_URL is present", () => {
    assert.deepEqual(resolveMongoTarget({
        MONGODB_TARGET: "local",
        LOCAL_DB_URL: "mongodb://mongo:27017/scalable_chat",
        DB_URL: "mongodb+srv://atlas.example.invalid/production",
    }), {
        target: "local",
        dbUrl: "mongodb://mongo:27017/scalable_chat",
        sourceVariable: "LOCAL_DB_URL",
    });
});

test("local target rejects Atlas hosts and URI credentials", () => {
    assert.throws(() => resolveMongoTarget({ MONGODB_TARGET: "local", LOCAL_DB_URL: "mongodb://cluster.example.com/scalable_chat" }), /Atlas hosts are not allowed/);
    assert.throws(() => resolveMongoTarget({ MONGODB_TARGET: "local", LOCAL_DB_URL: "mongodb://user:password@mongo:27017/scalable_chat" }), /must not contain credentials/);
});

test("Atlas target requires and explicitly selects DB_URL", () => {
    assert.deepEqual(resolveMongoTarget({ MONGODB_TARGET: "atlas", DB_URL: "mongodb+srv://cluster.example.invalid/test" }), {
        target: "atlas",
        dbUrl: "mongodb+srv://cluster.example.invalid/test",
        sourceVariable: "DB_URL",
    });
});
