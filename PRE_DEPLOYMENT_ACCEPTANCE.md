# Pre-deployment acceptance audit

> **Historical audit:** This document records the pre-local-functionality code and deployment review. The local application has since been changed to run Kafka through a separate worker and now includes direct conversations. Keep the hosted deployment recommendations as planning history; use [README.md](README.md) and [ARCHITECTURE.md](ARCHITECTURE.md) for current local behavior. No hosting was configured or approved by this work.

**Status: not accepted for deployment.** No provider was configured, no changes were pushed, and no charges were incurred. Local code checks pass, but this machine could not reach MongoDB and has no running Redis/Kafka services. The public application, real browser sessions, and durable persistence have therefore not been verified.

## A. Verified working features

- All project `.js` files pass `node --check` (run 2026-11-09).
- `npm test` passes **9/9 offline tests**: signed session token acceptance/tamper rejection, cookie parsing and flags, password hashing, cross-origin rejection, rate limiting, mocked two-socket room messaging/persistence, EJS escaping, external-script output, and compilation of every view.
- In the mocked Socket.IO handler test, two authenticated sockets join one existing room; a message arrives at the publisher, is written through the Chat model stub, and is broadcast. A client supplied fake sender is ignored in favor of the authenticated user's display name.
- Chat history and group-name markup are rendered with EJS escaping; live messages and presence names use text nodes in `public/scripts/chat.js`.
- The application now has account registration/sign-in, scrypt password hashes, signed expiring cookies, logout session invalidation, authenticated socket handshakes, message/room validation, same-origin write checks, basic rate limits, health routes, security headers, and graceful shutdown hooks. These are verified by code inspection and the offline tests, not by a running database-backed app.

## B. Broken or incomplete features

- **Local application startup is blocked.** `npm start` was run with the existing local environment. It exited before listening because Mongoose could not connect to the configured Atlas cluster; the returned error indicated the client IP is not allowed. No database URI or credential was printed.
- **Redis is unverified.** There is no local Redis listener. `docker ps` fails because Docker Desktop's Linux engine is not running. Startup connects to MongoDB first, so it never reached the Redis connection attempt.
- **Kafka is not part of the current runtime path.** The Kafka module remains in the tree, but `npm start` does not start a consumer and the Socket.IO handler does not call the producer. There was no broker to test.
- No HTTP listener came up. I could not verify `/`, `/auth`, `/group`, `/health/live`, `/health/ready`, browser login, or a real Socket.IO upgrade against the running server.
- The automated “two-client” test uses two fake socket objects and stubbed Redis/Mongo calls. It does **not** verify the Socket.IO network protocol, real Redis delivery, MongoDB persistence, two separate browsers, refresh, or reconnect.
- No private one-to-one/direct-message feature exists. The application implements shared group rooms only.
- Groups are public to every signed-in account: every account can list rooms, enter any existing room, create rooms, and post. There is no group owner, membership, role, or private-room authorization model.
- Redis Pub/Sub is transient. A Redis outage can lose a message after publish; a failed MongoDB write is reported to the sender, but there is no replay queue in this current code path.

## Review of every changed file

This review covers the production-preparation edits from the previous turn and the security/audit edits in this turn. “Backward compatible” refers to the app's prior anonymous local UI/protocol unless stated otherwise.

