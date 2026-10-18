import { Hono } from "hono";
import { z } from "zod";
import { jsonOk, jsonError } from "../../lib/envelope.js";
import { getSupabase } from "../../lib/supabase.js";
import { requireSupabaseAdmin, type AdminEnv } from "../../middleware/auth.js";
import { env } from "../../config/env.js";
import { log } from "../../config/logger.js";
import { generateSlug, normalizeLink } from "../../services/news/generateSlug.js";
import { ingestNews } from "../../services/news/ingest.js";

/**
 * Admin news composer route. Authors a News post as the Tatakai News bot
 * (NEWS_BOT_USER_ID) via the service-role client — a browser can't insert a
 * forum_posts row owned by another user under RLS, so the write must happen
 * here. The caller is verified as staff by requireSupabaseAdmin (Supabase JWT
 * → profiles.is_admin), NOT by a client-shipped secret.
 *
 * The row shape mirrors the newsRefresh job's toPost() so manual and
 * aggregated posts render identically and dedup on the same metadata.news_link.
 */

const r = new Hono<AdminEnv>();
r.use("*", requireSupabaseAdmin);

const bodySchema = z.object({
  title: z.string().trim().min(3).max(300),
  content: z.string().trim().min(1).max(20000),
  excerpt: z.string().trim().max(2000).optional(),
  image_url: z.string().trim().url().max(2000).optional().or(z.literal("")),
  link: z.string().trim().url().max(2000).optional().or(z.literal("")),
  source: z.string().trim().max(120).optional(),
  tags: z.array(z.string().trim().max(60)).max(20).optional(),
  published_at: z.string().datetime().optional(),
  is_pinned: z.boolean().optional(),
});

r.post("/", async (c) => {
  const botId = env.NEWS_BOT_USER_ID.trim();
  if (!botId) return c.json(jsonError("News bot not configured (NEWS_BOT_USER_ID unset)"), 503);

  const sb = getSupabase();
  if (!sb) return c.json(jsonError("Supabase not configured"), 503);

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(jsonError("Invalid JSON body"), 400);
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(jsonError(parsed.error.issues[0]?.message || "Invalid request"), 400);
  }
  const b = parsed.data;

  const source = (b.source || "Tatakai").trim() || "Tatakai";
  const link = (b.link || "").trim();
  const publishedAt = b.published_at || new Date().toISOString();
  const slug = generateSlug(b.title, source);
  // Dedup key: same normalized link the ingestion job uses when a URL is given,
  // else a stable manual: key so re-posting the same title/source is caught too.
  const newsLink = link ? normalizeLink(link) : `manual:${slug}`;

  const { data: existing, error: dupErr } = await sb
    .from("forum_posts")
    .select("id")
    .eq("user_id", botId)
    .eq("flair", "News")
    .eq("metadata->>news_link", newsLink)
    .maybeSingle();
  if (dupErr) {
    log.error({ error: dupErr.message }, "admin news dedup check failed");
    return c.json(jsonError("Dedup check failed"), 500);
  }
  if (existing?.id) {
    return c.json(jsonError("A news post with this link already exists"), 409);
  }

  const row = {
    user_id: botId,
    title: b.title.slice(0, 300),
    content: b.content,
    content_type: link ? "link" : "text",
    flair: "News",
    is_approved: true,
    is_pinned: b.is_pinned === true,
    image_url: (b.image_url || "").trim() || null,
    created_at: publishedAt,
    metadata: {
      news_link: newsLink,
      news_url: link || null,
      source,
      excerpt: b.excerpt || null,
      tags: b.tags || [],
      published_at: publishedAt,
      news_slug: slug,
      manual: true,
      authored_by_admin: c.get("adminUserId"),
    },
  };

  const { data, error } = await sb.from("forum_posts").insert(row).select().single();
  if (error) {
    log.error({ error: error.message }, "admin news insert failed");
    return c.json(jsonError(error.message), 400);
  }

  log.info({ id: data?.id, admin: c.get("adminUserId") }, "admin news post created");
  return c.json(jsonOk(data), 201);
});

