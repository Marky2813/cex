// redis.ts
import { config } from "dotenv"
import path from "path"

config({path: path.resolve(__dirname, ".env")})
import { createClient } from "redis";

const socketOpts = {
  pingInterval: 30000,
  socket: {
    reconnectStrategy: (retries: number) => Math.min(retries * 100, 3000),
    connectTimeout: 10000,
  },
};

console.log(process.env.REDIS_URL)
// for normal reads/writes (push, set, get, etc.)
export const client = createClient({ url: process.env.REDIS_URL!, ...socketOpts });
client.on("error", (err) => console.log("Redis Client Error", err));
client.on("connect", (err) => console.log("connected"));

// dedicated connection for blocking pops — nothing else uses this one
export const responseClient = createClient({ url: process.env.REDIS_URL!, ...socketOpts });
responseClient.on("error", (err) => console.log("Redis Blocking Client Error", err));
responseClient.on("connect", (err) => console.log("connected"));

if (!client.isOpen) await client.connect();
// dedicated connection for blocking pops — nothing else uses this one
if (!responseClient.isOpen) await responseClient.connect();