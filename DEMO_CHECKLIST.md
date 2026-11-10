# Recruiter demo checklist

1. Start with `docker compose up --build -d`; confirm web, worker, Kafka, Redis, and MongoDB are healthy.
2. Open two independent browser sessions, register distinct accounts, and sign in.
3. Start a direct conversation and send a message; confirm it appears in both sessions and reports saved.
4. Create a public group, join it from the other account, and exchange messages live.
5. Refresh the chat and show MongoDB-backed history remains.
6. Point out `message_enqueued` and `message_persisted` logs; optionally show Kafka records and Redis room channels.
7. Explain the design: Kafka buffers accepted work, the idempotent Mongo upsert avoids duplicate records, and Redis Pub/Sub carries live room events. Multi-instance presence/Socket.IO adapter work remains future scope.
