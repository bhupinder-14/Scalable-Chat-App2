# Database and Redis

> **Snapshot notice:** The details below predate stable message IDs and the active Kafka worker. See root [ARCHITECTURE.md](../ARCHITECTURE.md) and source `kafka/messagePipeline.js` for the current persistence/fanout sequence.

## MongoDB/Mongoose

Connection is `connectDatabase()` in `config/db-config.js`; it calls `mongoose.connect(dbUrl, {serverSelectionTimeoutMS:10000})`. `index.js` awaits it before listening. DB URL is required by `config/server-config.js`.

### Collections/models

- **User** (`models/user.js`): unique username, normalized lowercase and trimmed; display name; password hash/salt excluded from normal selections; session version; timestamps. Password fields are selected explicitly only during login. Auth tokens carry session version; logout increments the persisted version to invalidate old tokens.
- **Group** (`models/group.js`): name and `isPersonal` default false. No owner or member list, indexes/validation beyond Mongoose defaults, or privacy enforcement.
- **Chat** (`models/chat.js`): content, sender string, room ObjectId. No timestamps, foreign-key constraint, sender user ID, request ID, or declared index. Chat history queries by room ID and sorts `_id`.

Mongo reads happen for session lookup, login, group list/creation, room existence, and history. Current message persistence is `Chat.create()` inside Redis subscriber callback. Dormant Kafka consumer also calls `Chat.create()` if explicitly run.

## Redis

`redis/redisClient.js` creates distinct ioredis publisher and subscriber connections with lazy connect and max three retries per request. Startup explicitly connects both and fails startup if either connect fails. Client `error` events are logged.

The socket layer uses channel `room:<ObjectId>`:

- `pub.publish()` sends serialized message payload.
- Each process's `sub.on("message")` validates, writes to Mongo and broadcasts to local Socket.IO room.
- A local room subscription is set up when the first locally connected socket joins and removed when last local user leaves.

Redis is used for transient message pub/sub. No Redis data cache, key-value session storage, durable stream, presence key, distributed rate counter, or Socket.IO adapter is configured.

## Guarantees and limits

Redis publish returns a subscriber count, not proof of a successful DB write or Socket.IO delivery. Pub/Sub has no retained backlog/replay. Mongo write occurs after publication and is awaited before broadcast. Failure is logged and may return a negative status to the originating socket; no retry queue or dead-letter store exists. There is no database idempotency key, so duplicate publications can persist duplicates.

With multiple app processes, each process may subscribe to a room channel and persist the same publication. This is an inferred consequence of each process running the same callback; no multi-instance test exists. Presence and Socket.IO rooms are process-local. `/health/ready` only checks connection readiness, not write capability/latency.

## Recommendations (not implemented)

Add explicit message IDs with a unique Mongo index and idempotent upsert; use a durable queue/stream if messages must survive subscriber downtime; define indexes for history lookups; add shared presence and Socket.IO adapter strategy before multiple web instances; define retention and privacy rules; expose dependency health/queue lag without leaking credentials.
