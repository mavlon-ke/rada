// src/lib/db/redis.ts
// Shared Redis singleton — reused across rate limiting, admin lockout,
// and any other Redis-backed feature. Avoids per-request connection setup
// and stays within Upstash's concurrent-connection budget.

import { Redis } from 'ioredis';

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: false,
    });
    _redis.on('error', (e) => console.error('[Redis]', e.message));
  }
  return _redis;
}
