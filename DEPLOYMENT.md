# Deployment planning notes — not approved or deployed

> **Status update:** This remains preserved deployment planning, not a deployment instruction set. The current local implementation now runs Kafka through Compose and a worker; review the current `Dockerfile`, `docker-compose.yml`, and [README.md](README.md) before adapting these older deployment notes. No hosting resource or GitHub push was created.

## Recommended architecture

| Component | Recommendation | Reason |
| --- | --- | --- |
| Web app, Express, EJS, Socket.IO | Render paid Web Service (one instance) is a candidate | One deployable can serve the UI and persistent Socket.IO connection; this is not configured or approved. |
| MongoDB | MongoDB Atlas is a candidate | Compatible with Mongoose. The free shared tier has storage, transfer, and feature limits and is not an uptime/SLA tier. |
| Redis | Upstash Redis is a candidate | Compatible with ioredis. The free plan has usage limits; verify the current limits before use. |
| Kafka | The local implementation now uses a producer, separate worker, and MongoDB persistence | Hosted setup needs a continuously running worker and managed Kafka; current Compose settings are local-only. |
| Frontend | Serve from Express | The app uses EJS templates and static files, so a separate static host adds CORS and deployment coordination without benefit. |

Keep one web instance until Socket.IO's Redis adapter and shared online-presence storage are implemented. The local worker uses stable message IDs and idempotent MongoDB upserts, but has no dead-letter queue, bounded retry policy, or hosted worker health monitoring.

## Architecture options to review

- **Current local profile:** Socket.IO web service, Kafka producer, separate Kafka worker, MongoDB persistence, and Redis Pub/Sub fanout. The local flow is implemented in Compose but requires live validation before hosted use.
- **Simpler hosted alternative:** One always-on Node service, MongoDB, and Redis with direct Mongo persistence, if deliberately added as an alternate profile. This removes Kafka buffering and Redis Pub/Sub remains transient.
- **Multi-instance profile:** Add the official Socket.IO Redis adapter and shared presence, plus bounded retry/dead-letter handling and worker health monitoring. Keep web and worker on persistent compute. Do not run the consumer on a sleeping/free web service.

The multi-instance profile is not implemented or verified end to end. The local profile is intended for a single-machine demonstration.

## Provider tradeoffs

- **Render:** A free web service supports WebSockets but sleeps after 15 minutes without inbound traffic and takes about a minute to wake. Render says its free instances are for hobby/testing and not production. The current pricing page lists the smallest always-on web service at $7/month. This is the simplest predictable public demo.
- **Railway:** Persistent services and long-lived WebSockets are supported. Hobby is a $5/month minimum that is applied to usage, so the final charge depends on resources. Good alternative if you prefer usage-based billing and are comfortable configuring the project.
- **Fly.io:** Supports long-running app machines and gives fine-grained compute pricing; small machines start around a few dollars monthly, but persistent always-on operation, RAM, storage, and India-region egress affect the actual bill. More operational setup than Render.
- **MongoDB Atlas:** Free shared tier suits a small demo but has shared-resource and data-transfer limits. Upgrade to a paid tier if the application needs dependable production uptime, backups, or more capacity.
- **Upstash Redis:** The free plan is appropriate for a small demo; usage limits apply. Monitor commands and bandwidth before giving the app a public event or interview traffic.
- **Kafka:** If the original scalable profile is selected, use a managed Kafka provider with TLS/SASL credentials and a continuously available consumer worker. Include current Kafka/worker usage in the estimate; do not assume a free plan supports the consumer.

Provider prices and free-tier limits change. Check provider billing pages before enabling a paid plan. No provider account, cluster, or paid resource was created. There is no approved architecture or final cost estimate yet; Kafka pricing and a separate worker must be included if the original scalable profile is selected.

## Prepare provider services

1. Create a MongoDB Atlas project and cluster. Create an application database user, configure network access for the application host, and copy the application's `mongodb+srv://` connection string. Use a unique password and restrict access as tightly as the host's outbound networking allows.
2. Create a Redis database in Upstash and copy its **Redis connection URL** (TLS URL if provided). Never put either URI in source control.
3. Do not push from the current folders yet. The backup has no Git metadata, and the sibling Git directory tracks a committed `.env` but not the application source. Reconcile the repository and rotate that credential before using GitHub.
4. In Render, create a Web Service from that repository. Set build command `npm ci`, start command `npm start`, health check path `/health/ready`, and choose an always-on paid instance. Do not select the sleeping free instance for a live demonstration.
5. Add these values in the Render service's Environment settings. Mark database, Redis, and session values secret:

   - `NODE_ENV=production`
   - `DB_URL=<Atlas connection URI>`
   - `REDIS_URL=<Upstash Redis URL>`
   - `KAFKA_BROKERS=<managed Kafka broker list>` and provider TLS/SASL settings as required
   - `SESSION_SECRET=<at least 32 random characters>`
   - `ALLOWED_ORIGINS=` (same-origin UI uses `RENDER_EXTERNAL_URL`)
   - `PORT` is assigned by Render; the application reads it automatically.

Render can terminate public HTTPS and forward traffic to the service. If selected later, open the generated `https://...onrender.com` address; Socket.IO uses the same origin. If a separate frontend is introduced, set `ALLOWED_ORIGINS` to its exact HTTPS origin.

## Local production-style start

Copy `.env.example` to `.env`, set a random `SESSION_SECRET` of at least 32 characters, configure `DB_URL`, `REDIS_URL`, and `KAFKA_BROKERS`, then start both the web process and `node worker.js` against local services:

```powershell
npm ci
npm start
node worker.js
```

Run `npm start` and `node worker.js` in separate terminals or separate hosted processes.

Do not commit `.env`. In hosted environments, use the provider's encrypted environment-variable settings instead. The app exposes `/health/live` and `/health/ready`; web readiness includes MongoDB, Redis, and the Kafka producer. Logs are JSON lines to stdout/stderr. SIGTERM/SIGINT closes Socket.IO, Redis, MongoDB, and the web Kafka producer. The Kafka worker is a separate process and must be deployed independently.

## Updating the deployed app

After repository cleanup, architecture approval, and successful functional verification, commit and push changes to the connected deployment branch. Render can build with `npm ci` and `npm start`. Review the deployment log, then open `/health/ready` and the app URL. Never add secrets to commit history; rotate any credential that was committed.

## Current limits

- One backend instance is supported by the in-memory online-user list and local Socket.IO rooms.
- The worker persists Kafka records to MongoDB before publishing live events to Redis. Redis Pub/Sub remains transient. Handler failures leave the Kafka record uncommitted for consumer retry behavior; the app has no explicit dead-letter topic or retry policy.
- Authentication and basic rate limits are implemented. There is no email verification, password recovery, moderation, or distributed rate limiting.
- Direct rooms have two-participant access checks; public groups remain open to all signed-in users.
- Atlas/Upstash free services and Render's smallest paid service are suitable for a demonstration, not a production availability commitment.
