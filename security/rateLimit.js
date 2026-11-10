function rateLimit({ windowMs, max, key = (req) => req.ip }) {
    const buckets = new Map();
    const cleanup = setInterval(() => {
        const cutoff = Date.now() - windowMs;
        for (const [id, bucket] of buckets) if (bucket.started < cutoff) buckets.delete(id);
    }, Math.min(windowMs, 60_000));
    cleanup.unref();

    return (req, res, next) => {
        const id = key(req);
        const now = Date.now();
        let bucket = buckets.get(id);
        if (!bucket || now - bucket.started >= windowMs) {
            if (!bucket && buckets.size >= 10_000) {
                const oldestKey = buckets.keys().next().value;
                if (oldestKey !== undefined) buckets.delete(oldestKey);
            }
            bucket = { started: now, count: 0 };
            buckets.set(id, bucket);
        }
        bucket.count += 1;
        if (bucket.count > max) {
            res.set("Retry-After", String(Math.ceil((windowMs - (now - bucket.started)) / 1000)));
            return res.status(429).send("Too many requests. Try again shortly.");
        }
        next();
    };
}

module.exports = rateLimit;
