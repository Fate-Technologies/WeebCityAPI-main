import type { CacheMeta } from "./envelope.js";
import { env } from "../config/env.js";
import { recordCache } from './metrics.js';

interface Entry<T> {
  value: T;
  expiresAt: number;
  staleAt: number;
}

/** Simple in-memory stale-while-revalidate cache */
export class MemoryCache {
  private map = new Map<string, Entry<unknown>>();
  constructor(private readonly maxEntries = env.CACHE_MAX_ENTRIES, private readonly measured=true) {}

  get<T>(key: string): { hit: T; meta: CacheMeta } | null {
    const e = this.map.get(key) as Entry<T> | undefined;
    if (!e) { if(this.measured)recordCache('miss'); return null; }
    const now = Date.now();
    if (now > e.expiresAt) {
      this.map.delete(key);
      if(this.measured)recordCache('miss');
      return null;
    }
    const meta: CacheMeta = now > e.staleAt ? "stale" : "hit";
    if(this.measured)recordCache(meta);
    return { hit: e.value, meta };
  }

  set<T>(key: string, value: T, ttlSec: number, staleRatio = 0.85): void {
    this.map.delete(key);
    while (this.map.size >= Math.max(1, this.maxEntries)) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    const ttlMs = ttlSec * 1000;
    const staleAt = Date.now() + ttlMs * staleRatio;
    const expiresAt = Date.now() + ttlMs;
    this.map.set(key, { value, expiresAt, staleAt });
  }

  delete(key: string) {
    this.map.delete(key);
  }
}

export const memoryCache = new MemoryCache();

export function defaultTtlSec(): number {
  return env.CACHE_DEFAULT_TTL_SEC;
}

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Run `work` at most once per key while it is in flight.
 *
 * A cache only helps after the first response. Without this, every request that
 * arrives during a cold fetch starts its own — so a restart, or a TTL expiring
 * under load, multiplies one upstream call by however many clients happened to
 * be looking. Callers still cache the result themselves; this only collapses the
 * concurrent misses.
 */
export function coalesce<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const started = work().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}
