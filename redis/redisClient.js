const Redis = require("ioredis");
const { redisUrl } = require("../config/server-config");

const options = { lazyConnect: true, maxRetriesPerRequest: 3 };
const pub = new Redis(redisUrl, options);
const sub = new Redis(redisUrl, options);

for (const [name, client] of [["publisher", pub], ["subscriber", sub]]) {
    client.on("error", (error) => {
        console.error(JSON.stringify({ level: "error", component: `redis-${name}`, message: error.message }));
    });
}

module.exports = { pub, sub };
