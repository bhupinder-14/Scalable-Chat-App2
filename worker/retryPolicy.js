const { KafkaJSNonRetriableError } = require("kafkajs");

const MONGO_TRANSIENT_NAMES = new Set([
    "MongooseServerSelectionError",
    "MongoServerSelectionError",
    "MongoNetworkError",
    "MongoNetworkTimeoutError",
    "MongoNotConnectedError",
    "MongoTopologyClosedError",
    "MongoPoolClearedError",
    "MongoWaitQueueTimeoutError",
]);
const MONGO_TRANSIENT_CODES = new Set([6, 7, 89, 91, 189, 9001, 10107, 11600, 11602, 13435, 13436]);
const SOCKET_TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH"]);

class TransientInfrastructureError extends Error {
    constructor(component, cause) {
        super(`Transient ${component} failure`, { cause });
        this.name = "TransientInfrastructureError";
        this.component = component;
    }
}

function errorChain(error) {
    const chain = [];
    const seen = new Set();
    for (let current = error; current && !seen.has(current); current = current.cause) {
        seen.add(current);
        chain.push(current);
    }
    return chain;
}

function isTransientMongoError(error, readyState) {
    const chain = errorChain(error);
    return chain.some((current) => MONGO_TRANSIENT_NAMES.has(current.name)
        || MONGO_TRANSIENT_CODES.has(current.code)
        || (readyState !== 1 && current.name === "MongooseError"
            && /buffering timed out|not connected|server selection timed out/i.test(current.message || "")));
}

function isTransientRedisError(error, status) {
    const chain = errorChain(error);
    return status !== "ready" || chain.some((current) => current.name === "MaxRetriesPerRequestError"
        || SOCKET_TRANSIENT_CODES.has(current.code)
        || /reached the max retries per request|connection is closed|connect econn|read econn|write epipe/i.test(current.message || ""));
}

function isTransientInfrastructureError(error) {
    return error instanceof TransientInfrastructureError;
}

function isTransientKafkaError(error) {
    return errorChain(error).some((current) => current.retriable === true
        || current.name === "KafkaJSNumberOfRetriesExceeded"
        || SOCKET_TRANSIENT_CODES.has(current.code));
}

function jitteredBackoff(baseMs, maxMs, random = Math.random) {
    const capped = Math.min(baseMs, maxMs);
    return Math.max(1, Math.round(capped * (0.8 + random() * 0.4)));
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new KafkaJSNonRetriableError("Worker is stopping"));
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, ms);
        function abort() {
            clearTimeout(timer);
            reject(new KafkaJSNonRetriableError("Worker is stopping"));
        }
        signal?.addEventListener("abort", abort, { once: true });
    });
}

async function waitWithHeartbeat(ms, { heartbeat, signal, sleepFn = sleep } = {}) {
    let remaining = ms;
    while (remaining > 0) {
        const interval = Math.min(remaining, heartbeat ? 1000 : remaining);
        await sleepFn(interval, signal);
        remaining -= interval;
        if (heartbeat && !signal?.aborted) await heartbeat();
    }
}

async function runWithRecovery(task, {
    heartbeat,
    signal,
    onRetry = () => {},
    onSuccess = () => {},
    isTransient = isTransientInfrastructureError,
    maxAttemptsPerCycle = 3,
    fastRetryBaseMs = 250,
    fastRetryMaxMs = 2000,
    recoveryBaseMs = 5000,
    recoveryMaxMs = 30000,
    random = Math.random,
    sleepFn = sleep,
} = {}) {
    let attemptsInCycle = 0;
    let recoveryCycles = 0;
    let totalFailures = 0;

    for (;;) {
        if (signal?.aborted) throw new KafkaJSNonRetriableError("Worker is stopping");
        try {
            const result = await task();
            if (totalFailures > 0) onSuccess({ totalFailures, recoveryCycles });
            return result;
        } catch (error) {
            if (!isTransient(error)) {
                throw error instanceof KafkaJSNonRetriableError
                    ? error
                    : new KafkaJSNonRetriableError("Non-transient message processing failure", { cause: error });
            }

            totalFailures += 1;
            attemptsInCycle += 1;
            const enteringCooldown = attemptsInCycle >= maxAttemptsPerCycle;
            let delayMs;
            if (enteringCooldown) {
                attemptsInCycle = 0;
                recoveryCycles += 1;
                delayMs = jitteredBackoff(recoveryBaseMs * (2 ** (recoveryCycles - 1)), recoveryMaxMs, random);
            } else {
                delayMs = jitteredBackoff(fastRetryBaseMs * (2 ** (attemptsInCycle - 1)), fastRetryMaxMs, random);
            }

            onRetry({
                component: error.component || "infrastructure",
                errorName: error.name,
                totalFailures,
                recoveryCycles,
                delayMs,
                enteringCooldown,
            });
            await waitWithHeartbeat(delayMs, { heartbeat, signal, sleepFn });
        }
    }
}

module.exports = {
    TransientInfrastructureError,
    isTransientMongoError,
    isTransientRedisError,
    isTransientInfrastructureError,
    isTransientKafkaError,
    jitteredBackoff,
    waitWithHeartbeat,
    runWithRecovery,
};
