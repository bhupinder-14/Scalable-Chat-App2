process.env.MONGODB_TARGET = "local";
process.env.LOCAL_DB_URL = "mongodb://127.0.0.1:27017/test-only";
process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-characters";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    COOKIE_NAME, parseCookies, createToken, decodeToken, setSessionCookie,
    hashPassword, verifyPassword, sameOrigin,
} = require("../security/auth");

test("cookie parsing handles multiple cookies and values containing equals", () => {
    assert.deepEqual(parseCookies("a=1; chat_session=abc==; empty="), { a: "1", chat_session: "abc==", empty: "" });
});

test("session token accepts a valid signature and rejects tampering", () => {
    const token = createToken("507f1f77bcf86cd799439011", 3);
    assert.equal(decodeToken(token).sub, "507f1f77bcf86cd799439011");
    assert.equal(decodeToken(`${token}x`), null);
    assert.equal(decodeToken("not-a-token"), null);
});

test("session cookie has the expected restrictive flags", () => {
    const response = { setHeader(name, value) { this[name] = value; } };
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    setSessionCookie(response, "507f1f77bcf86cd799439011", 0);
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
    assert.match(response["Set-Cookie"], new RegExp(`^${COOKIE_NAME}=`));
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Max-Age=86400"]) assert.ok(response["Set-Cookie"].includes(flag));
});

test("password hashes verify without storing the raw password", async () => {
    const { salt, hash } = await hashPassword("correct horse battery staple");
    assert.notEqual(hash, "correct horse battery staple");
    assert.equal(await verifyPassword("correct horse battery staple", salt, hash), true);
    assert.equal(await verifyPassword("incorrect password", salt, hash), false);
});

test("same-origin middleware rejects cross-site writes", () => {
    let status = 0;
    let body = "";
    let proceeded = false;
    const req = { get: (name) => ({ origin: "https://evil.example", "sec-fetch-site": "cross-site" })[name], protocol: "https" };
    const res = { status(code) { status = code; return this; }, send(value) { body = value; } };
    sameOrigin(req, res, () => { proceeded = true; });
    assert.equal(status, 403);
    assert.match(body, /Cross-origin/);
    assert.equal(proceeded, false);
});
