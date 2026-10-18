import { getSupabase } from "../lib/supabase.js";
import { log } from "../config/logger.js";
export function startTVPairingCleanup() {
  const timer = setInterval(async () => {
    try {
      const client = getSupabase();
      if (!client) return;
      const { error } = await client
        .from("tv_pairing_requests")
        .delete()
        .lt("expires_at", new Date().toISOString());
      if (error) log.warn("TV pairing expiry cleanup failed; it will retry.");
    } catch {
      log.warn("TV pairing expiry cleanup unavailable; it will retry.");
    }
  }, 60000);
  timer.unref();
  return () => clearInterval(timer);
}
