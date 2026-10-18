/**
 * Baseline security response headers, applied to every route. Balanced defaults:
 * hardened against sniffing / clickjacking / referrer leakage without breaking a
 * public JSON API. HSTS only in production (where TLS is guaranteed).
 */
import type { MiddlewareHandler } from "hono";
import { env } from "../config/env.js";

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-DNS-Prefetch-Control", "off");
  c.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  if (env.NODE_ENV === "production") {
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
};
