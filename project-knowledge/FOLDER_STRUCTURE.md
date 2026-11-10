# Folder and file inventory

> **Snapshot notice:** This inventory predates the local Compose/Kafka worker changes. See root [README.md](../README.md) for current startup instructions and inspect the current tree for additions (`Dockerfile`, `worker.js`, `kafka/messagePipeline.js`, `security/roomAccess.js`, and new tests).

This inventory covers project files outside generated `node_modules/`. The dependency directory is installed third-party package content, not application source; `package-lock.json` records the resolved dependency tree.

| Path | Responsibility |
|---|---|
| `index.js` | Main process entry; Express/HTTP/Socket.IO setup, middleware, health endpoints, startup and shutdown. |
| `package.json` | Project metadata, npm scripts, runtime dependencies. |
| `package-lock.json` | Exact npm dependency resolution. |
| `.env` | Local environment file; values were not read into this documentation. |
| `.env.example` | Names/documentation for environment configuration. |
| `.gitignore` | Git ignore rules. |
| `config/server-config.js` | Loads dotenv, validates session secret and DB URL, exports server settings. |
| `config/db-config.js` | Mongoose connection function. |
| `models/user.js` | Account schema: unique normalized username, display name, hidden password salt/hash and session version, timestamps. |
| `models/group.js` | Group schema with optional name and `isPersonal` flag; no membership list. |
| `models/chat.js` | Message schema with content, sender display-name string and room ObjectId; no explicit timestamps or idempotency key. |
| `routes/index.js` | Aggregates group/chat/join routers. |
| `routes/authRoutes.js` | Sign-in, registration, logout; password hashing, session cookies and auth rate limiting. |
| `routes/groupRoutes.js` | Authenticated group list/create routes. |
| `routes/joinRoutes.js` | Validates requested group and redirects to its chat page. |
| `routes/chatRoutes.js` | Validates group, loads up to 500 historical messages and renders chat view. |
| `security/auth.js` | Cookie parsing/signing, token validation, scrypt password helpers, authentication middleware and same-origin check. |
| `security/rateLimit.js` | In-memory fixed-window HTTP rate limiter. |
| `security/socketRegistry.js` | In-process user-to-socket registry used to disconnect sockets on logout. |
| `sockets/socketHandlers.js` | Connection cap, room membership/presence, message validation, Redis Pub/Sub publish/consume callback, Mongo persistence, Socket.IO broadcasts. |
| `redis/redisClient.js` | Creates Redis publisher/subscriber and logs client errors. |
| `kafka/kafka.js` | KafkaJS producer and consumer; consumer writes Kafka records to MongoDB. Currently not called by runtime entry points. |
| `public/scripts/chat.js` | Browser Socket.IO connection, room join, send/status handling, safe DOM updates and online list. |
| `public/styles/index.css` | Chat page styling. |
| `public/styles/homepage.css` | Auth and group-list styling. |
| `public/styles/groups.css` | Legacy group creation page styling. |
| `public/styles/join.css` | Legacy join form styling. |
| `views/auth.ejs` | Sign-in and registration forms. |
| `views/home.ejs` | Authenticated group list/create form/logout form. |
| `views/index.ejs` | Chat page, message history markup, Socket.IO client script references. |
| `views/group.ejs` | Legacy group creation view; current group routes render `home.ejs`, not this view. |
| `views/join.ejs` | Legacy username prompt; current join route redirects directly and does not render it. |
| `views/styles.css` | Empty stylesheet file. |
| `docker-compose.yml` | Local Kafka/ZooKeeper/Redis services; no MongoDB service is defined. |
| `README.md` | Project setup and high-level architecture notes; notes current Kafka bypass. |
| `DEPLOYMENT.md` | Deployment planning and architecture alternatives; explicitly unapproved. |
| `PRE_DEPLOYMENT_ACCEPTANCE.md` | Prior audit notes, test evidence/limitations, deployment blockers and architecture recommendations. |
| `test/auth.test.js` | Unit checks for cookies/tokens/password hashing/same-origin behavior. |
| `test/rateLimit.test.js` | Unit check for HTTP rate limiting. |
| `test/socketHandlers.test.js` | Mocked socket/Redis/Mongo behavior assertion for authenticated messaging. |
| `test/views.test.js` | EJS rendering and output escaping assertions. |

## Directories

- `config/`: startup configuration and Mongo connection.
- `models/`: Mongoose schemas/models.
- `routes/`: Express HTTP request handlers.
- `security/`: auth, rate limiting and socket bookkeeping.
- `sockets/`: Socket.IO event behavior.
- `redis/`: Redis connections.
- `kafka/`: Kafka producer/consumer module, dormant in current app startup.
- `public/`: browser JavaScript and CSS served statically.
- `views/`: EJS server-rendered pages.
- `test/`: Node built-in test runner tests.

## Configuration and entry points

`npm start` runs `node index.js`; `npm run dev` runs Node watch mode on the same entry; `npm test` runs `node --test`. `docker-compose.yml` starts Redis, Kafka and ZooKeeper, but not MongoDB. The server requires `DB_URL`; Redis defaults locally if `REDIS_URL` is absent. Kafka broker settings are hard-coded in its module.
