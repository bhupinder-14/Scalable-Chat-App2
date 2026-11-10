const express = require("express");
const http = require("http");
const path = require("path");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const User = require("./models/user");
const Group = require("./models/group");
const Chat = require("./models/chat");
const connect = require("./config/db-config");
const { pub, sub } = require("./redis/redisClient");
const { port, trustProxy, allowedOrigins } = require("./config/server-config");
const socketHandlers = require("./sockets/socketHandlers");
const kafka = require("./kafka/kafka");
const { chatRoutes, groupRoutes, joinRoutes } = require("./routes");
const authRoutes = require("./routes/authRoutes");
const { loadUser, requireAuth, userFromCookieHeader } = require("./security/auth");

const app = express();
app.set("trust proxy", trustProxy);
app.disable("x-powered-by");
const server = http.createServer(app);
const corsOrigins = new Set([...allowedOrigins, process.env.RENDER_EXTERNAL_URL].filter(Boolean));
const io = new Server(server, {
    cors: {
        origin(origin, callback) {
            if (!origin || corsOrigins.has(origin) || (process.env.NODE_ENV !== "production" && corsOrigins.size === 0)) return callback(null, true);
            return callback(new Error("Origin is not allowed by CORS"));
        },
        methods: ["GET", "POST"],
    },
});

app.set("view engine", "ejs");
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: true, limit: "32kb" }));
app.use((_req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "strict-origin-when-cross-origin");
    res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.set("Content-Security-Policy", "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:");
    if (process.env.NODE_ENV === "production") res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
});
app.use(express.static(path.join(__dirname, "public")));
app.get("/health/live", (_req, res) => res.status(200).json({ status: "ok" }));
app.get("/health/ready", (_req, res) => {
    const ready = mongoose.connection.readyState === 1 && pub.status === "ready" && sub.status === "ready" && kafka.producerReady;
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready" });
});
app.get("/", (_req, res) => res.redirect("/group"));

app.use(loadUser);
app.use("/auth", authRoutes);
app.use("/group", requireAuth, groupRoutes);
app.use("/chat", requireAuth, chatRoutes);
app.use("/join", requireAuth, joinRoutes);
app.use((error, _req, res, _next) => {
    console.error(JSON.stringify({ level: "error", message: error.message }));
    res.status(500).send("Internal server error");
});

socketHandlers(io);
io.use(async (socket, next) => {
    try {
        const origin = socket.handshake.headers.origin;
        if (origin && !corsOrigins.has(origin) && !(process.env.NODE_ENV !== "production" && corsOrigins.size === 0)) {
            return next(new Error("Origin is not allowed"));
        }
        const user = await userFromCookieHeader(socket.request.headers.cookie);
        if (!user) return next(new Error("Authentication required"));
        socket.data.user = user;
        return next();
    } catch {
        return next(new Error("Authentication unavailable"));
    }
});

async function start() {
    await connect();
    await Promise.all([User.init(), Group.init(), Chat.init()]);
    await Promise.all([pub.connect(), sub.connect()]);
    await kafka.connectProducer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "0.0.0.0", () => {
            server.removeListener("error", reject);
            resolve();
        });
    });
    console.log(JSON.stringify({ level: "info", message: "server listening", port }));
}

let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: "info", message: "shutdown started", signal }));
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    try {
        await new Promise((resolve) => io.close(resolve));
        await Promise.allSettled([pub.quit(), sub.quit(), mongoose.disconnect(), kafka.disconnectProducer()]);
        clearTimeout(timeout);
        process.exit(0);
    } catch (error) {
        console.error(JSON.stringify({ level: "error", message: "shutdown failed", error: error.message }));
        process.exit(1);
    }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (error) => {
    console.error(JSON.stringify({ level: "error", message: "unhandled rejection", error: error.message }));
    shutdown("unhandledRejection");
});

start().catch((error) => {
    console.error(JSON.stringify({ level: "fatal", message: "startup failed", error: error.message }));
    process.exit(1);
});
