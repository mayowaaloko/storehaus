// src/config/redis.ts

import Redis from "ioredis";
import "dotenv/config";

// ─── Create the Redis client ──────────────────────────────────────────────────
//
// lazyConnect: true  → don't connect immediately on import.
//                       We call client.connect() explicitly in server.ts
//                       so we control when the connection happens.
//
// maxRetriesPerRequest: 3 → if a Redis command fails, retry 3 times
//                           before throwing. Prevents a single blip
//                           from crashing a request.

const client = new Redis(process.env.REDIS_URL || "", {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy(times) {
    // Exponential backoff: 1s, 2s, 4s, 8s... up to 30s max
    // Redis will keep trying to reconnect automatically on disconnect
    const delay = Math.min(1000 * 2 ** times, 30_000);
    return delay;
  },
});

// ─── Connection state ─────────────────────────────────────────────────────────
//
// We track whether Redis is connected so that cache helpers
// can silently skip instead of throwing when Redis is down.
// The app must work without Redis — it just won't be cached.

let isConnected = false;

client.on("connect", () => {
  isConnected = true;
  console.log("[Redis] Connected");
});

client.on("ready", () => {
  isConnected = true;
  console.log("[Redis] Ready to accept commands");
});

client.on("error", (err) => {
  isConnected = false;
  // Log but don't crash — Redis being down is degraded service, not fatal
  console.error("[Redis] Error:", err.message);
});

client.on("close", () => {
  isConnected = false;
  console.warn("[Redis] Connection closed");
});

client.on("reconnecting", () => {
  console.log("[Redis] Reconnecting...");
});

// ─── Connect function (called once in server.ts) ──────────────────────────────

export async function connectRedis(): Promise<void> {
  try {
    await client.connect();
  } catch (err) {
    // Not fatal — app starts without Redis, just no caching
    console.warn(
      "[Redis] Could not connect at startup. Running without cache.",
    );
  }
}

// ─── Disconnect function (called in graceful shutdown) ────────────────────────

export async function disconnectRedis(): Promise<void> {
  await client.quit();
  console.log("[Redis] Disconnected cleanly");
}

// ─── Cache helpers ────────────────────────────────────────────────────────────
//
// These are the only functions the rest of the app should use.
// Never import the raw `client` outside this file.
//
// Every function:
//   1. Checks `isConnected` first — skip silently if Redis is down
//   2. Wraps in try/catch — a Redis error never crashes a request
//   3. Handles JSON serialisation/deserialisation for you

