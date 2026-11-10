const path = require("path");
require("dotenv").config({
    path: process.env.APP_ENV_FILE || path.resolve(__dirname, "..", ".env.local"),
    quiet: true,
});
const crypto = require("crypto");
const { resolveMongoTarget } = require("./database-target");

function required(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
}

function parseTrustProxy(value) {
    if (typeof value !== "string" || !value.trim() || value.trim().toLowerCase() === "false") return false;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (/^\d+$/.test(normalized)) return Number(normalized);
    return value.trim();
}

const sessionSecret = process.env.SESSION_SECRET || (process.env.NODE_ENV === "production"
    ? required("SESSION_SECRET")
    : crypto.randomBytes(32).toString("hex"));
if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters");
}
const { target: mongodbTarget, dbUrl } = resolveMongoTarget();

module.exports = {
    port: Number(process.env.PORT || 3001),
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    mongodbTarget,
    dbUrl,
    redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
    kafkaBrokers: (process.env.KAFKA_BROKERS || "127.0.0.1:9092").split(",").map((broker) => broker.trim()).filter(Boolean),
    allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    sessionSecret,
    parseTrustProxy,
};
