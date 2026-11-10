const { Kafka, Partitioners, logLevel } = require("kafkajs");
const { kafkaBrokers } = require("../config/server-config");
const { watchConsumer } = require("../worker/consumerLifecycle");

const kafka = new Kafka({
    clientId: "scalable-chat-app",
    brokers: kafkaBrokers,
    retry: { initialRetryTime: 300, maxRetryTime: 30_000, factor: 0.2, multiplier: 2, retries: 5 },
    logLevel: logLevel.WARN, // Set log level to WARN or higher
});

let producer = null;
let producerReady = false;
let consumer = null;
let consumerWatcher = null;
let consumerStopping = false;
const topic = "Chats";

async function createProducer() {
    if (producer) return producer;
    const _producer = kafka.producer({
        createPartitioner: Partitioners.LegacyPartitioner,
    });
    await _producer.connect();
    producer = _producer;
    producerReady = true;
    return producer;
}

async function connectProducer() {
    await createProducer();
}

async function produceMessage(message) {
    const producer = await createProducer();
    const result = await producer.send({
        topic,
        messages: [
            {
                key: message.messageId,
                value: JSON.stringify(message),
            },
        ],
    });
    console.log(JSON.stringify({ level: "info", event: "message_enqueued", messageId: message.messageId, topic }));
    return result;
}

async function consumeMessages(onMessage, { groupId = "scalable-chat-local", onStateChange = () => {} } = {}) {
    const currentConsumer = kafka.consumer({ groupId });
    consumer = currentConsumer;
    consumerStopping = false;
    consumerWatcher = watchConsumer(currentConsumer, { onStateChange, isStopping: () => consumerStopping });
    try {
        await currentConsumer.connect();
        await currentConsumer.subscribe({ topic, fromBeginning: true });
        await currentConsumer.run({ eachMessage: onMessage });
        console.log(JSON.stringify({ level: "info", event: "kafka_consumer_started", topic, groupId }));
        return currentConsumer;
    } catch (error) {
        consumerStopping = true;
        consumerWatcher?.detach();
        consumerWatcher = null;
        consumer = null;
        await currentConsumer.disconnect().catch(() => {});
        throw error;
    }
}

async function disconnectConsumer() {
    if (!consumer) return;
    const current = consumer;
    consumerStopping = true;
    consumer = null;
    await current.stop();
    await current.disconnect();
    consumerWatcher?.detach();
    consumerWatcher = null;
}

async function disconnectProducer() {
    if (!producer) return;
    const current = producer;
    producer = null;
    producerReady = false;
    await current.disconnect();
}

module.exports = {
    kafka, topic, connectProducer, produceMessage, consumeMessages, disconnectConsumer, disconnectProducer,
    get producerReady() { return producerReady; },
};