| File | Change and reason | Existing behavior impact | Backward compatibility |
| --- | --- | --- | --- |
| `config/server-config.js` | Centralizes `PORT`, `DB_URL`, `REDIS_URL`, allowed origins, and production `SESSION_SECRET`; fails fast when required production secrets are missing. | Stops printing `DB_URL`; production now needs a session secret. Local Redis defaults to localhost. | Config names for `DB_URL` remain. Production startup requires new `SESSION_SECRET`; local mode generates a temporary key if absent. |
| `config/db-config.js` | Uses centralized URI and a bounded Mongo server-selection timeout. | Removes the old secret-bearing URI log; startup reports a generic connection failure. | Same `connect()` export; Mongo availability still required. |
| `index.js` | Uses `PORT`, binds `0.0.0.0`, adds health/security headers, CORS/origin checks, account middleware, graceful shutdown, and service readiness. | Root redirects to groups; all app pages now require sign-in. Kafka consumer is no longer started here. | Deliberately incompatible with anonymous UI access. `/health/live` and `/health/ready` are new. The Kafka lifecycle regression is detailed in section D. |
| `redis/redisClient.js` | Creates publisher/subscriber from `REDIS_URL` with explicit connect and structured errors. | Supports TLS/managed Redis URLs; needs Redis at startup. | Default remains local Redis if `REDIS_URL` is absent. |
| `sockets/socketHandlers.js` | Validates authenticated users, room IDs/existence, message strings/length, event rate, and sender identity; adds per-account socket limit, persistence status, and presence cleanup. Current persistence is direct `Chat.create()` after Redis Pub/Sub. | Old `join_room` and `new_msg` names remain, but anonymous clients cannot connect and client-supplied sender is ignored. Kafka producer call is bypassed. | Event names are mostly compatible; authentication and the sender source intentionally break old anonymous clients. Kafka semantics are not compatible with the previous lifecycle. |
| `routes/chatRoutes.js` | Requires valid existing ObjectId rooms, uses authenticated display name, handles errors, and loads the latest 500 messages in chronological order. | Anonymous `?user=` identity is ignored; legacy `?user=` is no longer an identity mechanism. | Auth requirement is a breaking behavior change. Route path remains. |
| `routes/groupRoutes.js` | Limits group listing, validates names, handles failures, and adds same-origin/IP rate protection for writes. | Group operations require authentication; name maximum is 100 characters. | Form routes remain, but anonymous calls are rejected. |
| `routes/joinRoutes.js` | Checks that the room exists and redirects to its chat URL; catches database errors. | The old username-entry step is removed because identity comes from sign-in. | Existing `/join?roomid=...` link still works when authenticated; the rendered join flow changed. |
| `routes/authRoutes.js` | Adds registration, login, logout, generic login errors, and IP limits. | New account flow. Logout revokes sessions and disconnects active sockets. | New routes; no old route compatibility required. |
| `models/user.js` | Adds normalized unique usernames, display names, password salt/hash, and session version. | New MongoDB collection/index requirement. | Additive schema change; no prior user model existed. |
| `security/auth.js` | Adds scrypt hashing, signed expiring cookies, cookie parsing, session version checks, auth middleware, and same-origin write checks. | Protected views now resolve identity from the signed cookie. | New requirement for app requests; existing anonymous clients are incompatible. |
| `security/rateLimit.js` | Adds bounded in-memory fixed-window limits. | Auth/group writes and Socket messages can receive 429/denials. | New restriction; limits reset on restart and do not coordinate across instances. |
| `security/socketRegistry.js` | Tracks active sockets so logout closes that user's sockets. | Logout now terminates active realtime connections. | Additive; process-local and single-instance only. |
| `views/auth.ejs` | Adds sign-in and account creation forms. | New `/auth` UI. | Additive. |
| `views/home.ejs` | Shows signed-in user/logout; group creation length limit; removes inline style. | Group page now assumes an authenticated account. | Breaking for anonymous use. Existing group list/create remains. |
| `views/index.ejs` | Uses escaped data attributes, escaped server-rendered history, and an external chat script. | Adds save/connection status UI; message input max length. | View requires authenticated route data. Server event names remain. |
| `public/scripts/chat.js` | Handles authenticated socket connection, room rejoin after reconnect, message acknowledgements, and text-node rendering. | Sender is no longer submitted by the browser; reconnect now re-joins the room. | Requires the new session flow and server acknowledgements. |
| `public/styles/homepage.css` | Adds a CSS class for the formerly inline group-join form style so CSP can disallow inline styles. | Presentation-only. | Compatible visually; no behavior change. |
| `.env.example` | Documents `DB_URL`, `REDIS_URL`, `SESSION_SECRET`, origin, port, and restores non-secret `HOST_IP` for the existing Kafka Compose listener. | The earlier prep had removed `HOST_IP`; it has now been restored to avoid breaking local Kafka Compose. Example values contain no DB credential. | Existing `DB_URL`/`HOST_IP` names retained; new Redis/session values added. |
| `.gitignore` | Ignores `.env*` except `.env.example`. | Prevents new local environment variants being added. | Does not untrack an already committed `.env`. |
| `package.json` | Adds `start` and `test` scripts. No dependency was added. | `npm start` is now the production-style entry point; `npm test` runs Node's built-in test runner. | Existing `npm run dev` remains. `package-lock.json` was not changed. |
| `test/auth.test.js` | Tests token tampering, cookies, hashing, origin guard, and parsing. | Test-only. | Additive. |
| `test/rateLimit.test.js` | Tests configured rate allowance and 429 response. | Test-only. | Additive. |
| `test/socketHandlers.test.js` | Uses fake sockets/Redis/Chat model to exercise two-client message publish, persistence, broadcast, and server-derived sender. | Test-only; does not prove real service interoperability. | Additive. |
| `test/views.test.js` | Verifies chat XSS escaping and compiles all EJS templates. | Test-only. | Additive. |
| `README.md` | Removes outdated pause/resume claim and notes current Kafka bypass and single-instance limitation. | Documentation now reflects the current code. | Documentation-only. |
| `DEPLOYMENT.md` | Recasts deployment as unapproved, documents original vs demo profile, secrets, and repository blocker. | No runtime effect; previous single-path Kafka omission recommendation is replaced by an explicit architecture choice. | Documentation-only. |

