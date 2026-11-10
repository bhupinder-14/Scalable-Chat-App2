const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const { KafkaJSConnectionError } = require("kafkajs");
const {
    TransientInfrastructureError,
    runWithRecovery,
    isTransientMongoError,
    isTransientRedisError,
    isTransientKafkaError,
} = require("../worker/retryPolicy");
const { watchConsumer } = require("../worker/consumerLifecycle");
const { createWorkerHealth } = require("../worker/health");

test("transient MongoDB failure retries without resolving work until persistence succeeds", async () => {
    let calls = 0;
    let resolved = false;
    const result = await runWithRecovery(async () => {
        calls += 1;
        if (calls < 3) throw new TransientInfrastructureError("mongodb", new Error("offline"));
        resolved = true;
        return "persisted";
    }, { fastRetryBaseMs: 1, fastRetryMaxMs: 1, random: () => 0, sleepFn: async () => {} });
    assert.equal(result, "persisted");
    assert.equal(calls, 3);
    assert.equal(resolved, true);
});

test("Redis failures remain retryable and recovery uses capped backoff", async () => {
    assert.equal(isTransientRedisError(Object.assign(new Error("socket"), { code: "ECONNRESET" }), "ready"), true);
    assert.equal(isTransientMongoError(Object.assign(new Error("network"), { name: "MongoNetworkError" }), 1), true);
    const delays = [];
    let attempts = 0;
    await runWithRecovery(async () => {
        attempts += 1;
        if (attempts <= 9) throw new TransientInfrastructureError("redis", new Error("offline"));
        return "published";
    }, {
        maxAttemptsPerCycle: 3,
        fastRetryBaseMs: 1,
        fastRetryMaxMs: 2,
        recoveryBaseMs: 5,
        recoveryMaxMs: 7,
        random: () => 0,
        sleepFn: async (ms) => delays.push(ms),
    });
    assert.equal(attempts, 10);
    assert.deepEqual(delays.slice(0, 3), [1, 2, 4]);
    assert.ok(delays.every((delay) => delay <= 7));
});

test("non-transient failures stop processing rather than being acknowledged", async () => {
    await assert.rejects(runWithRecovery(async () => { throw new Error("invalid record"); }, {
        sleepFn: async () => assert.fail("permanent errors must not retry"),
    }), /Non-transient message processing failure/);
});

test("Kafka broker disconnection is classified for bounded startup recovery", () => {
    assert.equal(isTransientKafkaError(new KafkaJSConnectionError("broker disconnected")), true);
    assert.equal(isTransientKafkaError(new Error("bad application record")), false);
});

test("Kafka crash events distinguish automatic restart from terminal crash", () => {
    const consumer = new EventEmitter();
    consumer.events = { GROUP_JOIN: "group_join", CRASH: "crash", STOP: "stop" };
    const changes = [];
    const watcher = watchConsumer(consumer, { onStateChange: (...args) => changes.push(args) });
    consumer.emit("crash", { payload: { restart: true, error: new Error("broker") } });
    consumer.emit("group_join", {});
    consumer.emit("crash", { payload: { restart: false, error: new Error("poison record") } });
    assert.deepEqual(changes.map(([state]) => state), ["recovering", "ready", "failed"]);
    watcher.detach();
});

test("unexpected consumer stop marks worker unhealthy; intentional stop is ignored", () => {
    const consumer = new EventEmitter();
    consumer.events = { GROUP_JOIN: "group_join", CRASH: "crash", STOP: "stop" };
    let stopping = false;
    const changes = [];
    watchConsumer(consumer, { onStateChange: (state) => changes.push(state), isStopping: () => stopping });
    consumer.emit("stop");
    stopping = true;
    consumer.emit("stop");
    assert.deepEqual(changes, ["failed"]);
});

test("worker readiness reports consumer and dependency failures", () => {
    let mongo = true;
    let redis = true;
    const health = createWorkerHealth({ getMongoReady: () => mongo, getRedisReady: () => redis });
    assert.equal(health.snapshot().ready, false);
    health.setConsumer("ready");
    assert.equal(health.snapshot().ready, true);
    redis = false;
    assert.equal(health.snapshot().ready, false);
    redis = true;
    health.setProcessingRecovering({ component: "mongodb", totalFailures: 1, errorName: "MongoNetworkError" });
    assert.equal(health.snapshot().status, "recovering");
    health.setFailed(new Error("consumer stopped"));
    assert.equal(health.snapshot().status, "failed");
    mongo = false;
    assert.equal(health.snapshot().dependencies.mongodb, false);
});
