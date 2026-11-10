const http = require("http");

function createWorkerHealth({ getMongoReady, getRedisReady }) {
    let consumer = "starting";
    let processing = "idle";
    let stopping = false;
    let lastProcessedAt = null;
    let lastFailure = null;
    let retryCount = 0;

    function snapshot() {
        const mongoReady = Boolean(getMongoReady());
        const redisReady = Boolean(getRedisReady());
        const ready = !stopping && consumer === "ready" && processing !== "recovering" && mongoReady && redisReady;
        const status = stopping ? "stopping" : ready ? "ready" : consumer === "failed" ? "failed" : "recovering";
        return {
            status,
            ready,
            consumer,
            processing,
            dependencies: { mongodb: mongoReady, redis: redisReady },
            lastProcessedAt,
            retryCount,
            lastFailure,
        };
    }

    function setConsumer(state, error) {
        consumer = state;
        if (error) lastFailure = { component: "kafka", name: error.name || "Error", at: new Date().toISOString() };
        if (state === "ready") lastFailure = null;
    }

    function setProcessingRecovering(details = {}) {
        processing = "recovering";
        retryCount = details.totalFailures || retryCount + 1;
        lastFailure = {
            component: details.component || "worker",
            name: details.errorName || "Error",
            at: new Date().toISOString(),
        };
    }

    function markProcessed() {
        processing = "idle";
        retryCount = 0;
        lastProcessedAt = new Date().toISOString();
        lastFailure = null;
    }

    function setFailed(error) {
        consumer = "failed";
        processing = "blocked";
        if (error) lastFailure = { component: "kafka", name: error.name || "Error", at: new Date().toISOString() };
    }

    function beginShutdown() {
        stopping = true;
        consumer = "stopping";
    }

    function listen(port = 3002, host = "0.0.0.0") {
        const server = http.createServer((request, response) => {
            if (request.method !== "GET" || !["/health/live", "/health/ready"].includes(request.url)) {
                response.writeHead(404).end();
                return;
            }
            const status = snapshot();
            const live = request.url === "/health/live";
            response.writeHead(live || status.ready ? 200 : 503, { "Content-Type": "application/json" });
            response.end(JSON.stringify(live ? { status: stopping ? "stopping" : "alive" } : status));
        });
        return new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(port, host, () => {
                server.removeListener("error", reject);
                resolve(server);
            });
        });
    }

    return { snapshot, setConsumer, setProcessingRecovering, markProcessed, setFailed, beginShutdown, listen };
}

module.exports = { createWorkerHealth };
