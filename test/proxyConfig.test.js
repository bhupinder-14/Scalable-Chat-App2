const test = require("node:test");
const assert = require("node:assert/strict");
const { parseTrustProxy } = require("../config/server-config");

test("proxy trust defaults to disabled and accepts explicit deployment settings", () => {
    assert.equal(parseTrustProxy(undefined), false);
    assert.equal(parseTrustProxy("false"), false);
    assert.equal(parseTrustProxy("1"), 1);
    assert.equal(parseTrustProxy("loopback"), "loopback");
    assert.equal(parseTrustProxy("10.0.0.0/8"), "10.0.0.0/8");
    assert.equal(parseTrustProxy("true"), true);
});
