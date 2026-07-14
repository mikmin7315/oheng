import { Redis } from '@upstash/redis';

let client = null;

export function getRedis() {
  if (!client) client = Redis.fromEnv();
  return client;
}
