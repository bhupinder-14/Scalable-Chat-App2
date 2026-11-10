# HTTP API and Socket.IO events

> **Snapshot notice:** This reference predates the direct-message endpoint and Kafka-backed local lifecycle. The root [README.md](../README.md) is authoritative for current user flows; socket names remain mostly stable.

All application routes are mounted in `index.js`. Group/chat/join paths require a valid session. Express body parsers cap JSON and URL-encoded bodies at 32 KB. Forms render EJS or redirect.

## HTTP routes

| Method/path | Auth | Behavior |
|---|---|---|
| `GET /` | No | Redirects to `/group`, which redirects unauthenticated users to `/auth`. |
| `GET /health/live` | No | Always returns JSON status `ok`. |
| `GET /health/ready` | No | Returns 200 if Mongo and both Redis clients report ready; otherwise 503. |
| `GET /auth` | No | Shows sign-in/register or redirects signed-in user to `/group`. |
| `POST /auth/register` | No, same-origin + limiter | Validates username/display name/password, hashes with scrypt, creates User, sets signed cookie and redirects. Duplicate username => 409. |
| `POST /auth/login` | No, same-origin + limiter | Finds normalized username, verifies scrypt hash, sets cookie. Invalid credentials => 401. |
| `POST /auth/logout` | Yes, same-origin | Increments DB session version, disconnects this process's registered sockets and clears cookie. |
| `GET /group` | Yes | Lists up to 200 newest groups and renders `home.ejs`. |
| `POST /group` | Yes, same-origin + limiter | Trims/truncates name to 100 chars, creates group and redirects. |
| `GET /join?roomid=...` | Yes | Validates 24-hex ObjectId and existence, redirects to `/chat/:id`. |
| `GET /chat/:roomid` | Yes | Validates group, loads up to 500 messages, renders chat. |

`group.ejs` and `join.ejs` exist but are not rendered by current routes. Current join is group selection followed by redirect, not username prompt. Errors use route-specific generic status/text; a final middleware catches forwarded Express errors.

## Socket handshake

Socket.IO is attached to the same HTTP server. CORS allows configured origins and `RENDER_EXTERNAL_URL`; absent origin is permitted. In non-production, empty allowed-origin set permits origins. An additional `io.use` checks origin and calls `userFromCookieHeader` using the handshake cookie; missing/invalid session rejects connection. It loads Mongo user fields and validates the cookie's session version.

## Client/server event reference

| Event | Direction | Payload / ack | Behavior |
|---|---|---|---|
| `connection` | Server lifecycle | Authenticated `socket` | Enforces max four active connections per user per process, registers socket, initializes message rate window. |
| `join_room` | Client → server | `{roomid}`; ack `{ok, error?}` | Validates ObjectId and group existence; moves socket from prior room; joins; records process-local presence; subscribes this process to Redis channel; broadcasts online names. |
| `new_msg` | Client → server | `{roomid,message,requestId}`; immediate ack | Rate-limits, requires socket room match and valid message; server supplies sender identity; publishes Redis payload. |
| `msg_rcvd` | Server → room | `{roomid,sender,message}` | Emitted after Mongo write by local Redis subscriber; client appends safe DOM nodes. |
| `message_status` | Server → sender socket | `{requestId,ok}` | Sent only by subscriber after persistence success/failure when correlation data exists. |
| `update_online_users` | Server → local room | Array of display-name strings | Broadcast from process-local `onlineUsers` map on join/leave. |
| `user_left` | Server → local room | Display name | Emitted when a user's last socket leaves this process's room. Browser currently does not listen for it. |
| `server_error` | Server → socket | Text | Used when connection cap exceeded. Browser presents the message. |
| `disconnect` | Socket lifecycle | N/A | Unregisters socket, removes presence, unsubscribes if room has no local users, decrements process-local connection count. |

## Rate and input constraints

HTTP auth: 10 attempts per IP in 15 minutes. Group creation: 20 requests per IP per hour. Socket messages: 8 attempts per socket per 10 seconds. Limits are process-local. Display name max 32, username 3–32 lowercase alphanumeric/underscore, password 12–128 chars, group name 1–100 chars, message 1–2,000 chars after trim. Session max age is 24 hours.