export const cache = {
  // ── GET ───────────────────────────────────────────────────────────────────
  // Returns the parsed value, or null if not found / Redis is down
  //
  // Usage:
  //   const store = await cache.get<Store>(`store:${slug}`)
  //   if (store) return store  // cache hit
  //   // cache miss — go to DB

  async get<T>(key: string): Promise<T | null> {
    if (!isConnected) return null;
    try {
      const value = await client.get(key);
      if (!value) return null;
      return JSON.parse(value) as T;
    } catch (err) {
      console.error(`[Redis] GET error for key "${key}":`, err);
      return null;
    }
  },

  // ── SET ───────────────────────────────────────────────────────────────────
  // Stores a value with a TTL (time-to-live) in seconds.
  // After TTL seconds, Redis automatically deletes the key.
  //
  // Usage:
  //   await cache.set(`store:${slug}`, storeData, 3600)  // cache for 1 hour

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!isConnected) return;
    try {
      // SETEX = SET + EXpiry in one atomic command
      await client.setex(key, ttlSeconds, JSON.stringify(value));
    } catch (err) {
      console.error(`[Redis] SET error for key "${key}":`, err);
    }
  },

  // ── DEL ───────────────────────────────────────────────────────────────────
  // Deletes a single key.
  // Call this when the data that key represents has been updated.
  //
  // Usage:
  //   await cache.del(`product:${storeId}:${productId}`)

  async del(key: string): Promise<void> {
    if (!isConnected) return;
    try {
      await client.del(key);
    } catch (err) {
      console.error(`[Redis] DEL error for key "${key}":`, err);
    }
  },

  // ── DEL BY PREFIX ─────────────────────────────────────────────────────────
  // Deletes all keys that start with a given prefix.
  // Used to invalidate an entire group — e.g. all product listings for a store.
  //
  // IMPORTANT: Uses SCAN, not KEYS. Never use KEYS in production —
  // it blocks Redis while scanning the entire keyspace.
  // SCAN is non-blocking and cursor-based.
  //
  // Usage:
  //   await cache.delByPrefix(`products:${storeId}:list:`)
  //   // deletes: products:abc:list:p1:l20, products:abc:list:p2:l20, etc.

  async delByPrefix(prefix: string): Promise<void> {
    if (!isConnected) return;
    try {
      // SCAN returns a cursor and a batch of matching keys.
      // We keep scanning until cursor returns to "0" (full loop complete).
      let cursor = "0";
      const keysToDelete: string[] = [];

      do {
        const [nextCursor, keys] = await client.scan(
          cursor,
          "MATCH",
          `${prefix}*`,
          "COUNT",
          100, // scan 100 keys per iteration — non-blocking
        );
        cursor = nextCursor;
        keysToDelete.push(...keys);
      } while (cursor !== "0");

      if (keysToDelete.length > 0) {
        // DEL accepts multiple keys — delete all at once
        await client.del(...keysToDelete);
      }
    } catch (err) {
      console.error(`[Redis] DEL BY PREFIX error for prefix "${prefix}":`, err);
    }
  },

  // ── EXISTS ────────────────────────────────────────────────────────────────
  // Check if a key exists without fetching its value.
  // Useful for idempotency checks.
  //
  // Usage:
  //   const alreadyProcessed = await cache.exists(`idempotency:${key}`)
  //   if (alreadyProcessed) return cachedResponse

  async exists(key: string): Promise<boolean> {
    if (!isConnected) return false;
    try {
      const result = await client.exists(key);
      return result === 1;
    } catch (err) {
      console.error(`[Redis] EXISTS error for key "${key}":`, err);
      return false;
    }
  },

  // ── SET NX (Set if Not eXists) ────────────────────────────────────────────
  // Sets a key ONLY if it does not already exist.
  // Returns true if the key was set, false if it already existed.
  //
  // This is used for distributed locks and idempotency —
  // if two requests arrive at the same time, only one wins.
  //
  // Usage:
  //   const acquired = await cache.setNX(`idempotency:${key}`, 'processing', 30)
  //   if (!acquired) {
  //     // another request is already processing this — wait or reject
  //   }

  async setNX(
    key: string,
    value: unknown,
    ttlSeconds: number,
  ): Promise<boolean> {
    if (!isConnected) return true; // if Redis is down, allow through (degrade gracefully)
    try {
      const result = await client.set(
        key,
        JSON.stringify(value),
        "EX",
        ttlSeconds,
        "NX", // only set if not exists
      );
      return result === "OK"; // 'OK' = key was set (we won the lock), null = already existed
    } catch (err) {
      console.error(`[Redis] SET NX error for key "${key}":`, err);
      return true; // fail open — allow through
    }
  },

  // ── INCR ──────────────────────────────────────────────────────────────────
  // Increments a counter by 1 and returns the new value.
  // Used for rate limiting counters.
  //
  // Usage:
  //   const count = await cache.incr(`ratelimit:${ip}`)
  //   if (count === 1) await cache.expire(`ratelimit:${ip}`, 60)  // set TTL on first hit

  async incr(key: string): Promise<number> {
    if (!isConnected) return 0;
    try {
      return await client.incr(key);
    } catch (err) {
      console.error(`[Redis] INCR error for key "${key}":`, err);
      return 0;
    }
  },

  // ── EXPIRE ────────────────────────────────────────────────────────────────
  // Sets a TTL on an existing key (used after INCR which doesn't set TTL).

  async expire(key: string, ttlSeconds: number): Promise<void> {
    if (!isConnected) return;
    try {
      await client.expire(key, ttlSeconds);
    } catch (err) {
      console.error(`[Redis] EXPIRE error for key "${key}":`, err);
    }
  },
};

// ─── Export the raw client only for BullMQ ────────────────────────────────────
// BullMQ needs direct access to the Redis client to manage its own queues.
// No other file should import this.

export { client as redisClient };
