# Kafka architecture

> **Snapshot notice:** The “dormant” status below is obsolete after the local functionality work. Kafka is active now: socket handler produces `Chats`; `worker.js` consumes, upserts MongoDB, then publishes to Redis. See root [README.md](../README.md) and [ARCHITECTURE.md](../ARCHITECTURE.md).

## What is implemented

`kafka/kafka.js` creates a KafkaJS client with client ID `scalable-chat-app`, broker address hard-coded as `localhost:9092`, WARN logging, topic `Chats`, and producer using LegacyPartitioner.

- `createProducer()` lazily creates and connects one producer cached in module scope.
- `produceMessage(message)` sends one JSON-serialized record to `Chats`, keyed with `message-<Date.now()>`.
- `consumeMessage()` creates consumer group `default`, connects, subscribes to `Chats` from the beginning, and runs `eachMessage`. It parses `{roomid,sender,message}`, then creates a Chat document with message as content.

`docker-compose.yml` defines ZooKeeper and Kafka with a listener based on `HOST_IP`, auto topic creation, replication factor one, plus Redis Stack. MongoDB is not included. KafkaJS itself points at `localhost:9092`; deployment/container topology can make that hostname wrong unless changed/configured.

## Current runtime status: dormant

The current `index.js` does not import `consumeMessage()`, and current `sockets/socketHandlers.js` does not import `produceMessage()`. `npm start` therefore does not start a Kafka consumer or send chat messages to Kafka. Current message writes go directly from Redis subscriber to MongoDB. Readiness omits Kafka. Kafka functionality is source-present but not runtime-integrated.

## Historical flow versus current source

`PRE_DEPLOYMENT_ACCEPTANCE.md` records that an earlier version called the consumer at startup and producer from the Redis callback. The current source does not. Historical behavior is not evidence that current data is queued durably.

## Engineering assessment

If reactivated as written, `fromBeginning:true` is used when group has no committed offset; consumer group offsets then govern subsequent reads. The consumer has no explicit schema validation, retry policy, dead-letter path, idempotent Mongo write, transaction/outbox, shutdown hook, or health reporting. Producer keys based on wall-clock milliseconds are not stable IDs and can collide. Consumer logs raw record values, potentially exposing message content. The single broker/replication factor configuration is development/demo-grade. Producer has no disconnect method exported for graceful shutdown.

## Potential role and alternatives

Kafka could decouple live socket acceptance from durable message processing, buffer outages, allow replay, and scale workers independently. It is currently not solving those problems because it is unused. Alternatives for simpler deployments include direct Mongo persistence with explicit retry/idempotency, managed queues, or Redis Streams (which differs from Pub/Sub by retaining entries and tracking consumer groups). Any replacement requires explicit delivery guarantees and operational monitoring.

## Safe interview phrasing

“The repository contains a Kafka producer/consumer implementation and Compose setup, but the active application path currently bypasses Kafka. Live messages use Redis Pub/Sub and the subscriber writes directly to MongoDB. Therefore I would describe Kafka as an unfinished or dormant integration, not claim Kafka-backed persistence.”
