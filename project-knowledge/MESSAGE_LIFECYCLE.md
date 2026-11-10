# Message lifecycle

> **Snapshot notice:** This trace describes the prior Redis-direct-to-Mongo path. The active local implementation uses Kafka and a separate worker; follow root [ARCHITECTURE.md](../ARCHITECTURE.md) and [README.md](../README.md) for the current message lifecycle.

## Current implementation: browser to database and back

1. **User action.** `views/index.ejs` includes `#chat_box`, `#send` and room/user data attributes, then loads `public/scripts/chat.js`.
2. **Browser function.** Click or Enter invokes `sendMessage()` in `chat.js`. It trims input, ignores empty content, creates `crypto.randomUUID()`, stores the text in the `pending` Map and emits `new_msg` with `{ message, roomid, requestId }` plus a Socket.IO acknowledgement callback.
3. **Server handler.** `sockets/socketHandlers.js` registers `socket.on("new_msg")` for authenticated connections. Sender identity comes from `socket.data.user.displayName`; client-supplied sender is not trusted.
4. **Validation.** A per-socket fixed window allows eight attempts per ten seconds. It checks that the socket joined the requested room, the message is nonempty after trim and at most 2,000 JS characters. A client request ID matching UUID-like format is kept; otherwise the server generates one. It does not re-check group existence in this handler, because join did so previously.
5. **Redis publish.** Handler calls `pub.publish("room:<id>", JSON.stringify(payload))`; payload carries room ID, server display name, message, source socket ID and request ID. Redis Pub/Sub is synchronous in the sense that the handler awaits the Redis publish command, but it is not a durable queue and this is not a Kafka operation.
6. **Initial acknowledgement.** On successful publish command, event ack returns `{ok:true, requestId}`. This indicates Redis accepted the publish operation; it does not mean MongoDB persistence finished. On command rejection, caller receives `{ok:false}`.
7. **Redis subscriber callback.** The `sub.on("message")` callback parses JSON, checks channel matches room ID, validates room ObjectId, sender/message types and max message length.
8. **Persistence.** It awaits `Chat.create({ roomid, sender, content })`. This is the only current live-path write. There is no unique message/request ID stored, so retries/duplicate subscriber delivery can create duplicate documents.
9. **Live delivery and status.** After `Chat.create` resolves, it emits `msg_rcvd` to `io.to(roomid)` and `message_status` with `ok:true` to the source socket ID. If parsing, validation or Mongo write throws, it logs `message_persist_failed`; where correlation values are available, it emits failure status. Broadcast occurs after persistence, so this handler does not deliver if the write fails.
10. **Browser update.** `chat.js` receives `msg_rcvd`, creates elements and inserts sender/message using `textContent` and text nodes, scrolls to bottom, and styles self/other according to display-name equality. On positive `message_status`, it clears input only if the current text still equals the sent text and shows “Message saved”; otherwise it preserves input and reports failure.

## Persistence, Redis and Kafka

- MongoDB history is fetched separately by `routes/chatRoutes.js`: newest 500 records sorted descending by `_id`, reversed for chronological rendering.
- Redis is a transient pub/sub transport for fanout. It is not a cache and not a durable queue. The publisher uses room channel names; subscriber subscribes when a local user enters the room and unsubscribes when its local presence map becomes empty.
- Kafka is not in this current flow. `kafka/kafka.js` has a producer and consumer that could persist records, but no current caller invokes `produceMessage()` or `consumeMessage()`.
- Message delivery and persistence are coupled within the subscriber callback: Mongo save first, then local broadcast. Redis publish acknowledgement and database persistence are separate stages; the UI waits for the later status event before clearing input.

## Recipient availability and failures

If recipient is disconnected, there is no direct recipient socket to deliver to. The message can still be saved by an active room subscriber, and a future chat-page load fetches persisted history. If no process is subscribed to the channel, Redis Pub/Sub does not retain the event; the publish may have no subscriber and message is lost. If Mongo is unavailable after Redis publication, persistence fails and current process emits a negative status where it has source socket/request IDs; there is no replay. If the sender disconnects before the status, delivery may be impossible to that socket. If Redis is unavailable, publish rejects and the sender receives an error acknowledgement. If one of multiple subscriber processes fails its Mongo write, other copies may still save/broadcast; outcomes can diverge.

## Concurrency and duplicate behavior

Each Redis message callback runs asynchronously and awaits `Chat.create`, but there is no explicit ordering queue, per-room serialization, timestamp, or stable sequence number. Concurrent messages can complete writes and broadcasts in a different order from publish arrival. Same-process Redis Pub/Sub normally emits one callback per publication; retries by client or producer and multi-instance subscribers can produce duplicates. `requestId` is only transient correlation metadata, not persisted or deduplicated.

## Original Kafka design (historical code path)

`PRE_DEPLOYMENT_ACCEPTANCE.md` describes the earlier flow: Redis subscriber broadcast live and called Kafka producer, Kafka consumer wrote to MongoDB. The current source no longer has that wiring. The historical architecture must not be described as active behavior.
