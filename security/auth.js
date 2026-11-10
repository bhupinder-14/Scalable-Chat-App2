const crypto = require("crypto");
const { promisify } = require("util");
const User = require("../models/user");
const { sessionSecret } = require("../config/server-config");

const scrypt = promisify(crypto.scrypt);
const COOKIE_NAME = "chat_session";
const SESSION_SECONDS = 60 * 60 * 24;

function parseCookies(header = "") {
    const cookies = {};
    for (const part of header.split(";")) {
        const separator = part.indexOf("=");
        if (separator > 0) cookies[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
    }
    return cookies;
}

function signature(payload) {
    return crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
}

function createToken(userId, version = 0) {
    const payload = Buffer.from(JSON.stringify({ sub: String(userId), ver: version, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })).toString("base64url");
    return `${payload}.${signature(payload)}`;
}

function decodeToken(token) {
    if (typeof token !== "string" || token.length > 2048) return null;
    const [payload, supplied, extra] = token.split(".");
    if (!payload || !supplied || extra) return null;
    const expected = Buffer.from(signature(payload));
    const actual = Buffer.from(supplied);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (typeof data.sub !== "string" || !/^[a-f\d]{24}$/i.test(data.sub) || !Number.isInteger(data.ver) || !Number.isInteger(data.exp) || data.exp <= Date.now() / 1000) return null;
        return data;
    } catch {
        return null;
    }
}

function setSessionCookie(res, userId, version = 0) {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=${createToken(userId, version)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure}`);
}

function clearSessionCookie(res) {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

async function userFromCookieHeader(header) {
    const token = parseCookies(header)[COOKIE_NAME];
    const payload = decodeToken(token);
    if (!payload) return null;
    const user = await User.findById(payload.sub).select("username displayName +sessionVersion").lean();
    if (!user || user.sessionVersion !== payload.ver) return null;
    return user;
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return { salt, hash: derived.toString("hex") };
}

async function verifyPassword(password, salt, expectedHash) {
    const { hash } = await hashPassword(password, salt);
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(expectedHash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function loadUser(req, _res, next) {
    try {
        req.user = await userFromCookieHeader(req.headers.cookie);
        if (req.user) _res.set("Cache-Control", "private, no-store");
        next();
    } catch (error) {
        next(error);
    }
}

function requireAuth(req, res, next) {
    if (req.user) return next();
    if (req.accepts("html")) return res.redirect("/auth");
    return res.status(401).json({ error: "Authentication required" });
}

function sameOrigin(req, res, next) {
    const origin = req.get("origin");
    const fetchSite = req.get("sec-fetch-site");
    if ((origin && origin !== `${req.protocol}://${req.get("host")}`) || fetchSite === "cross-site") {
        return res.status(403).send("Cross-origin request rejected");
    }
    next();
}

module.exports = {
    COOKIE_NAME, SESSION_SECONDS, parseCookies, decodeToken, createToken,
    setSessionCookie, clearSessionCookie, userFromCookieHeader,
    hashPassword, verifyPassword, loadUser, requireAuth, sameOrigin,
};