/**
 * Run one ingestion pass now (aggregate upstream sources → dedup → insert as
 * bot posts). Same routine the CLI job uses; lets an admin pull fresh stories
 * without waiting for the external scheduler.
 */
r.post("/refresh", async (c) => {
  const botId = env.NEWS_BOT_USER_ID.trim();
  if (!botId) return c.json(jsonError("News bot not configured (NEWS_BOT_USER_ID unset)"), 503);

  const sb = getSupabase();
  if (!sb) return c.json(jsonError("Supabase not configured"), 503);

  try {
    const result = await ingestNews(sb, botId);
    log.info({ ...result, admin: c.get("adminUserId") }, "admin news refresh");
    return c.json(jsonOk(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : "News refresh failed";
    log.error({ error: message }, "admin news refresh failed");
    return c.json(jsonError(message), 502);
  }
});

/** List bot-authored News posts (newest first, paginated) for management. */
r.get("/", async (c) => {
  const botId = env.NEWS_BOT_USER_ID.trim();
  if (!botId) return c.json(jsonError("News bot not configured (NEWS_BOT_USER_ID unset)"), 503);

  const sb = getSupabase();
  if (!sb) return c.json(jsonError("Supabase not configured"), 503);

  const perPage = Math.min(Math.max(Number(c.req.query("limit")) || 30, 1), 100);
  const page = Math.max(Number(c.req.query("page")) || 1, 1);
  const from = (page - 1) * perPage;

  const { data, error, count } = await sb
    .from("forum_posts")
    .select("id, title, content, image_url, is_pinned, created_at, metadata", { count: "exact" })
    .eq("user_id", botId)
    .eq("flair", "News")
    .order("is_pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .range(from, from + perPage - 1);

  if (error) {
    log.error({ error: error.message }, "admin news list failed");
    return c.json(jsonError(error.message), 500);
  }

  const total = count ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  return c.json(jsonOk(data ?? [], { page, perPage, total, lastPage, hasNextPage: page < lastPage }));
});

const patchSchema = z.object({ is_pinned: z.boolean() });

/** Pin / unpin a bot News post. */
r.patch("/:id", async (c) => {
  const botId = env.NEWS_BOT_USER_ID.trim();
  if (!botId) return c.json(jsonError("News bot not configured (NEWS_BOT_USER_ID unset)"), 503);

  const sb = getSupabase();
  if (!sb) return c.json(jsonError("Supabase not configured"), 503);

  const id = c.req.param("id");
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(jsonError("Invalid JSON body"), 400);
  }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) return c.json(jsonError(parsed.error.issues[0]?.message || "Invalid request"), 400);

  const { data, error } = await sb
    .from("forum_posts")
    .update({ is_pinned: parsed.data.is_pinned })
    .eq("id", id)
    .eq("user_id", botId)
    .eq("flair", "News")
    .select("id, is_pinned")
    .maybeSingle();

  if (error) {
    log.error({ error: error.message }, "admin news pin failed");
    return c.json(jsonError(error.message), 400);
  }
  if (!data) return c.json(jsonError("News post not found"), 404);
  return c.json(jsonOk(data));
});

/** Delete a bot News post. */
r.delete("/:id", async (c) => {
  const botId = env.NEWS_BOT_USER_ID.trim();
  if (!botId) return c.json(jsonError("News bot not configured (NEWS_BOT_USER_ID unset)"), 503);

  const sb = getSupabase();
  if (!sb) return c.json(jsonError("Supabase not configured"), 503);

  const id = c.req.param("id");
  const { data, error } = await sb
    .from("forum_posts")
    .delete()
    .eq("id", id)
    .eq("user_id", botId)
    .eq("flair", "News")
    .select("id")
    .maybeSingle();

  if (error) {
    log.error({ error: error.message }, "admin news delete failed");
    return c.json(jsonError(error.message), 400);
  }
  if (!data) return c.json(jsonError("News post not found"), 404);
  log.info({ id, admin: c.get("adminUserId") }, "admin news post deleted");
  return c.json(jsonOk({ id }));
});

export { r as adminNewsRouter };
