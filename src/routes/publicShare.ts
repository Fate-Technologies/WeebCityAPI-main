/**
 * Public, unauthenticated share-meta endpoints.
 *
 * The web server (scripts/ptero-start.mjs) is a static SPA host and social
 * crawlers do not run JS, so per-entity Open Graph / Twitter previews have to
 * be assembled server-side. This router is the single normalized source of
 * that data: parse an entity id → return one flat {title, description, image}
 * blob the web server injects into <head>.
 *
 * Reads run through the service-role client (RLS bypassed), so every endpoint
 * hard-filters to genuinely public/shareable rows and selects only shareable
 * columns. A non-public / missing entity returns 404, and the web server then
 * falls back to the default site meta — private data never leaks into a card.
 *
 * These are READ endpoints for crawlers: they must never call the view-count
 * RPCs (increment_forum_post_views / increment_tier_list_views) — a crawler
 * preview is not a human view.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import he from "he";
import { jsonOk } from "../lib/envelope.js";
import { getSupabase } from "../lib/supabase.js";
import { env } from "../config/env.js";
import { memoryCache } from "../lib/cache.js";
import * as catalog from "../services/catalog.js";
import * as mangaCatalog from "../services/mangaCatalog.js";
import type { TatakaiMedia } from "../types/tatakaiMedia.js";

const publicRouter = new Hono();

type ShareKind = "profile" | "anime" | "manga" | "post" | "tierlist" | "playlist";

interface ShareMeta {
  title: string;
  description: string;
  /** Absolute https image (native art or a generated-card URL). */
  image?: string;
  /** Wide (1.91:1-ish) variant — banners — when the entity has one. */
  imageWide?: string;
  kind: ShareKind;
  /** Site-relative canonical path, e.g. "/anime/anilist-21". */
  canonicalPath: string;
}

const API_ORIGIN = env.PUBLIC_API_ORIGIN.replace(/\/+$/, "");
/** Meta blobs are tiny and change rarely; keep them warm for 5 minutes. */
const SHARE_TTL_SEC = 300;

