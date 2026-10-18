/**
 * Discord webhook proxy — server-side forwarding of client-initiated embeds.
 *
 * The frontend's discord-webhook.ts POSTs embeds to `/api/v3/webhooks/discord`
 * with a `channel` field mapping to one of the configured DISCORD_WEBHOOK_*
 * env vars. This router reads those secrets (never exposed client-side) and
 * forwards the embed to Discord's actual webhook URL. Any non-200 from Discord
 * or a missing webhook URL for the requested channel returns an error the
 * client logs (but does not surface to users — webhook delivery is best-effort).
 *
 * Channels: user_created, error_logs, comment, review_popup, status.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { env } from "../config/env.js";
import { jsonOk, jsonError } from "../lib/envelope.js";

const webhooksRouter = new Hono();

type DiscordChannel =
  | "user_created"
  | "error_logs"
  | "comment"
  | "review_popup"
  | "status";

const CHANNEL_TO_ENV: Record<DiscordChannel, string> = {
  user_created: env.DISCORD_WEBHOOK_USER_CREATED,
  error_logs: env.DISCORD_WEBHOOK_ERROR_LOGS,
  comment: env.DISCORD_WEBHOOK_COMMENT,
  review_popup: env.DISCORD_WEBHOOK_REVIEW_POPUP,
  status: env.DISCORD_WEBHOOK_STATUS,
};

/**
 * POST /discord — forward a Discord embed to the configured webhook URL.
 * Body: { channel: DiscordChannel, embeds: [...], username?, avatar_url? }
 */
webhooksRouter.post("/discord", async (c: Context) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json(jsonError("invalid JSON body"), 400);
  }

  const { channel, embeds, username, avatar_url } = body ?? {};
  if (!channel || typeof channel !== "string") {
    return c.json(jsonError("missing or invalid channel"), 400);
  }
  if (!Array.isArray(embeds) || embeds.length === 0) {
    return c.json(jsonError("embeds must be a non-empty array"), 400);
  }

  const webhookUrl = CHANNEL_TO_ENV[channel as DiscordChannel];
  if (!webhookUrl) {
    // Webhook URL not configured for this channel → log but return 200 so
    // the client doesn't retry (it's a config issue, not a transient failure).
    console.warn(`[webhooks] Discord webhook URL not configured for channel "${channel}"`);
    return c.json(jsonOk({ skipped: true, reason: "webhook_not_configured" }));
  }

  // Forward to Discord with the same payload shape the client sent.
  const payload: Record<string, unknown> = { embeds };
  if (username) payload.username = username;
  if (avatar_url) payload.avatar_url = avatar_url;

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[webhooks] Discord API returned ${res.status} for channel "${channel}":`, text);
      return c.json(jsonError(`Discord API error: ${res.status}`), 502);
    }

    return c.json(jsonOk({ delivered: true }));
  } catch (err: any) {
    console.error(`[webhooks] Failed to reach Discord for channel "${channel}":`, err?.message || err);
    return c.json(jsonError("failed to forward webhook"), 502);
  }
});

export { webhooksRouter };
