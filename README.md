# Scalable Chat Application

A local-first chat application built with Node.js, Express, Socket.IO, MongoDB, Redis Pub/Sub, and Kafka. Docker Compose starts the full stack, including a separate Kafka persistence worker. Deployment planning remains available in [DEPLOYMENT.md](DEPLOYMENT.md) and [PRE_DEPLOYMENT_ACCEPTANCE.md](PRE_DEPLOYMENT_ACCEPTANCE.md).

## Prerequisites

- Docker Desktop with the Linux container engine and Docker Compose v2.
- A modern browser for the two-session demo.
- Node.js 20+ and npm only if running automated tests on the host.
- At least 4 GB available memory for the local services.

No paid hosting, cloud account, or GitHub access is needed.

## Start locally

From the repository folder in PowerShell, create the local-only environment file from its template. This does not read or change `.env`, which is kept for the existing Atlas configuration:

```powershell
node -e "const fs=require('node:fs');const crypto=require('node:crypto');if(!fs.existsSync('.env.local')){const template=fs.readFileSync('.env.local.example','utf8');fs.writeFileSync('.env.local',template.replace(/^SESSION_SECRET=.*$/m,'SESSION_SECRET='+crypto.randomBytes(48).toString('base64url')),{flag:'wx'})}"
```

Then start the local services:

```powershell
docker compose --env-file .env.local up --build -d
docker compose ps
```

