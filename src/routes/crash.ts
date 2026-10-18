/**
 * POST /api/v3/crash — desktop crash-report ingestion.
 *
 * The Electron main process auto-forwards crash METADATA ONLY (no minidumps,
 * no PII) on next launch (see desktop/services/crash-service.cjs). This route
 * fans the metadata out to both sinks, server-side:
 *   1. persists it into the `crash_reports` table via the service-role client
 *      so the admin panel can read historical crashes (RLS: STAFF SELECT,
 *      insert via service role only — see the crash_reports migration); and
 *   2. posts a crash embed to the CRASH_DISCORD_WEBHOOK (best-effort).
 * Both live here so the Discord webhook secret is never shipped to clients.
 *
 * Public POST (v3 uses optionalCatalogAuth): the desktop app is unauthenticated
 * at crash time. We accept only the small, fixed metadata shape below and never
 * echo anything back beyond an ack, so this cannot be used to read data.
 */
import { Hono } from "hono";
import { jsonOk, jsonError } from "../lib/envelope.js";
import { getSupabase } from "../lib/supabase.js";
import { env } from "../config/env.js";
import { log } from "../config/logger.js";

export const crashRouter = new Hono();

/** Trim to a bounded string so a malformed payload can't bloat the row. */
function str(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

type CrashRow = {
  crash_id: string;
  crashed_at: string;
  app_version: string | null;
  platform: string | null;
  arch: string | null;
  node_version: string | null;
  electron_version: string | null;
};

/**
 * Post a crash embed to the configured Discord webhook. Server-side so the
 * webhook secret never ships to clients. Best-effort — never throws, never
 * blocks the response (a failed forward must not fail the crash ingest).
 */
async function forwardToDiscord(row: CrashRow): Promise<void> {
  const webhook = env.CRASH_DISCORD_WEBHOOK?.trim();
  if (!webhook) return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        username: "Tatakai Crash Reporter",
        embeds: [
          {
            title: "💥 Desktop crash detected",
            color: 0xef4444,
            fields: [
              { name: "Crash ID", value: row.crash_id, inline: false },
              { name: "Time", value: row.crashed_at, inline: false },
              { name: "Version", value: row.app_version ?? "unknown", inline: true },
              { name: "Platform", value: `${row.platform ?? "?"}/${row.arch ?? "?"}`, inline: true },
              { name: "Electron", value: row.electron_version ?? "unknown", inline: true },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    clearTimeout(timeout);
    if (!res.ok) log.warn({ status: res.status }, "crash Discord forward returned non-2xx");
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "crash Discord forward failed");
  }
}

crashRouter.post("/", async (c) => {
  let payload: Record<string, unknown>;
  try {
    payload = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json(jsonError("invalid JSON body"), 400);
  }

  const crashId = str(payload.id);
  if (!crashId) return c.json(jsonError("missing crash id"), 400);

  const row: CrashRow = {
    crash_id: crashId,
    crashed_at: str(payload.date) ?? new Date().toISOString(),
    app_version: str(payload.app_version, 40),
    platform: str(payload.platform, 40),
    arch: str(payload.arch, 40),
    node_version: str(payload.node_version, 40),
    electron_version: str(payload.electron_version, 40),
  };

  // Forward to Discord regardless of DB availability so a crash is always
  // reported. Fire-and-forget: the ingest response never waits on the webhook.
  void forwardToDiscord(row);

  const supabase = getSupabase();
  if (!supabase) {
    // No DB configured — accept the report so the client stops retrying, but
    // make clear it was not persisted.
    log.warn({ crashId }, "crash report received but Supabase is not configured");
    return c.json(jsonOk({ persisted: false }, { note: "supabase not configured" }));
  }

  const { error } = await supabase.from("crash_reports").insert(row);
  if (error) {
    log.error({ crashId, error: error.message }, "failed to insert crash report");
    return c.json(jsonError("failed to persist crash report"), 500);
  }

  return c.json(jsonOk({ persisted: true }));
});
