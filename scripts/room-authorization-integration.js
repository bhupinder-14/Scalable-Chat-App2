// Local-only authorization integration check. It creates isolated test users,
// rooms, and messages; uses the live HTTP and Socket.IO endpoints plus MongoDB,
// Kafka, and Redis; and cleans only exact records created by this run.
const assert = require("node:assert/strict");
const crypto = require("crypto");
const mongoose = require("mongoose");
const connectDatabase = require("../config/db-config");
const User = require("../models/user");
const Group = require("../models/group");
const Chat = require("../models/chat");
const { createToken } = require("../security/auth");

const createdUserIds = [];
const createdGroupIds = [];
const createdMessageIds = [];

class PollingSocket {
    constructor(baseUrl, user) {
        this.baseUrl = baseUrl;
        this.cookie = `chat_session=${createToken(String(user._id), user.sessionVersion || 0)}`;
        this.sid = null;
        this.nextAckId = 0;
    }

    async request(method, url, body) {
        const response = await fetch(url, {
            method,
            headers: { Cookie: this.cookie, ...(body === undefined ? {} : { "Content-Type": "text/plain;charset=UTF-8" }) },
            body,
        });
        if (!response.ok) throw new Error(`Socket.IO polling request failed with HTTP ${response.status}`);
        return response.text();
    }

    getUrl(withSid = true) {
        const query = new URLSearchParams({ EIO: "4", transport: "polling", t: `${Date.now()}-${Math.random()}` });
        if (withSid && this.sid) query.set("sid", this.sid);
        return `${this.baseUrl}/socket.io/?${query}`;
    }

    async pollPackets() {
        return (await this.request("GET", this.getUrl())).split("\x1e");
    }

    async connect() {
        const openingPacket = await this.request("GET", this.getUrl(false));
        if (!openingPacket.startsWith("0")) throw new Error("Socket.IO Engine.IO handshake did not open");
        this.sid = JSON.parse(openingPacket.slice(1)).sid;
        await this.request("POST", this.getUrl(), "40");
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            const packets = await this.pollPackets();
            if (packets.some((packet) => packet.startsWith("40"))) return;
            if (packets.some((packet) => packet.startsWith("44"))) throw new Error("Socket.IO rejected the authenticated session");
        }
        throw new Error("Timed out waiting for Socket.IO namespace connection");
    }

    async emitAck(event, data, timeoutMs = 15_000) {
        const id = this.nextAckId++;
        await this.request("POST", this.getUrl(), `42${id}${JSON.stringify([event, data])}`);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const packets = await this.pollPackets();
            const ack = packets.find((packet) => packet.startsWith(`43${id}`));
            if (ack) return JSON.parse(ack.slice(`43${id}`.length))[0];
            if (packets.some((packet) => packet.startsWith("44"))) throw new Error("Socket.IO rejected the event connection");
        }
        throw new Error(`Timed out waiting for Socket.IO acknowledgement: ${event}`);
    }

    async waitForEvent(eventName, predicate = () => true, timeoutMs = 20_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const packets = await this.pollPackets();
            for (const packet of packets) {
                if (!packet.startsWith("42")) continue;
                let event;
                try { event = JSON.parse(packet.slice(2)); } catch { continue; }
                if (Array.isArray(event) && event[0] === eventName && predicate(event[1])) return event[1];
            }
        }
        throw new Error(`Timed out waiting for Socket.IO event ${eventName}`);
    }

    async close() {
        if (!this.sid) return;
        try { await this.request("POST", this.getUrl(), "41"); } catch {}
        this.sid = null;
    }
}

async function waitForMessage(messageId) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        if (await Chat.countDocuments({ messageId }) === 1) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Timed out waiting for an authorized test message to persist");
}

