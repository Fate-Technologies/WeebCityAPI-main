import { cors } from "hono/cors";
import { env } from "./env.js";

// Env-driven allowlist. Default "*" keeps the catalog world-readable; set
// CORS_ALLOWED_ORIGINS to a comma-separated list to lock it down.
const configured: string[] = env.CORS_ALLOWED_ORIGINS.split(",")
  .map((s: string) => s.trim())
  .filter(Boolean);
const allowAny = configured.length === 0 || configured.includes("*");

/** Local dev origins are always allowed: the API uses Bearer auth (no
 * cookies), so the page origin is not a security boundary — and without this
 * a restrictive prod allowlist would break `vite dev` against the API. */
function isLocalDevOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:") return false;
    return (
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function resolveOrigin(origin: string): string | null {
  if (isLocalDevOrigin(origin)) return origin;
  if (allowAny) return "*";
  return configured.includes(origin) ? origin : null;
}

export const corsMiddleware = cors({
  origin: resolveOrigin,
  allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Admin-Secret", "X-Tatakai-Client", "X-Tatakai-Version"],
  exposeHeaders: ["Content-Length", "Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining"],
  maxAge: 86400,
});
