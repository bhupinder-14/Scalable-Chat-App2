# Project overview

> **Snapshot notice:** This guide was written before the local Kafka worker and direct-message implementation. The current authoritative setup and architecture are in the repository root [README.md](../README.md), [ARCHITECTURE.md](../ARCHITECTURE.md), and [DEMO_CHECKLIST.md](../DEMO_CHECKLIST.md). In particular, Kafka is now active in the local Compose message path.

## Scope and evidence

This guide describes the checked-in application source. Runtime claims are based on `index.js`, routes, socket handlers, models, and the browser script. Tests are source evidence only; no test or live-service run was performed for this understanding exercise. `.env` values are intentionally omitted.

## What the application does

An authenticated user registers or signs in, views a list of the newest 200 groups, creates a public group, and opens a room. A browser Socket.IO connection joins the room, exchanges messages in real time, and receives a process-local online-user list. The chat page loads at most 500 prior messages from MongoDB. User accounts and messages/groups are modeled in MongoDB using Mongoose.

## Current runtime summary

- Node.js starts Express and wraps it in a Node HTTP server. Socket.IO attaches to that same server (`index.js`).
- Express renders EJS pages and serves static files under `public/`.
- MongoDB is connected before the HTTP listener starts (`config/db-config.js`, `index.js`).
- Two ioredis clients are connected at startup. Socket handlers publish a message to Redis Pub/Sub; the same application process subscribes to room channels, saves the message to MongoDB, then broadcasts it to its local Socket.IO room (`redis/redisClient.js`, `sockets/socketHandlers.js`).
- Kafka producer/consumer functions exist in `kafka/kafka.js`, but current `index.js` and `sockets/socketHandlers.js` do not import or call them. Kafka is not in the current runtime path.
- Authentication is a signed stateless cookie whose session version is checked against the User document. Socket handshake authentication uses that same cookie (`security/auth.js`, `index.js`).

## Important boundaries

“Scalable” is the product name, not evidence of multi-instance correctness. Socket.IO rooms, online presence, rate-limit buckets, connection limits, and socket registry are in-process Maps/Sets. Redis Pub/Sub can fan a message to each application process subscribing to a room, but each process then calls `Chat.create`; multiple instances therefore risk duplicate persistence and their local Socket.IO rooms do not automatically share membership. No Socket.IO Redis adapter is configured.

Groups are public to every authenticated account; there is no group membership/authorization model. “Join” routes validate a group exists, but do not record membership. A disconnected user receives no queued/offline delivery; message history is loaded on a later page request.

## Configuration variable names

Names referenced by the application/config and deployment files: `NODE_ENV`, `PORT`, `DB_URL`, `REDIS_URL`, `SESSION_SECRET`, `ALLOWED_ORIGINS`, `RENDER_EXTERNAL_URL`, and `HOST_IP`. Docker Compose also defines Kafka/ZooKeeper container configuration inline. No values are reproduced here. The Kafka code currently hard-codes broker `localhost:9092`.

## Source map

See [FOLDER_STRUCTURE.md](FOLDER_STRUCTURE.md) for every tracked project file, [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) for component boundaries, and [MESSAGE_LIFECYCLE.md](MESSAGE_LIFECYCLE.md) for the central execution trace.

## Reading conventions

- **Verified:** directly visible in current source or tests.
- **Inference:** likely operational consequence of verified code, not directly demonstrated by an integration run.
- **Missing:** capability not implemented in the inspected code.
- **Recommendation:** possible future engineering work, not a claim about current behavior.