async function main() {
    await connectDatabase();
    const clients = [];
    try {
        const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
        const users = [];
        for (const [letter, displayName] of [["a", "Phase C A"], ["b", "Phase C B"], ["c", "Phase C C"]]) {
            const user = await User.create({
                username: `pca_${suffix}${letter}`,
                displayName,
                passwordSalt: crypto.randomBytes(16).toString("hex"),
                passwordHash: crypto.randomBytes(64).toString("hex"),
            });
            users.push(user);
            createdUserIds.push(user._id);
        }
        const [alice, bob, outsider] = users;
        const privateRoom = await Group.create({ name: "", isPersonal: true, participants: [alice._id, bob._id], pairKey: `phase-c:${suffix}`, createdBy: alice._id });
        createdGroupIds.push(privateRoom._id);
        const publicRoom = await Group.create({ name: `Phase C public ${suffix}`, isPersonal: false, participants: [], createdBy: alice._id });
        createdGroupIds.push(publicRoom._id);

        const baseUrl = `http://127.0.0.1:${Number(process.env.PORT) || 3001}`;
        const cookieFor = (user) => `chat_session=${createToken(String(user._id), user.sessionVersion || 0)}`;
        const roomId = String(privateRoom._id);
        const allowedHistory = await fetch(`${baseUrl}/chat/${roomId}`, { headers: { Cookie: cookieFor(alice) } });
        assert.equal(allowedHistory.status, 200);
        const deniedHistory = await fetch(`${baseUrl}/chat/${roomId}`, { headers: { Cookie: cookieFor(outsider) } });
        assert.equal(deniedHistory.status, 403);
        const deniedJoin = await fetch(`${baseUrl}/join?roomid=${roomId}`, { headers: { Cookie: cookieFor(outsider) } });
        assert.equal(deniedJoin.status, 403);

        for (const user of users) {
            const socket = new PollingSocket(baseUrl, user);
            await socket.connect();
            clients.push(socket);
        }
        const [aliceSocket, bobSocket, outsiderSocket] = clients;
        assert.deepEqual(await aliceSocket.emitAck("join_room", { roomid: roomId }), { ok: true });
        assert.deepEqual(await bobSocket.emitAck("join_room", { roomid: roomId }), { ok: true });
        assert.deepEqual(await outsiderSocket.emitAck("join_room", { roomid: roomId }), {
            ok: false,
            error: "Not authorized to access this room",
        });
        assert.deepEqual(await outsiderSocket.emitAck("new_msg", { roomid: roomId, message: "must not send" }), {
            ok: false,
            error: "Not authorized to access this room",
        });
        assert.deepEqual(await outsiderSocket.emitAck("join_room", { roomid: String(publicRoom._id) }), { ok: true });

        for (const [socket, room, message] of [
            [aliceSocket, privateRoom, "private sender A"],
            [bobSocket, privateRoom, "private sender B"],
            [outsiderSocket, publicRoom, "public group sender"],
        ]) {
            const requestId = crypto.randomUUID();
            createdMessageIds.push(requestId);
            const acknowledgement = await socket.emitAck("new_msg", { roomid: String(room._id), message, requestId });
            assert.deepEqual(acknowledgement, { ok: true, requestId, queued: true });
            await socket.waitForEvent("message_status", (event) => event?.requestId === requestId && event.ok === true);
            await waitForMessage(requestId);
        }

        const logout = await fetch(`${baseUrl}/auth/logout`, {
            method: "POST",
            headers: {
                Cookie: cookieFor(alice),
                Origin: baseUrl,
                "Sec-Fetch-Site": "same-origin",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: "",
            redirect: "manual",
        });
        assert.equal(logout.status, 302);
        const staleSession = await fetch(`${baseUrl}/group`, { headers: { Cookie: cookieFor(alice) }, redirect: "manual" });
        assert.equal(staleSession.status, 302, "logout must invalidate the old session cookie");

        console.log(JSON.stringify({ event: "room_authorization_integration_passed", checks: [
            "authenticated HTTP history for participant and rejection for outsider",
            "authenticated HTTP join rejection for outsider",
            "two independent authenticated Socket.IO sessions join private room",
            "third Socket.IO session cannot join or send to private room",
            "both private participants send through Kafka and receive Redis-confirmed status",
            "public group participant sends through Kafka and receives Redis-confirmed status",
            "messages persist once in MongoDB",
            "logout invalidates the old session",
        ] }));
    } finally {
        for (const client of clients) await client.close();
        const messagesRemoved = createdMessageIds.length
            ? (await Chat.deleteMany({ messageId: { $in: createdMessageIds }, senderId: { $in: createdUserIds } })).deletedCount
            : 0;
        const groupsRemoved = createdGroupIds.length
            ? (await Group.deleteMany({ _id: { $in: createdGroupIds } })).deletedCount
            : 0;
        const usersRemoved = createdUserIds.length
            ? (await User.deleteMany({ _id: { $in: createdUserIds } })).deletedCount
            : 0;
        await mongoose.disconnect();
        console.log(JSON.stringify({ event: "room_authorization_test_cleanup", messagesRemoved, groupsRemoved, usersRemoved }));
    }
}

if (require.main === module) {
    main().then(() => process.stdout.write("", () => process.exit(0))).catch((error) => {
        console.error(JSON.stringify({ level: "error", event: "room_authorization_integration_failed", error: error.message }));
        process.stderr.write("", () => process.exit(1));
    });
}

module.exports = { main };
