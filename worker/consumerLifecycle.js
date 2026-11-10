function watchConsumer(consumer, { onStateChange, isStopping = () => false }) {
    const removers = [];
    const onGroupJoin = () => onStateChange("ready");
    const onCrash = ({ payload } = {}) => {
        const error = payload?.error;
        onStateChange(payload?.restart ? "recovering" : "failed", error);
    };
    const onStop = () => {
        if (!isStopping()) onStateChange("failed", new Error("Kafka consumer stopped unexpectedly"));
    };

    removers.push(consumer.on(consumer.events.GROUP_JOIN, onGroupJoin));
    removers.push(consumer.on(consumer.events.CRASH, onCrash));
    removers.push(consumer.on(consumer.events.STOP, onStop));

    return {
        detach() {
            for (const remove of removers) if (typeof remove === "function") remove();
        },
    };
}

module.exports = { watchConsumer };
