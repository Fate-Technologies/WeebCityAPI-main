/**
 * Unified cache + counter store.
 *
 * Uses Redis when REDIS_URL is set (cross-instance, survives restarts), else the
 * in-process MemoryCache. One async get/set/del + SWR interface so callers don't
 * care which backend is live. `incr` powers the inbound rate limiter — atomic
 * under Redis, best-effort in memory. All Redis ops fail *open* (a blip degrades
 * to a cache miss / uncounted request, never a 500).
 */
import { Redis } from "ioredis";
import type { CacheMeta } from "./envelope.js";
import { env } from "../config/env.js";
import { log } from "../config/logger.js";
import { MemoryCache } from "./cache.js";
import { recordCache } from "./metrics.js";

export interface CacheStore {
  get<T>(key: string): Promise<{ hit: T; meta: CacheMeta } | null>;
  set<T>(key: string, value: T, ttlSec: number, staleRatio?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Increment a counter; on the first hit set its TTL. Returns the new count. */
  incr(key: string, ttlSec: number): Promise<number>;
}

class MemoryStore implements CacheStore {
  private cache = new MemoryCache(env.CACHE_MAX_ENTRIES,false);
  private counters = new Map<string, { count: number; expiresAt: number }>();

  constructor() {
    // Windows are short (seconds); sweep expired counters so IP-keyed entries
    // don't accumulate unboundedly on a long-lived process.
    const t = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.counters) if (now > v.expiresAt) this.counters.delete(k);
    }, 60_000);
    if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
  }

  async get<T>(key: string) { const result = this.cache.get<T>(key); recordCache(result?.meta === "stale" ? "stale" : result ? "hit" : "miss"); return result; }
  async set<T>(key: string, value: T, ttlSec: number, staleRatio = 0.85) {
    this.cache.set(key, value, ttlSec, staleRatio);
  }
  async del(key: string) { this.cache.delete(key); }
  async incr(key: string, ttlSec: number): Promise<number> {
    const now = Date.now();
    const e = this.counters.get(key);
    if (!e || now > e.expiresAt) {
      this.counters.set(key, { count: 1, expiresAt: now + ttlSec * 1000 });
      return 1;
    }
    e.count++;
    return e.count;
  }
}

class RedisStore implements CacheStore {
  private fallback = new MemoryCache(Math.min(env.CACHE_MAX_ENTRIES,500),false);
  constructor(private readonly redis: Redis, private readonly control: Redis) {}

  async get<T>(key: string): Promise<{ hit: T; meta: CacheMeta } | null> {
    try {
      const raw = await this.redis.get(key);
      if (!raw) { recordCache("miss"); return null; }
      const { v, staleAt } = JSON.parse(raw) as { v: T; staleAt: number };
      recordCache(Date.now() > staleAt ? "stale" : "hit");
      return { hit: v, meta: Date.now() > staleAt ? "stale" : "hit" };
    } catch (err) {
      log.warn({ err: (err as Error).message }, "cacheStore.get failed");
      recordCache("error");
      return this.fallback.get<T>(key);
    }
  }

  async set<T>(key: string, value: T, ttlSec: number, staleRatio = 0.85): Promise<void> {
    this.fallback.set(key,value,Math.min(ttlSec,60),staleRatio);
    try {
      const staleAt = Date.now() + ttlSec * 1000 * staleRatio;
      await this.redis.set(key, JSON.stringify({ v: value, staleAt }), "EX", ttlSec);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "cacheStore.set failed");
    }
  }

  async del(key: string): Promise<void> {
    this.fallback.delete(key);
    try { await this.redis.del(key); }
    catch (err) { log.warn({ err: (err as Error).message }, "cacheStore.del failed"); }
  }

  async incr(key: string, ttlSec: number): Promise<number> {
    try {
      return Number(await this.control.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 or redis.call('TTL',KEYS[1])<0 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
        1, key, ttlSec,
      ));
    } catch (err) {
      log.warn({ err: (err as Error).message }, "cacheStore.incr failed");
      throw new Error("Control store unavailable");
    }
  }
}

let redisClient: Redis | null = null;
let controlClient: Redis | null = null;

function createStore(): CacheStore {
  const url = env.REDIS_URL?.trim();
  if (url) {
    try {
      redisClient = new Redis(url, {
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
        lazyConnect: false,
      });
      redisClient.on("error", (err) => log.warn({ err: err.message }, "redis connection error"));
      log.info("cacheStore: Redis backend");
      controlClient = env.REDIS_CONTROL_URL ? new Redis(env.REDIS_CONTROL_URL, {
        maxRetriesPerRequest: 1, enableOfflineQueue: false,
      }) : redisClient;
      if (controlClient !== redisClient) controlClient.on("error", () => log.warn("Redis control connection unavailable"));
      return new RedisStore(redisClient, controlClient);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "cacheStore: Redis init failed, using memory");
    }
  }
  log.info("cacheStore: in-memory backend");
  return new MemoryStore();
}

export const cacheStore: CacheStore = createStore();
/** Large binary objects must never spill into the JSON in-process fallback. */
export function cacheRedisClient(): Redis | null { return redisClient?.status === 'ready' ? redisClient : null; }

/** Close the Redis connection on shutdown (no-op for the memory backend). */
export async function closeCacheStore(): Promise<void> {
  if (controlClient && controlClient !== redisClient) {
    try { await controlClient.quit(); } catch { /* already closed */ }
  }
  controlClient = null;
  if (redisClient) {
    try { await redisClient.quit(); } catch { /* already closed */ }
    redisClient = null;
  }
}

export { coalesce } from "./cache.js";

export async function cacheReady(): Promise<boolean> {
  if (!redisClient) return env.NODE_ENV !== "production";
  try { await Promise.all([redisClient.ping(), controlClient?.ping()]); return true; }
  catch { return false; }
}