`kafka/kafka.js`, `docker-compose.yml`, `.env`, `package-lock.json`, and `routes/index.js` were not modified during this audit. The Kafka module remains present but is currently unused by the app entry point/socket handler.

## C. Security audit and remaining issues

### Implemented in this audit

- Accounts use a unique normalized username, 12–128 character password requirement, per-account random salt, and Node `scrypt` password hashing. Password hashes/salts are excluded from ordinary Mongoose selections.
- A signed HMAC cookie expires after 24 hours, is `HttpOnly`, `SameSite=Strict`, and `Secure` in production. Production requires a `SESSION_SECRET` of at least 32 characters. Logout increments a stored session version and disconnects that user's active sockets.
- Chat and group routes require an authenticated user. Socket handshakes verify the same signed cookie and allowed origin. The server takes sender identity from the account, not from client message data.
- Room IDs are validated and must refer to existing groups. Message payloads must contain a non-empty string of at most 2,000 characters. The client ignores HTML in message content and renders it as text.
- Login/registration are limited to 10 requests per IP per 15 minutes; room creation is limited to 20 per IP per hour; each socket is limited to 8 messages per 10 seconds and 4 concurrent sockets per account. These limits are in-process only.
- Cookie-authenticated write routes check `Origin` and Fetch Metadata. Socket.IO CORS and an explicit socket origin check use configured origins plus Render's service URL. Production responses add HSTS and other headers; the CSP no longer permits inline scripts.
- Secrets come from environment variables. `.env*` is ignored in the backup folder while `.env.example` remains tracked-safe. This **does not remove an already tracked secret** from the sibling Git repository (see section G).

### Still needed before a public deployment

- Rotate the database credential found in the tracked `.env` described in section G. Treat it as exposed if that commit was ever pushed.
- Registration is open and has no email verification, CAPTCHA, recovery flow, or durable account-abuse controls. The rate limit is per process/IP and can be bypassed across instances or IPs.
- There is no private group membership or authorization; all authenticated accounts share all rooms. Do not use for confidential conversations.
- There is no distributed rate limiter, audit trail, moderation, account lockout policy, or message retention policy. `SESSION_SECRET` rotation invalidates all sessions, but there is no operator-facing revocation/management UI.
- The security policy is configured in the app, but it has not been inspected in an actual hosted browser. Hosted HTTPS and secure-cookie behavior remain unverified.

