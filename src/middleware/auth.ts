import { createMiddleware } from "hono/factory";
import { jsonError } from "../lib/envelope.js";
import { getSupabase } from "../lib/supabase.js";
import { log } from "../config/logger.js";
import { env } from "../config/env.js";

/** Hono env for routes guarded by requireSupabaseAdmin — exposes the verified admin's auth id. */
export type AdminEnv = { Variables: { adminUserId: string } };

const ADMIN_ROLES = new Set(["admin", "owner"]);

/**
 * Real admin gate: verifies a Supabase access token (Authorization: Bearer ...)
 * with the service-role client, then confirms the caller is staff via
 * profiles.is_admin / role. Unlike requireAdminSecret this doesn't rely on a
 * client-shipped secret — the JWT is minted by Supabase auth and can't be
 * forged. Stashes the verified auth id on the context for audit trails.
 */
export const requireSupabaseAdmin = createMiddleware<AdminEnv>(async (c, next) => {
  const sb = getSupabase();
  if (!sb) return c.json(jsonError("Supabase not configured"), 503);

  const authHeader = c.req.header("authorization") || c.req.header("Authorization") || "";
  const token = /^bearer\s+/i.test(authHeader) ? authHeader.replace(/^bearer\s+/i, "").trim() : "";
  if (!token) return c.json(jsonError("Missing bearer token"), 401);

  const { data: userData, error: userErr } = await sb.auth.getUser(token);
  if (userErr || !userData?.user) return c.json(jsonError("Invalid or expired session"), 401);

  const uid = userData.user.id;
  const { data: profile, error: profErr } = await sb
    .from("profiles")
    .select("is_admin, role")
    .eq("user_id", uid)
    .maybeSingle();

  if (profErr) {
    log.error({ error: profErr.message }, "requireSupabaseAdmin: profile lookup failed");
    return c.json(jsonError("Authorization check failed"), 500);
  }

  const isAdmin =
    profile?.is_admin === true || ADMIN_ROLES.has(String(profile?.role || "").toLowerCase());
  if (!isAdmin) return c.json(jsonError("Admin access required"), 403);

  c.set("adminUserId", uid);
  await next();
});

export const requireAdminSecret = requireSupabaseAdmin;
export const optionalCatalogAuth = createMiddleware<AdminEnv>(async (c, next) => {
  if (env.REQUIRE_ADMIN_FOR_CATALOG) return requireSupabaseAdmin(c, next);
  await next();
});