Wait for `mongo`, `redis`, `kafka`, and `web` to report healthy. The `worker` should remain running. Open [http://localhost:3001](http://localhost:3001), create two accounts, and sign in from two independent browser sessions. The first startup downloads images and builds the Node image.

Follow logs:

```powershell
docker compose logs -f web worker
```

Stop while preserving MongoDB data:

```powershell
docker compose down
```

`docker compose down -v` deletes the local database volume and all account/message data.

## Features

- Registration and sign-in with scrypt password hashes and signed, HttpOnly session cookies.
- Public group creation and group chat.
- One-to-one conversations between registered users, restricted to the two participants.
- Socket.IO live messages and online-member display.
- Kafka-backed message acceptance and persistence by a separate worker.
- MongoDB message history with stable IDs and duplicate-write protection.
- Redis Pub/Sub fanout from the persistence worker to connected app instances.
- `/health/live` and `/health/ready` web health endpoints, plus worker `/health/live` and `/health/ready` on the Docker-only network at port 3002.

## Architecture and message flow

The browser connects to Express/Socket.IO. After identity, room access and input checks, the server writes the message to Kafka. A worker consumes the record, persists it idempotently to MongoDB, then publishes it to a Redis room channel. Web processes subscribed to that channel broadcast to their local Socket.IO room. The browser reports “Message saved” after the persistence worker's Redis event returns the status.

### Worker recovery and delivery guarantees

The worker retries transient MongoDB and Redis failures with three short attempts per retry cycle, followed by capped exponential backoff (up to 30 seconds). It continues heartbeating Kafka while retrying, so the current Kafka message is not resolved or committed until MongoDB persistence and Redis publication both succeed. KafkaJS handles retriable broker errors with bounded retries and delayed consumer restarts; the worker health endpoint reports `recovering`/not-ready until the consumer rejoins. The Compose health check uses that readiness result.

Processing is **at least once**, not exactly once. MongoDB upserts by unique `messageId` and uses insert-only fields, so replay does not replace original content or timestamps. Redis publication can be repeated if delivery succeeds but the worker loses the acknowledgement; browser clients suppress duplicate display using the message ID. Malformed or other permanent records are left unresolved and stop the consumer instead of being acknowledged. There is no dead-letter queue: the partition can remain blocked until an operator investigates and corrects or otherwise handles the record. This avoids silent discard but currently requires manual intervention for poison records.

Check worker readiness without exposing port 3002 on the host:

```powershell
docker compose exec worker node -e "fetch('http://127.0.0.1:3002/health/ready').then(async r=>{console.log(r.status);console.log(await r.text())})"
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for a diagram and [DEMO_CHECKLIST.md](DEMO_CHECKLIST.md) for the recruiter walkthrough.

## Automated tests

With Node.js and npm installed:

```powershell
npm ci
npm test
```

Tests cover authentication helpers, rate limiting, EJS escaping/rendering, socket message validation/routing, participant access, and the Kafka-to-Mongo/Redis worker boundary. External services are mocked in unit tests; the Compose demo exercises real services. Docker is not needed for `npm test`.

Worker tests also cover transient dependency retry/backoff, MongoDB and Redis error classification, Kafka broker disconnection classification, consumer crash/stop detection, non-transient failure handling, and readiness reporting. These are mocked/unit tests; they do not replace the real-service smoke test or the separately run fault-injection checks.

After the local Compose stack is healthy, the private-room authorization integration check can be run with:

```powershell
docker compose --env-file .env.local exec web node scripts/room-authorization-integration.js
```

It creates temporary test users, rooms, and three uniquely identified chat records; tests authorized/unauthorized HTTP requests and independent authenticated Socket.IO polling sessions; and verifies Kafka→MongoDB→Redis status delivery. It removes only its exact test users, rooms, and chat records. Kafka retains the three test events under its normal topic retention policy; the script does not reset offsets or delete Kafka data.

After the Compose stack is healthy, run the real-service smoke test:

```powershell
docker compose exec web npm run test:local
```

It sends a unique record through the Kafka broker, waits for the worker's Redis Pub/Sub event, verifies one matching MongoDB document, and removes that smoke-test document. The real-service smoke test is separate from `npm test` and requires all Compose services, including the worker, to be running.

## Verify local services

```powershell
Invoke-RestMethod http://localhost:3001/health/ready
docker compose ps
```

Inspect Kafka records after sending a message:

```powershell
docker compose exec kafka kafka-console-consumer --bootstrap-server kafka:29092 --topic Chats --from-beginning --max-messages 1
```

Inspect MongoDB message metadata:

```powershell
docker compose exec mongo mongosh scalable_chat --quiet --eval "db.chats.find({}, {messageId:1, roomid:1, sender:1, content:1, createdAt:1}).sort({_id:-1}).limit(5).forEach(printjson)"
```

See active Redis room subscriptions with a chat page open:

```powershell
docker compose exec redis redis-cli PUBSUB CHANNELS "room:*"
```

For a local-only view of Redis Pub/Sub traffic, run `docker compose exec redis redis-cli MONITOR` in another terminal and send a message. This prints payloads; do not share that output publicly.

Expect `message_enqueued` in web logs and `message_persisted` in worker logs. Kafka records demonstrate broker acceptance; MongoDB documents demonstrate persistence; Redis monitoring demonstrates channel publication.

## Troubleshooting

- **Docker command missing:** install/start Docker Desktop with its Linux container engine, then reopen PowerShell.
- **Services still starting:** Kafka takes longer on a cold start. Check `docker compose ps` and `docker compose logs kafka worker web`.
- **`SESSION_SECRET` missing:** ensure `.env.local` exists and contains a generated random secret of 32+ characters. Never commit `.env.local`.
- **Port conflict:** stop other local services using ports 3001, 27017, 6379, or 9092.
- **Readiness fails:** inspect `docker compose logs web worker mongo redis kafka`.
- **Message stays queued:** check worker and Kafka logs. UI reports saved only after Mongo persistence and Redis publish.
- **Worker is unhealthy:** inspect `docker compose logs worker`. A transient MongoDB/Redis outage should recover automatically; a malformed/permanent Kafka record blocks its partition and requires operator investigation because there is no DLQ.
- **Other browser does not update:** ensure both sessions joined the same room and check Redis subscriptions; refresh loads saved Mongo history.
- **Direct chat is unavailable:** register the other account first; the chooser lists existing accounts.
- **Cookie problems:** use `http://localhost:3001` consistently and clear local site data after changing the secret.
- **Reset all demo data:** `docker compose down -v` removes the Mongo volume and all local accounts/messages.

## Configuration and deployment notes

`MONGODB_TARGET=local` is explicit in Compose for both `web` and `worker`. Both read `LOCAL_DB_URL=mongodb://mongo:27017/scalable_chat` from `.env.local`; the application rejects an unset or unsupported target and rejects non-local hosts for the local target. `DB_URL` remains the separate Atlas setting and is selected only with the explicit `MONGODB_TARGET=atlas` choice. Compose does not load `.env`, so Atlas credentials are not passed into the containers. `.env.local` is ignored by Git; `.env.local.example` is the portable template.

The named `mongo-data` volume persists local MongoDB data across ordinary restarts and `docker compose down`. Do not use `docker compose down -v` unless intentionally deleting all local data. The app listens on port 3001. Deployment preparation is preserved in `DEPLOYMENT.md` and `PRE_DEPLOYMENT_ACCEPTANCE.md`; this local workflow creates no hosted resources and pushes nothing.

Local Compose ports are bound to `127.0.0.1`; the app and infrastructure still communicate over Docker's internal network. Express does not trust forwarded headers by default. For a deployment behind a known reverse proxy, set `TRUST_PROXY` explicitly to a trusted hop count or proxy address/range; avoid `true` unless every forwarding header is controlled by that proxy.
