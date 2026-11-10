const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const ejs = require("ejs");

test("chat template escapes display data and loads only the external script", async () => {
    const file = path.join(__dirname, "..", "views", "index.ejs");
    const html = await ejs.renderFile(file, {
        groupname: "<script>alert(1)</script>",
        roomid: "507f1f77bcf86cd799439011",
        user: "<img src=x onerror=alert(1)>",
        userId: "507f1f77bcf86cd799439012",
        previousmsgs: [{ messageId: "test-id", senderId: "507f1f77bcf86cd799439012", sender: "<b>name</b>", content: "<svg onload=alert(1)>" }],
    });
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(!html.includes("<img src=x onerror=alert(1)>"));
    assert.ok(!html.includes("<svg onload=alert(1)>"));
    assert.match(html, /<script src="\/scripts\/chat\.js"><\/script>/);
    assert.ok(!html.includes("<script>\n"));
});

test("authentication page loads its dedicated stylesheet without changing dashboard styling", () => {
    const auth = fs.readFileSync(path.join(__dirname, "..", "views", "auth.ejs"), "utf8");
    const home = fs.readFileSync(path.join(__dirname, "..", "views", "home.ejs"), "utf8");
    const authCss = fs.readFileSync(path.join(__dirname, "..", "public", "styles", "auth.css"), "utf8");
    assert.match(auth, /href="\/styles\/auth\.css"/);
    assert.match(auth, /<body class="auth-page">/);
    assert.match(home, /href="\/styles\/homepage\.css"/);
    assert.match(authCss, /\.auth-page h2[\s\S]*?color:\s*#333/);
    assert.match(authCss, /\.auth-page label[\s\S]*?color:\s*#333/);
    assert.match(authCss, /\.auth-page input[\s\S]*?border:/);
    assert.match(authCss, /\.auth-page button[\s\S]*?background:\s*#007bff/);
    assert.match(authCss, /@media\s*\(max-width:\s*480px\)/);
});

test("all EJS views compile with the data their routes provide", async () => {
    const views = path.join(__dirname, "..", "views");
    const cases = [
        ["auth.ejs", { error: null }],
        ["home.ejs", { groups: [], conversations: [], users: [], user: { _id: "507f1f77bcf86cd799439012", displayName: "Demo" } }],
        ["join.ejs", { roomid: "507f1f77bcf86cd799439011" }],
        ["group.ejs", {}],
        ["index.ejs", { groupname: "Demo", roomid: "507f1f77bcf86cd799439011", user: "Demo", userId: "507f1f77bcf86cd799439012", previousmsgs: [] }],
    ];
    for (const [filename, data] of cases) {
        const output = await ejs.renderFile(path.join(views, filename), data);
        assert.ok(output.includes("<!DOCTYPE html>"), `${filename} did not render`);
    }
});
