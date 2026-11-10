# Interview preparation

> **Snapshot notice:** Several answers below describe the earlier state where Kafka was unused. Update your explanation to the current local design: Kafka producer → persistence worker → idempotent Mongo upsert → Redis Pub/Sub → Socket.IO. Root [DEMO_CHECKLIST.md](../DEMO_CHECKLIST.md) is current.

## 60-second project explanation

“This is a Node.js chat app with Express-rendered EJS pages and Socket.IO for real-time events. Users authenticate with an HMAC-signed, HttpOnly cookie; password hashes use scrypt and MongoDB session versions support logout invalidation. Groups and message history are stored in MongoDB. For a live message, the socket handler validates identity, room and rate, publishes through Redis Pub/Sub, then the subscriber writes to Mongo and broadcasts to local room sockets. Kafka producer/consumer code is present, but current startup and message code do not call it. Presence, Socket.IO rooms and rate limits are process-local, so the current implementation should not be presented as multi-instance ready.”

## Likely questions and accurate answers

### Why Redis?

Current code uses Redis Pub/Sub as transient room-channel fanout. It lets publishers and subscribers communicate through channel messages, but it is neither cache nor durable queue here. It does not replace Socket.IO's Redis adapter because room membership and broadcast state remain local.

### What does Kafka do?

In current source, nothing during app runtime. The module defines a producer to `Chats` and consumer that persists to Mongo, but neither is called by `index.js` or socket handlers. The historical audit describes a former Redis-to-Kafka-to-Mongo lifecycle. Be explicit about current versus historical state.

### When is a message considered saved?

The initial socket acknowledgement means Redis accepted the publish command. The later `message_status` is emitted after Mongo `Chat.create()` succeeds; browser clears matching input only after that status. It is not an exactly-once guarantee.

### How are accounts authenticated?

Registration validates fields, derives a scrypt hash with random salt, stores only salt/hash, and sets HMAC-signed token cookie. HTTP middleware and Socket.IO handshake load the account and compare token session version with Mongo. Logout increments version and disconnects sockets registered in this process.

### How does chat history work?

On `GET /chat/:roomid`, route validates group and fetches latest 500 Chat docs sorted by Mongo `_id` descending then reverses for rendering. There is no pagination or retention policy in source.

### Is this horizontally scalable?

Not safely as written. Redis Pub/Sub can deliver to multiple process subscribers, but each subscriber writes the same message; Socket.IO local rooms and presence maps do not synchronize; connection/rate-limit controls are local. Multi-instance support needs Socket.IO adapter, shared presence strategy, idempotent persistence and operational tests.

### What are the delivery guarantees?

No exactly-once guarantee. Redis Pub/Sub is transient. Mongo persistence follows publication and precedes broadcast within one subscriber callback, but an outage can lose the event. Duplicates can arise from multiple subscribers/retries. There is no message ID persisted for deduplication.

## Strengths

- Sender name comes from authenticated server-side socket state, not client payload.
- Room ID/group existence, message size and per-socket event rate are checked.
- Password hashes use salted scrypt; cookie is HttpOnly, SameSite Strict, and Secure in production.
- EJS escapes rendered data; live content uses DOM text APIs. CSP/security headers are configured.
- Mongo persistence precedes broadcast; UI reports a persistence result separately from Redis publish acknowledgement.
- Startup awaits critical Mongo/Redis dependencies and exposes liveness/readiness endpoints.

## Limitations worth owning

- Kafka integration is dormant; Redis Pub/Sub is not durable.
- In-memory presence, rooms, rate limits, connection counts and logout socket registry are single-process.
- No private group membership/authorization; any signed-in user can list/join all groups.
- No idempotency key, retry/dead-letter handling, ordering guarantee, pagination, message timestamps in schema, or moderation.
- Readiness checks connection state only; integration tests do not exercise real services.
- Legacy `group.ejs` / `join.ejs` and unused `ip` package indicate project drift; don't claim they power current flows.

## Improvement sequence (recommendations)

1. Decide whether this is a Redis + Mongo demo or Kafka-backed architecture and align code/docs.
2. Add stable message ID and unique persistence constraint/upsert; define bounded retry and dead-letter path if durable processing is required.
3. For multi-instance use, configure Socket.IO Redis adapter and shared presence/connection/rate-limit semantics; test fanout and duplicates.
4. Add group membership/ownership checks if private rooms are intended.
5. Add message timestamps/indexes and paginated history; avoid logging payloads.
6. Add integration tests against disposable Mongo/Redis/Kafka and failure/restart scenarios; measure queue lag and message outcomes.

## Evidence files

Core references: `index.js`, `sockets/socketHandlers.js`, `public/scripts/chat.js`, `security/auth.js`, `routes/authRoutes.js`, `routes/chatRoutes.js`, `models/*.js`, `redis/redisClient.js`, `kafka/kafka.js`, and `test/*.test.js`.
