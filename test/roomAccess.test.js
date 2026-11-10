const test = require("node:test");
const assert = require("node:assert/strict");
const Group = require("../models/group");
const { canAccessRoom } = require("../security/roomAccess");

const A = "507f1f77bcf86cd799439011";
const B = "507f1f77bcf86cd799439012";
const C = "507f1f77bcf86cd799439013";

test("explicitly classified public groups remain accessible to authenticated users", () => {
    assert.equal(canAccessRoom({ isPersonal: false }, A), true);
    assert.equal(canAccessRoom({ isPersonal: false, participants: [] }, C), true);
});

test("only both valid participants can access a well-formed private conversation", () => {
    const directRoom = { isPersonal: true, participants: [{ _id: A }, B] };
    assert.equal(canAccessRoom(directRoom, A), true);
    assert.equal(canAccessRoom(directRoom, B), true);
    assert.equal(canAccessRoom(directRoom, C), false);
    assert.equal(canAccessRoom(null, A), false);
});

test("missing classification fails closed, including Mongoose-applied schema defaults", () => {
    assert.equal(canAccessRoom({}, A), false);
    assert.equal(canAccessRoom({ isPersonal: undefined }, A), false);
    const hydratedDefault = new Group({ name: "unclassified" });
    assert.equal(hydratedDefault.isPersonal, false);
    assert.equal(hydratedDefault.$isDefault("isPersonal"), true);
    assert.equal(canAccessRoom(hydratedDefault, A), false);
    const explicitPublic = new Group({ name: "public", isPersonal: false });
    assert.equal(canAccessRoom(explicitPublic, A), true);
});

test("private conversations reject missing, malformed, duplicate, or non-pair participants", () => {
    for (const participants of [undefined, null, "bad", [], [A], [A, B, C], [A, A], [A, "not-an-id"]]) {
        assert.equal(canAccessRoom({ isPersonal: true, participants }, A), false);
    }
    assert.equal(canAccessRoom({ isPersonal: true, participants: [A, B] }, "not-an-id"), false);
});

test("nonexistent room IDs cannot grant access", () => {
    assert.equal(canAccessRoom(null, A), false);
});
