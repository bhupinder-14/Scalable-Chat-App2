# Failure scenarios and debugging

> **Snapshot notice:** Failure analysis below describes the earlier direct-Mongo message path. Kafka is now active in the local setup; use current logs and root [README.md](../README.md) troubleshooting steps for the revised path.

No failure injection was performed as part of this documentation. The tests present in `test/` are unit/component tests with mocks; `PRE_DEPLOYMENT_ACCEPTANCE.md` says external services and browser networking were not available during its earlier audit. The following separates source behavior from likely consequence.

| Scenario | Current handling | Consequence / gap |
|---|---|---|
| Redis unavailable at startup | `start()` awaits both `connect()` calls; startup catch exits nonzero. Redis clients log errors. | App does not serve HTTP without Redis, even for auth/pages. |
| Redis fails during publish | `new_msg` catches publish rejection, logs and acknowledges failure. | Message is not accepted by server; browser preserves input and shows error. No fallback. |
| Redis subscriber unavailable after publish | Pub/Sub has no retention; publisher gets count, not consumer processing status. | Message can be lost; no recovery/replay. Readiness may become false if status changes. |
| Mongo unavailable at startup | `mongoose.connect` rejects; startup exits. | No listener starts. |
| Mongo write fails after Redis publish | Subscriber catch logs and sends negative `message_status` if correlation fields exist. | No room broadcast and no retry; Redis event is already gone. Other instances may have succeeded. |
| Kafka unavailable | Current app does not connect to Kafka. | No direct current runtime impact. If dormant module functions are invoked, connect/send/run errors reject; no designed retry/health path. |
| Socket disconnect | Client disables Send and Socket.IO default reconnect behavior can reconnect; server unregisters, removes local presence, leaves room by socket lifecycle. | Pending status can be lost. No offline socket queue; page reload fetches stored history. |
| Recipient disconnected | No active recipient socket. | Persisted message appears on later page load if subscriber processed it; no push/notification. |
| Duplicate message | No persisted request ID/unique key or UI dedupe. | Duplicate document and duplicate live rendering possible after retries or multiple subscribers. |
| Invalid room ID/nonexistent room | HTTP join/chat returns 404; socket join ack returns error. | Handled. `new_msg` requires prior joined room and exact room match. |
| Invalid message input | Socket handler rejects empty/oversize/unjoined and rate exceeded. | Handled at application layer; no content moderation or abuse review. |
| Concurrent messages | Independent async Redis callbacks and Mongo creates, no ordering key/sequence. | Completion/broadcast order can differ under contention; no conflict control. |
| Server restart | In-memory users, connections, rooms and limiter buckets vanish; shutdown closes socket/Redis/Mongo. | Clients disconnect and may reconnect; history survives only if Mongo saved; Redis in-flight publications are not replayed. |
| Session invalidation on logout | Session version increment then current process socket registry disconnect. | Other app instances' sockets are not in this registry and may remain connected until socket reconnect or expiry; handshake checks DB version only at connection time. |
| Rate limiter memory pressure | Buckets cleaned periodically and capped by evicting oldest when a new key arrives at 10,000. | Per-process, approximate protection; distributed traffic can bypass aggregate limits. |

## Debugging evidence points

Structured logs name events such as `socket_connected`, `room_join_failed`, `message_publish_failed`, `message_persist_failed`, Redis component errors, startup and shutdown errors. Kafka logs are plain console lines and include raw payload values in consumer. Health checks distinguish process liveness from Mongo/Redis readiness, not end-to-end message health. Do not infer service availability from source alone; inspect runtime logs and metrics in a live environment.
