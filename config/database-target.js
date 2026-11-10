const LOCAL_MONGO_HOSTS = new Set(["mongo", "localhost", "127.0.0.1", "::1", "host.docker.internal"]);

function validateLocalMongoUri(uri) {
    const match = /^mongodb:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(uri);
    if (!match) {
        throw new Error("LOCAL_DB_URL must be a mongodb:// URI for the local MongoDB service.");
    }

    const authority = match[1];
    if (authority.includes("@")) {
        throw new Error("LOCAL_DB_URL must not contain credentials; keep Atlas credentials in DB_URL.");
    }

    const hosts = authority.split(",").map((hostPort) => {
        if (hostPort.startsWith("[")) return hostPort.slice(1, hostPort.indexOf("]")).toLowerCase();
        return hostPort.replace(/:\d+$/, "").toLowerCase();
    });
    if (!hosts.length || hosts.some((host) => !LOCAL_MONGO_HOSTS.has(host))) {
        throw new Error("LOCAL_DB_URL must point to mongo, localhost, or another approved local MongoDB host; Atlas hosts are not allowed for the local target.");
    }
}

function resolveMongoTarget(env = process.env) {
    const target = typeof env.MONGODB_TARGET === "string" ? env.MONGODB_TARGET.trim() : "";
    if (!target) {
        throw new Error('Missing required environment variable MONGODB_TARGET. Set it to "local" or "atlas".');
    }
    if (target !== "local" && target !== "atlas") {
        throw new Error(`Invalid MONGODB_TARGET "${target}". Supported values are "local" and "atlas".`);
    }

    const sourceVariable = target === "local" ? "LOCAL_DB_URL" : "DB_URL";
    const dbUrl = env[sourceVariable];
    if (typeof dbUrl !== "string" || !dbUrl.trim()) {
        throw new Error(`MONGODB_TARGET is "${target}" but required environment variable ${sourceVariable} is missing.`);
    }
    if (target === "local") validateLocalMongoUri(dbUrl.trim());

    return { target, dbUrl: dbUrl.trim(), sourceVariable };
}

module.exports = { resolveMongoTarget, validateLocalMongoUri };
