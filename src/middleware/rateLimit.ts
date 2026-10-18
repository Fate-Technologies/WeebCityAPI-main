/**
 * Inbound rate limiting — fixed-window counter keyed per caller, backed by
 * cacheStore (cross-instance under Redis, in-process otherwise).
 *
 * Two buckets are mounted in server.ts: a generous one on all of /api/v3/* and a
 * strict one on the outward-facing proxy / GraphQL routes. Keying prefers the
 * bearer token (a hash, so we never store it) and falls back to the client IP.
 */
import type { MiddlewareHandler } from "hono";
import { cacheStore } from "../lib/cacheStore.js";
import { env } from "../config/env.js";
import { jsonError } from "../lib/envelope.js";
import { clientIp } from "../lib/clientIp.js";

function clientKey(c: Parameters<MiddlewareHandler>[0]): string {
  return "ip:" + clientIp(c);
}

/** Build a rate-limit middleware for a named bucket capped at `max` per window. */
export function rateLimit(bucket: string, max: number): MiddlewareHandler {
  const windowSec = env.RATE_LIMIT_WINDOW_SEC;
  const windowMs = windowSec * 1000;
  return async (c, next) => {
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs);
    const key = `rl:${bucket}:${clientKey(c)}:${windowStart}`;

    let count: number;
    try { count = await cacheStore.incr(key, windowSec); }
    catch { return c.json(jsonError("Rate limiting temporarily unavailable"), 503); }
    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(Math.max(0, max - count)));

    if (count > max) {
      const resetInSec = windowSec - Math.floor((now % windowMs) / 1000);
      c.header("Retry-After", String(Math.max(1, resetInSec)));
      return c.json(jsonError("Rate limit exceeded, please retry shortly"), 429);
    }
    await next();
  };
}