## D. Kafka and Redis architecture

### Original message lifecycle

The original entry point called `consumeMessage()` after connecting to MongoDB. The Socket.IO `new_msg` handler published the message to Redis channel `room:<roomid>`. The process's Redis `message` listener broadcast the message to its local Socket.IO room and called Kafka's `produceMessage()`. The Kafka producer lazily connected to `localhost:9092` and published JSON on topic `Chats`. The Kafka consumer used group ID `default`, subscribed from the beginning when no committed offset existed, and called `Chat.create()` for each record. The consumer logs raw message values, which could expose chat content in logs if Kafka wiring is re-enabled; remove/redact payload logging before a public deployment.

So Kafka **was in the original lifecycle**: it was the persistence queue between live delivery and MongoDB. The Redis Pub/Sub layer delivered transient live events and the Kafka consumer was the persistence writer. The code did not use the Socket.IO Redis adapter; presence and Socket.IO rooms were held in local process memory.

### Current lifecycle after production preparation

The Kafka source module and dependencies are still present, but Kafka has been **bypassed at the call sites**. `index.js` no longer imports/starts the consumer. The Redis `message` listener in `sockets/socketHandlers.js` now writes directly with `Chat.create()` and then broadcasts. No producer call is made. This changes runtime behavior without deleting the Kafka functions.

### Direct MongoDB tradeoff

Direct persistence was selected in the previous preparation to avoid requiring a long-running Kafka consumer for a small demo. It reduces the number of deployment services, and the current UI reports whether the MongoDB write succeeded. It is not equivalent to the original design: Redis Pub/Sub has no durable backlog/replay, and if multiple app instances subscribe to the same room channel each instance will write a duplicate MongoDB record. It also removes Kafka buffering, replay, independent consumer scaling, and queue-based decoupling. A publish acknowledgement can precede the eventual database result; the UI now waits for a separate persistence status event before clearing the input.

### Recommendation

