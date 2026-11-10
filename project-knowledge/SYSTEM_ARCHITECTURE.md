# System architecture

> **Snapshot notice:** The diagram and runtime description below document the pre-local-stack revision where Kafka was dormant. The current verified local architecture is documented in root [ARCHITECTURE.md](../ARCHITECTURE.md): web → Kafka → worker → MongoDB → Redis Pub/Sub → web sockets.

## Verified architecture

```mermaid
flowchart LR
  Browser[Browser: EJS page + chat.js] -->|HTTP forms/pages| Express[Express app]
  Browser <-->|Socket.IO over HTTP/WebSocket| HTTP[Node HTTP server]
  Express --> Auth[Auth middleware/routes]
  Auth --> Mongo[(MongoDB via Mongoose)]
  Express --> Views[EJS views + public assets]
  HTTP --> Sockets[Socket.IO handlers]
  Sockets -->|publish room:id| RedisPub[Redis publisher]
  RedisPub --> Redis[(Redis Pub/Sub)]
  Redis -->|message callback| Sockets
  Sockets -->|Chat.create| Mongo
  Sockets -->|local room broadcast| Browser
  KafkaCode[kafka/kafka.js producer/consumer] -. dormant, not called .-> Kafka[(Kafka topic Chats)]
  Kafka -. consumer would write Chat.create .-> Mongo
```

The dashed Kafka path depicts implemented module functions, not a running connection in the current process. There is no separate worker process or Kafka startup in `index.js`.

## Technology roles in this application

| Component | Implemented role | Direct interactions |
|---|---|---|
| Node.js | Runs the CommonJS application, crypto operations, timers and event loop. | Express, HTTP, Socket.IO, Mongoose, ioredis. |
| Express | Parses requests, serves static content, applies auth and routes, renders EJS. | HTTP server, Mongoose models, EJS. |
| HTTP server | Shared transport listener for Express and Socket.IO; binds `0.0.0.0` at configured port. | Express and Socket.IO. |
| Socket.IO | Authenticated bidirectional events; local room membership and broadcasts. | Browser client and socket handlers; custom Redis Pub/Sub indirectly distributes message events. |
| MongoDB/Mongoose | Stores users, groups and chat documents; supplies history and existence checks. | HTTP routes, auth code and current Redis message callback. |
| Redis | Pub/Sub fanout for message payloads across processes subscribed to a room channel. Also subscription is used as room-active signal, but not as durable presence. | Socket handler publisher/subscriber. |
| Kafka/KafkaJS | Dormant topic producer and Mongo-writing consumer implementation. | Kafka brokers; if invoked, consumer directly calls Mongoose Chat model. |
| EJS/browser JS | Server-rendered HTML then client-side Socket.IO interaction; textContent protects dynamic live message text. | Express route data and Socket.IO events. |
| Middleware | Body parsing, security headers, static files, user loading, auth, same-origin and rate limit checks. | Express request chain. |

## Startup sequence (`index.js`)

1. Import modules; `server-config.js` loads dotenv and requires `DB_URL`, selects port/Redis/origin/session settings.
2. Create Express app; set trust proxy to one hop and disable `X-Powered-By`.
3. Create Node HTTP server and attach Socket.IO with origin callback.
4. Configure EJS, bounded JSON/urlencoded parsers, response security headers, static assets and liveness/readiness routes.
5. Install `loadUser`, auth router, and auth-protected group/chat/join routers, then generic error middleware.
6. Register socket event handlers and Socket.IO handshake auth middleware. Handshake loads the user from signed cookie and MongoDB.
7. `start()` awaits MongoDB, then both Redis connections, then begins listening. Startup failure logs fatal and exits nonzero.

Readiness is Mongo readyState plus both Redis client status strings equal to `ready`; it does not include Kafka. Liveness always returns success while the process can serve the route.

## Communication boundaries and scaling

Browser HTTP requests and Socket.IO connect to one server origin. Socket events go through Redis Pub/Sub; Redis sends a copy to each subscriber, and each process's handler writes its own Mongo document and emits to its own Socket.IO room. The implementation does not use Socket.IO's Redis adapter, so Redis message propagation does not synchronize Socket.IO room membership or online-user maps. No distributed locks, shared presence storage or message idempotency index exists.

## Error paths

HTTP route failures generally log structured error names and respond with generic text/status. The final Express handler logs an error message and returns 500. Redis client errors are logged by `redisClient.js`; publish and subscriber failures are caught in socket handler. Mongo startup failure prevents listening. During current message persistence failure, subscribers send a failure status to the originating socket when correlation fields are present; there is no durable retry queue.

## Inference and improvement

Redis Pub/Sub is ephemeral, so a subscriber outage during publish can lose a message after the publisher receives Redis's count/ack. Multiple app processes each run the subscriber, causing duplicate database inserts. A Socket.IO Redis adapter plus shared presence design is needed for multi-instance room semantics; durable Kafka integration needs worker lifecycle, retries, idempotent persistence and health/lag reporting.
