/**
 * POST /api/v3/security/turnstile/verify — Cloudflare Turnstile siteverify.
 *
 * The comment/post/report/suggestion write paths go straight to Supabase from
 * the browser, so there is no server chokepoint to bind a captcha token to the
 * insert. Instead the client fetches a Turnstile token, posts it here to be
 * verified against Cloudflare (the secret key never ships to the client), and
 * only proceeds with its Supabase write on { ok: true }. This is
 * defence-in-depth layered on top of the DB-level automod + rate-limit backstop
 * (20260925000600_ugc_guard.sql) — not a hard gate, but it raises the cost of
 * scripted abuse of the public forms.
 *
 * Auth (sign-up / sign-in) does NOT use this route: Supabase verifies the
 * Turnstile token natively via options.captchaToken. This route is for the
 * high-value public forms (suggestions, reports).
 *
 * Production fails closed when verification is unavailable. Local development
 * may explicitly run without a configured secret.
 */
import { Hono } from "hono";
import { jsonOk, jsonError } from "../lib/envelope.js";
import { env } from "../config/env.js";
import { log } from "../config/logger.js";
import { clientIp } from "../lib/clientIp.js";

export const securityRouter = new Hono();

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
  action?: string;
  hostname?: string;
}

securityRouter.post("/turnstile/verify", async (c) => {
  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  // No secret configured → verification is disabled; do not block the caller.
  if (!secret) {
    if (env.NODE_ENV === "production") return c.json(jsonError("Verification unavailable"), 503);
    return c.json(jsonOk({ ok: true, disabled: true }));
  }

  let token: string | null = null;
  try {
    const body = (await c.req.json()) as { token?: unknown };
    if (typeof body.token === "string" && body.token.trim()) token = body.token.trim();
  } catch {
    return c.json(jsonError("invalid JSON body"), 400);
  }
  if (!token) return c.json(jsonError("missing turnstile token"), 400);

  try {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    const ip = clientIp(c);
    if (ip !== "unknown") form.set("remoteip", ip);
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error("Verification provider unavailable");
    const result = (await res.json()) as SiteverifyResponse;
    const allowedHosts = env.TURNSTILE_ALLOWED_HOSTNAMES.split(",").map((host) => host.trim()).filter(Boolean);
    if (!result.success || !result.hostname || !allowedHosts.includes(result.hostname)) {
      log.info({ codes: result["error-codes"] }, "turnstile verification rejected");
      return c.json(jsonOk({ ok: false }));
    }
    return c.json(jsonOk({ ok: true }));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "turnstile verify failed");
    // Upstream error talking to Cloudflare: fail open so a Cloudflare outage
    // doesn't take down the forms. The DB backstop still guards the write.
    return c.json(jsonError("Verification temporarily unavailable"), 503);
  }
});
