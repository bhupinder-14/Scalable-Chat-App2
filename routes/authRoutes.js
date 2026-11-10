const express = require("express");
const User = require("../models/user");
const rateLimit = require("../security/rateLimit");
const { hashPassword, verifyPassword, setSessionCookie, clearSessionCookie, requireAuth, sameOrigin } = require("../security/auth");
const { disconnectUser } = require("../security/socketRegistry");

const router = express.Router();
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

router.get("/", (req, res) => {
    if (req.user) return res.redirect("/group");
    res.render("auth", { error: null });
});

router.post("/register", sameOrigin, authLimiter, async (req, res) => {
    const displayName = typeof req.body.displayName === "string" ? req.body.displayName.trim() : "";
    const username = typeof req.body.username === "string" ? req.body.username.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!/^[a-z0-9_]{3,32}$/.test(username) || displayName.length < 1 || displayName.length > 32 || password.length < 12 || password.length > 128) {
        return res.status(400).render("auth", { error: "Use a 3–32 character username, display name up to 32 characters, and password of 12–128 characters." });
    }
    try {
        const { salt, hash } = await hashPassword(password);
        const user = await User.create({ username, displayName, passwordSalt: salt, passwordHash: hash });
        setSessionCookie(res, user._id, user.sessionVersion || 0);
        res.redirect("/group");
    } catch (error) {
        if (error.code === 11000) return res.status(409).render("auth", { error: "That username is already registered." });
        console.error(JSON.stringify({ level: "error", event: "registration_failed", error: error.message }));
        res.status(500).render("auth", { error: "Account could not be created." });
    }
});

router.post("/login", sameOrigin, authLimiter, async (req, res) => {
    const username = typeof req.body.username === "string" ? req.body.username.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    try {
        const user = await User.findOne({ username }).select("+passwordHash +passwordSalt +sessionVersion username displayName");
        const valid = user && password.length <= 128
            ? await verifyPassword(password, user.passwordSalt, user.passwordHash)
            : password.length <= 128
                ? await verifyPassword(password, "nonexistent-account-salt", "00".repeat(64))
                : false;
        if (!valid) return res.status(401).render("auth", { error: "Username or password is incorrect." });
        setSessionCookie(res, user._id, user.sessionVersion || 0);
        res.redirect("/group");
    } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "login_failed", error: error.message }));
        res.status(500).render("auth", { error: "Unable to sign in right now." });
    }
});

router.post("/logout", sameOrigin, requireAuth, async (req, res) => {
    try {
        await User.updateOne({ _id: req.user._id }, { $inc: { sessionVersion: 1 } });
        disconnectUser(req.user._id);
        clearSessionCookie(res);
        res.redirect("/auth");
    } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "logout_failed", error: error.message }));
        res.status(500).send("Unable to sign out right now");
    }
});

module.exports = router;
