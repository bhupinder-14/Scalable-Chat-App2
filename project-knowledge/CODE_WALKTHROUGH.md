# Code walkthrough

> **Snapshot notice:** This walkthrough predates the separate Kafka worker and direct conversations. Current flow entry points are `worker.js`, `kafka/messagePipeline.js`, `sockets/socketHandlers.js`, and `security/roomAccess.js`; see root [README.md](../README.md).

## Startup and request pipeline

`config/server-config.js` loads dotenv once, validates `DB_URL`, chooses a development-generated or configured session secret, enforces production secret length, and exports port/Redis/origins. `index.js` creates Express + HTTP + Socket.IO, adds parsers/security headers/static middleware and routes. `start()` connects Mongo then Redis, then listens. Startup errors exit. SIGINT/SIGTERM call `shutdown()`, which closes Socket.IO and settles Redis/Mongoose disconnects with a 10-second process timeout. Kafka has no lifecycle hook.

The Express request pipeline applies body parsers and headers, static serving, health/root routes, then `loadUser`; auth endpoints follow, then protected `/group`, `/chat`, `/join`, and final generic error middleware. `loadUser()` parses the cookie and queries User each request. `requireAuth()` redirects HTML clients to `/auth` or returns 401 for non-HTML.

## Authentication functions

- `parseCookies(header)`: splits cookie pairs and preserves `=` inside values.
- `signature(payload)` / `createToken(userId,version)`: HMAC-SHA256 signed base64url payload containing subject, version and expiry.
- `decodeToken(token)`: size/format/signature/claim/expiry validation; timing-safe signature comparison; returns claims or null.
- `userFromCookieHeader(header)`: decode cookie, query User by ID, compare session version, return restricted user fields or null.
- `hashPassword` / `verifyPassword`: Node `scrypt` with random salt and 64-byte hash; comparison timing-safe.
- `sameOrigin`: rejects mismatched Origin or `Sec-Fetch-Site: cross-site`; it allows requests without either signal.
- Auth routes validate input, rate-limit by request IP, create token cookie, and on logout increment session version then disconnect registered local sockets.

## Routing

`groupRoutes` fetches 200 groups sorted newest first and renders `home`; create accepts a trimmed name capped at 100. `joinRoutes` validates a hex ObjectId and existence then redirects. `chatRoutes` validates group, fetches latest 500 messages, reverses them and renders `index`. `group.ejs` and `join.ejs` appear to be leftovers: current routes do not render them.

## Socket handler structures

`onlineUsers: Map<roomid, Map<userId,{name,sockets:Set<socketId>}>>` tracks process-local room presence. `connectionCounts: Map<userId,count>` limits connections to four per process. `socketRegistry` maps account ID to socket object sets for logout. Each new socket gets `{started,count}` message rate window.

`removeFromRoom(io,socket)` removes socket from presence, emits `user_left` when final socket for that user leaves and updates names, unsubscribes Redis when room's local map empties. `join_room` validates room and existence, leaves previous room, joins current, records presence, subscribes and acknowledges. `new_msg` validates throttle/room/content, assigns correlation ID, publishes. `sub.on("message")` validates serialized payload, persists, emits room message and sender status. Disconnect unregisters and decrements counts.

## Browser behavior

`public/scripts/chat.js` extracts room and display name from EJS data attributes, connects Socket.IO, requests `join_room` on connect, disables sending during disconnect, and handles ack/status. Messages and user names are inserted via DOM text APIs. There is no client-side history pagination, retry queue or duplicate suppression. Enter sends; multiple rapid sends can be pending simultaneously.

## Data model caveats

`models/group.js` calls the Mongoose model variable `Chat`, which is only a local naming mismatch. Group and chat schemas have no explicit collection constraints or cross-reference enforcement. Chat sender is a display name, so historical messages do not have stable sender-account identity.

## Failure handling by function

Routes catch expected database errors and return generic messages. `loadUser` forwards DB error. `start()` exits on dependency connection failure. Redis client errors log; socket publish and message persistence catch and signal failure. Some async socket lifecycle handlers (for example `removeFromRoom` called during disconnect) have no outer catch around the event callback, so an unsubscribe failure is caught internally, but unexpected failures may reach process `unhandledRejection` handler, which initiates shutdown. Kafka functions do not add local retry/error policy.