For this portfolio project, preserve and finish the **original scalable profile** rather than silently making direct MongoDB the final architecture: Socket.IO web service, official Socket.IO Redis adapter for cross-instance room delivery, Kafka producer, a continuously running Kafka consumer worker, and MongoDB. Add stable message IDs/idempotent writes, retry/dead-letter behavior, and observable worker health. The official Socket.IO adapter is designed to forward room broadcasts between servers; the current custom Redis subscriber is not a substitute for the adapter ([Socket.IO Redis adapter](https://socket.io/docs/v4/redis-adapter/)).

A direct-MongoDB profile can be a deliberate demo-only alternative, but only as a single instance and with its loss/duplication limits clearly disclosed. Do not deploy either profile until the chosen message path passes live persistence, two-client, and reconnect checks.

## E. Automated test results

Command: `npm test` — **9 passed, 0 failed**.

The tests are offline unit/component checks. MongoDB, Redis, Kafka, HTTP startup, and browser networking are not mocked as a complete system. `node --check` passed for the JavaScript source. One initial syntax-check command accidentally included `.ejs` files and reported Node's unsupported `.ejs` extension; EJS is rendered by the passing template test instead. No `npm audit`, provider health check, deployment, or live service test was performed.

## F. Manual tests to perform once local dependencies are available

1. Start Docker Desktop and wait for its engine. Configure a MongoDB URI accessible from this machine and start local Redis/Kafka with `docker compose up -d`; ensure `.env` includes `NODE_ENV=development`, `DB_URL`, `REDIS_URL`, `HOST_IP=127.0.0.1`, and a local `SESSION_SECRET` (at least 32 characters). The checked-in `.env.example` includes the non-secret `HOST_IP` required by the current Kafka compose file.
2. Run `npm start`. Confirm the server reports listening; open `/health/live` (200) and `/health/ready` (200). Open `/` and confirm the sign-in/create-account page loads.
3. In two independent browser profiles, create two accounts. As the first user, create a group. As the second, join the same group. Send messages both ways; confirm sender identity cannot be spoofed and messages appear in both clients.
4. Refresh both pages and confirm messages remain in MongoDB. Send an HTML payload such as `<img src=x onerror=alert(1)>`; it must appear as text without executing. Try an anonymous `/chat/<room-id>` request and confirm it redirects to sign-in.
5. Disconnect one browser's network briefly and restore it. Confirm Socket.IO reconnects, the client rejoins its room, and a new message persists. Check the UI's save/error status.
6. Sign out while a second tab for that account is connected. Confirm the live socket disconnects and the old cookie no longer opens protected routes.
7. **Kafka profile only:** after Kafka wiring is restored by an approved architecture change, verify one message creates exactly one Kafka record and exactly one Mongo document, restart the worker and check offset recovery, simulate MongoDB failure and confirm bounded retry/recovery, and inspect dead-letter/error behavior. The current code cannot pass this check because Kafka is bypassed.

## G. Repository and deployment blockers

- The current source folder is `Scalable-Chat-App-backup` and has no `.git` metadata. The newer app edits are present in this folder, but they are not preserved in a commit.
- A sibling `Scalable-Chat-App` folder has a `.git` directory, branch `clean-main`, commit `30dab8d` dated 2026-10-25, and an `origin` URL pointing at `https://github.com/bhupinder-14/Scalable-Chat-App.git`. The local commit tree contains `.env` and `node_modules` but no application source. `git status` fails with “must be run in a work tree”; the working tree is not usable as a normal checked-out project. The actual remote's current contents were not queried.
- **Credential exposure:** `.env` is tracked in that local Git commit. Its blob hash equals the current sibling `.env` file's hash. The file contains a set `DB_URL` value (not shown here). If this commit has ever been pushed, rotate the MongoDB password/credential immediately and replace it in local secret storage. Do not push from either folder. Removing `.env` from the latest tree alone does not remove it from Git history.
- Safe recovery sequence: rotate the database credential; inspect GitHub's actual branch/history and access settings; create a clean working clone/staging copy; copy only reviewed source files (never `.env` or `node_modules`); remove the committed secret and oversized dependency tree from history using an approved history-rewrite plan; run secret scanning and `git status`; then review a diff before any push. No push or history rewrite was done.
- Local startup is blocked on MongoDB Atlas IP/network access. Docker's Linux engine is unavailable, so Redis and Kafka cannot be run locally. Real HTTP, browser, persistence, reconnection, and Kafka checks are blockers.
- The chosen production architecture and paid service approval are still pending. No deployment or charges occurred.

## H. Final recommended deployment architecture

Use one public Node.js/Express/EJS/Socket.IO service on persistent compute, managed MongoDB, managed Redis with the official Socket.IO adapter, and a continuously running Kafka consumer worker connected to managed Kafka. For the interview demo, start with one web instance and one worker, then scale the web service only after adapter-based cross-instance tests pass. Keep the frontend served from Express. Use provider TLS, provider-managed secret variables (`DB_URL`, `REDIS_URL`, Kafka SASL/TLS settings, and `SESSION_SECRET`), exact CORS origins, health checks, and captured logs.

Render's smallest always-on web service was listed at $7/month during the earlier provider review; a separate worker and managed Kafka add cost and current pricing must be checked before approval. MongoDB Atlas/Upstash free tiers may suit a non-critical demo but do not provide a production availability commitment. No total estimate is approved because the Kafka service/worker shape is not yet chosen.

This is a recommendation only. The working copy currently bypasses Kafka, the Git repository needs repair and secret rotation, and the application has not passed a live functional acceptance run. **Do not call this project production-ready or expose it publicly yet.**
