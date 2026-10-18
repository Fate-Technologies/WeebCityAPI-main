import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env, hasSupabase } from "../config/env.js";
import { log } from "../config/logger.js";

let client: SupabaseClient | null = null;

// Decode the `role` claim of the configured key. A service client MUST use the
// service_role key — an anon key passes createClient() fine but runs under RLS,
// so privileged writes (e.g. profiles OAuth tokens) silently match zero rows.
function keyRole(jwt: string): string | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json?.role === "string" ? json.role : null;
  } catch {
    return null;
  }
}

export function getSupabase(): SupabaseClient | null {
  if (!hasSupabase) return null;
  if (!client) {
    const role = keyRole(env.SUPABASE_SERVICE_ROLE_KEY);
    if (role !== "service_role") {
      log.error(
        { detectedRole: role ?? "unknown" },
        "SUPABASE_SERVICE_ROLE_KEY is NOT a service_role key (role='" +
          (role ?? "unknown") +
          "'). Server-side writes to profiles (AniList/MAL linking, sync) will " +
          "silently fail under RLS. Set the service_role secret from Supabase " +
          "Dashboard > Project Settings > API in TatakaiAPI/.env.",
      );
    }
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    log.info({ keyRole: role ?? "unknown" }, "Supabase service client initialized");
  }
  return client;
}
