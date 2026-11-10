const test = require("node:test");
const assert = require("node:assert/strict");
const rateLimit = require("../security/rateLimit");

test("rate limiter allows the configured number and returns 429 beyond it", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1, key: () => "test-client" });
    let passed = 0;
    let code = 0;
    let retryAfter = "";
    const req = {};
    const res = {
        set(name, value) { if (name === "Retry-After") retryAfter = value; return this; },
        status(value) { code = value; return this; },
        send() { return this; },
    };
    limiter(req, res, () => { passed += 1; });
    limiter(req, res, () => { passed += 1; });
    assert.equal(passed, 1);
    assert.equal(code, 429);
    assert.ok(Number(retryAfter) > 0);
});
