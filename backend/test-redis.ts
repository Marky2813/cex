// test-redis.ts
import { createClient } from "redis";

const client = createClient({
  url: "rediss://default:gQAAAAAAAg_JAAIgcDI5ODkyMjIyNzViOTY0MmUyYjM3YjBlZmY5OGFkODBkYQ@equipped-koi-135113.upstash.io:6379",
  pingInterval: 30000,
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
    connectTimeout: 10000,
  },
});

client.on("error", (err) => console.log("Redis Client Error", err));
client.on("connect", () => console.log("connected"));
client.on("ready", () => console.log("ready"));
client.on("reconnecting", () => console.log("reconnecting"));
client.on("end", () => console.log("ended"));

await client.connect();
console.log("connect() resolved");

setInterval(async () => {
  const pong = await client.ping();
  console.log("ping:", pong, new Date().toISOString());
}, 5000);