const mongoose = require("mongoose");
const { KafkaJSNonRetriableError } = require("kafkajs");
const connectDatabase = require("./config/db-config");
const { pub } = require("./redis/redisClient");
const Chat = require("./models/chat");
const { consumeMessages, disconnectConsumer } = require("./kafka/kafka");
const { createPersistAndFanout } = require("./kafka/messagePipeline");
const { createWorkerHealth } = require("./worker/health");
const {
    TransientInfrastructureError,
    isTransientMongoError,
    isTransientRedisError,
    isTransientKafkaError,
    runWithRecovery,
    sleep,
} = require("./worker/retryPolicy");

const persistAndFanout = createPersistAndFanout({ Chat, pub });
let abortController = new AbortController();
let healthServer = null;
let stopping = false;
const health = createWorkerHealth({
    getMongoReady: () => mongoose.connection.readyState === 1,
    getRedisReady: () => pub.status === "ready",
});

function asTransient(component, error) {
    if (error instanceof TransientInfrastructureError) return error;
    if (component === "mongodb" && isTransientMongoError(error, mongoose.connection.readyState)) {
        return new TransientInfrastructureError(component, error);
    }
    if (component === "redis" && isTransientRedisError(error, pub.status)) {
        return new TransientInfrastructureError(component, error);
    }
    if (component === "kafka" && isTransientKafkaError(error)) {
        return new TransientInfrastructureError(component, error);
    }
    return error;
}

async function initializeDependency(component, task, ready) {
    let failures = 0;
    while (!stopping) {
        try {
            await task();
            if (ready && !ready()) throw new TransientInfrastructureError(component, new Error("Dependency not ready"));
            return;
        } catch (originalError) {
            const error = asTransient(component, originalError);
            if (!(error instanceof TransientInfrastructureError)) throw error;
            failures += 1;
            const delayMs = Math.min(30_000, 1000 * (2 ** Math.min(failures - 1, 5)));
            console.error(JSON.stringify({ level: "warn", event: "worker_dependency_retry", component, failures, delayMs, error: error.cause?.name || error.name }));
            await sleep(delayMs, abortController.signal);
        }
    }
    throw new KafkaJSNonRetriableError("Worker is stopping");
}

async function start() {
    if (!healthServer) healthServer = await health.listen(Number(process.env.WORKER_HEALTH_PORT) || 3002);

    await initializeDependency("mongodb", connectDatabase, () => mongoose.connection.readyState === 1);
    await initializeDependency("mongodb", () => Chat.init(), () => mongoose.connection.readyState === 1);
    await initializeDependency("redis", async () => {
        if (pub.status === "ready") return;
        if (pub.status === "wait" || pub.status === "end") await pub.connect();
        else await new Promise((resolve, reject) => {
            const onReady = () => { cleanup(); resolve(); };
            const onError = (error) => { cleanup(); reject(error); };
            const cleanup = () => { pub.removeListener("ready", onReady); pub.removeListener("error", onError); };
            pub.once("ready", onReady);
            pub.once("error", onError);
        });
    }, () => pub.status === "ready");

    let processingSequence = Promise.resolve();
    await initializeDependency("kafka", () => consumeMessages(async ({ topic, partition, message, heartbeat }) => {
        // KafkaJS resolves and commits the offset only after this promise succeeds.
        // Serialize local retries and heartbeat so a slow outage cannot let the group expire.
        processingSequence = processingSequence.then(async () => {
            try {
                if (!message.value) throw new KafkaJSNonRetriableError("Kafka record has no value");
                let record;
                try {
                    record = JSON.parse(message.value.toString("utf8"));
                } catch (error) {
                    throw new KafkaJSNonRetriableError("Kafka record contains invalid JSON", { cause: error });
                }
                await runWithRecovery(() => persistAndFanout(record), {
                    heartbeat,
                    signal: abortController.signal,
                    onRetry: (details) => {
                        health.setProcessingRecovering(details);
                        console.error(JSON.stringify({ level: "warn", event: "message_retry", topic, partition, offset: message.offset, ...details }));
                    },
                    onSuccess: (details) => console.log(JSON.stringify({ level: "info", event: "message_recovered", topic, partition, offset: message.offset, ...details })),
                });
                health.markProcessed();
            } catch (originalError) {
                const error = originalError instanceof KafkaJSNonRetriableError
                    ? originalError
                    : new KafkaJSNonRetriableError("Permanent message processing failure; offset left unresolved", { cause: originalError });
                console.error(JSON.stringify({ level: "error", event: "kafka_record_processing_failed", topic, partition, offset: message.offset, error: error.message }));
                throw error;
            }
        });
        return processingSequence;
    }, {
        onStateChange: (state, error) => {
            health.setConsumer(state, error);
            console.log(JSON.stringify({ level: state === "failed" ? "error" : "info", event: "worker_consumer_state", state, error: error?.name }));
        },
    }), () => true);

    console.log(JSON.stringify({ level: "info", event: "worker_started", healthPort: Number(process.env.WORKER_HEALTH_PORT) || 3002 }));
}

async function shutdown() {
    if (stopping) return;
    stopping = true;
    health.beginShutdown();
    abortController.abort();
    await Promise.allSettled([disconnectConsumer(), pub.quit(), mongoose.disconnect()]);
    if (healthServer) await new Promise((resolve) => healthServer.close(resolve));
}

if (require.main === module) {
    process.on("SIGINT", () => shutdown().finally(() => process.exit(0)));
    process.on("SIGTERM", () => shutdown().finally(() => process.exit(0)));
    start().catch(async (error) => {
        console.error(JSON.stringify({ level: "fatal", event: "worker_start_failed", error: error.message }));
        await shutdown();
        process.exitCode = 1;
    });
}

module.exports = { start, shutdown, persistAndFanout, health, initializeDependency };