/** Strip HTML tags, decode entities, collapse whitespace, and truncate. */
function toPlainText(input: string | null | undefined, max = 200): string {
  if (!input) return "";
  const text = he.decode(String(input).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

/** Only surface absolute http(s) images — never a relative or data: path. */
function httpImage(url: string | null | undefined): string | undefined {
  const s = (url ?? "").trim();
  return /^https?:\/\//i.test(s) ? s : undefined;
}

/** URL for a generated branded card (the Hybrid "otherwise" branch, layer B). */
function ogCard(kind: "tierlist" | "playlist" | "post", id: string): string {
  return `${API_ORIGIN}/api/og/${kind}/${encodeURIComponent(id)}`;
}

/** Serve a share blob with a short crawler-friendly cache; 404 → default meta. */
function ok(c: Context, meta: ShareMeta) {
  c.header("Cache-Control", `public, max-age=${SHARE_TTL_SEC}, s-maxage=${SHARE_TTL_SEC}`);
  return c.json(jsonOk(meta));
}
function notShareable(c: Context) {
  return c.json({ success: false, data: null, error: "Not found" } as const, 404);
}

/** Cache a resolver's blob (or its null) so repeat crawler hits stay cheap. */
async function resolveCached(
  key: string,
  work: () => Promise<ShareMeta | null>,
): Promise<ShareMeta | null> {
  const hit = memoryCache.get(key);
  if (hit) return (hit.hit as ShareMeta | null) ?? null;
  const meta = await work();
  memoryCache.set(key, meta, SHARE_TTL_SEC);
  return meta;
}

// ---------------------------------------------------------------------------
// Anime — native cover/banner art (content services), no generated card.
// Mirrors the id dispatch in src/core/content/content-graph.ts getMedia:
// mal-/anilist- prefix → mal/anilist; uuid → tatakai id; bare numeric → anilist.
// ---------------------------------------------------------------------------
async function resolveAnimeMedia(rawId: string): Promise<TatakaiMedia | null> {
  const id = rawId.trim();
  const prefixed = id.match(/^(mal|anilist)[\-_:]?(\d+)$/i);
  if (prefixed?.[2]) {
    const numeric = Number(prefixed[2]);
    const hit =
      prefixed[1].toLowerCase() === "mal"
        ? await catalog.getMediaByMalId(numeric)
        : await catalog.getMediaByAnilistId(numeric);
    return hit?.media ?? null;
  }
  const hit = await catalog.resolveIdParam(id);
  return hit?.media ?? null;
}

function animeMeta(m: TatakaiMedia, rawId: string): ShareMeta {
  const title = m.titleEnglish || m.titleRomaji || "Anime";
  return {
    title: `${title} — Anime on Tatakai`,
    description: toPlainText(m.description) || `Track and discuss ${title} on Tatakai.`,
    image: httpImage(m.bannerImage) || httpImage(m.coverImageLarge),
    imageWide: httpImage(m.bannerImage),
    kind: "anime",
    canonicalPath: `/anime/${rawId}`,
  };
}

publicRouter.get("/share/anime/:id", async (c) => {
  const rawId = c.req.param("id");
  const meta = await resolveCached(`share:anime:${rawId}`, async () => {
    const media = await resolveAnimeMedia(rawId).catch(() => null);
    return media ? animeMeta(media, rawId) : null;
  });
  return meta ? ok(c, meta) : notShareable(c);
});

// ---------------------------------------------------------------------------
// Manga — native cover/banner art (manga services), no generated card.
// ---------------------------------------------------------------------------
async function resolveMangaMedia(rawId: string): Promise<TatakaiMedia | null> {
  const id = rawId.trim();
  const prefixed = id.match(/^(mal|anilist)[\-_:]?(\d+)$/i);
  const numeric = prefixed?.[2] ? Number(prefixed[2]) : Number(id);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  if (prefixed?.[1]?.toLowerCase() === "mal") {
    return (await mangaCatalog.getMangaByMalId(numeric)) ?? null;
  }
  return (await mangaCatalog.getMangaByAniListId(numeric)) ?? null;
}

function mangaMeta(m: TatakaiMedia, rawId: string): ShareMeta {
  const title = m.titleEnglish || m.titleRomaji || "Manga";
  return {
    title: `${title} — Manga on Tatakai`,
    description: toPlainText(m.description) || `Track and discuss ${title} on Tatakai.`,
    image: httpImage(m.bannerImage) || httpImage(m.coverImageLarge),
    imageWide: httpImage(m.bannerImage),
    kind: "manga",
    canonicalPath: `/manga/${rawId}`,
  };
}

publicRouter.get("/share/manga/:id", async (c) => {
  const rawId = c.req.param("id");
  const meta = await resolveCached(`share:manga:${rawId}`, async () => {
    const media = await resolveMangaMedia(rawId).catch(() => null);
    return media ? mangaMeta(media, rawId) : null;
  });
  return meta ? ok(c, meta) : notShareable(c);
});

// ---------------------------------------------------------------------------
// Profile — native avatar/banner art. Public profiles only (is_public).
// Looked up by `username`; two id spaces mean the row's own `id`/`user_id` are
// never mixed here — a plain username match is all the card needs.
// ---------------------------------------------------------------------------
publicRouter.get("/share/profile/:username", async (c) => {
  const username = c.req.param("username");
  const meta = await resolveCached(`share:profile:${username}`, async () => {
    const db = getSupabase();
    if (!db) return null;
    const { data } = await db
      .from("profiles")
      .select("username, display_name, avatar_url, banner_url, bio, is_public")
      .eq("username", username)
      .eq("is_public", true)
      .maybeSingle();
    if (!data) return null;
    const name = data.display_name || data.username || "User";
    return {
      title: `${name} on Tatakai`,
      description: toPlainText(data.bio) || `See ${name}'s anime profile on Tatakai.`,
      image: httpImage(data.banner_url) || httpImage(data.avatar_url),
      imageWide: httpImage(data.banner_url),
      kind: "profile",
      canonicalPath: `/user/${data.username}`,
    } satisfies ShareMeta;
  });
  return meta ? ok(c, meta) : notShareable(c);
});

// ---------------------------------------------------------------------------
// Forum post — native post image where present, else a generated card.
// Shareable = approved & non-NSFW. Never call increment_forum_post_views.
// ---------------------------------------------------------------------------
publicRouter.get("/share/post/:id", async (c) => {
  const id = c.req.param("id");
  const meta = await resolveCached(`share:post:${id}`, async () => {
    const db = getSupabase();
    if (!db) return null;
    const { data } = await db
      .from("forum_posts")
      .select("id, title, content, image_url, anime_poster, is_approved, is_nsfw")
      .eq("id", id)
      .eq("is_approved", true)
      .eq("is_nsfw", false)
      .maybeSingle();
    if (!data) return null;
    const title = data.title || "Community post";
    return {
      title: `${title} — Tatakai Community`,
      description: toPlainText(data.content) || "Join the conversation on Tatakai.",
      image: httpImage(data.image_url) || httpImage(data.anime_poster) || ogCard("post", data.id),
      kind: "post",
      canonicalPath: `/community/forum/${data.id}`,
    } satisfies ShareMeta;
  });
  return meta ? ok(c, meta) : notShareable(c);
});

// ---------------------------------------------------------------------------
// Tier list — generated card (no cover column). Public lists only.
// Never call increment_tier_list_views.
// ---------------------------------------------------------------------------
publicRouter.get("/share/tierlist/:shareCode", async (c) => {
  const shareCode = c.req.param("shareCode");
  const meta = await resolveCached(`share:tierlist:${shareCode}`, async () => {
    const db = getSupabase();
    if (!db) return null;
    const { data } = await db
      .from("tier_lists")
      .select("title, description, share_code, is_public")
      .eq("share_code", shareCode)
      .eq("is_public", true)
      .maybeSingle();
    if (!data) return null;
    const title = data.title || "Tier list";
    return {
      title: `${title} — Tatakai Tier List`,
      description: toPlainText(data.description) || `Check out this anime tier list on Tatakai.`,
      image: ogCard("tierlist", data.share_code),
      imageWide: ogCard("tierlist", data.share_code),
      kind: "tierlist",
      canonicalPath: `/tierlist/${data.share_code}`,
    } satisfies ShareMeta;
  });
  return meta ? ok(c, meta) : notShareable(c);
});

// ---------------------------------------------------------------------------
// Playlist — native cover where present, else a generated card. Public only.
// Resolve by share_slug first, then by uuid id.
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

publicRouter.get("/share/playlist/:slugOrId", async (c) => {
  const slugOrId = c.req.param("slugOrId");
  const meta = await resolveCached(`share:playlist:${slugOrId}`, async () => {
    const db = getSupabase();
    if (!db) return null;
    const cols = "id, name, description, share_description, cover_image, share_slug, is_public";
    let { data } = await db
      .from("playlists")
      .select(cols)
      .eq("share_slug", slugOrId)
      .eq("is_public", true)
      .maybeSingle();
    if (!data && UUID_RE.test(slugOrId)) {
      ({ data } = await db
        .from("playlists")
        .select(cols)
        .eq("id", slugOrId)
        .eq("is_public", true)
        .maybeSingle());
    }
    if (!data) return null;
    const name = data.name || "Playlist";
    const cardId = data.share_slug || data.id;
    return {
      title: `${name} — Tatakai Playlist`,
      description:
        toPlainText(data.share_description || data.description) ||
        `Watch this anime playlist on Tatakai.`,
      image: httpImage(data.cover_image) || ogCard("playlist", cardId),
      kind: "playlist",
      canonicalPath: data.share_slug ? `/p/${data.share_slug}` : `/playlist/${data.id}`,
    } satisfies ShareMeta;
  });
  return meta ? ok(c, meta) : notShareable(c);
});

export { publicRouter };
