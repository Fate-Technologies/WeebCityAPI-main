/**
 * XML sitemaps for crawlers — served from the web origin via the preview
 * plugin's proxy (scripts/seo/vite-seo-preview.mjs) or linked directly in
 * robots.txt.
 *
 * "Everything we can enumerate": the anime & manga catalogue comes from the
 * Tiger DB mirror (Prisma `Media`), and public profiles / tier lists / playlists /
 * approved forum posts from Supabase. A sitemap *index* (`/sitemap.xml`) points
 * at paginated child sitemaps, each capped at SITEMAP_MAX_URLS (Google's 50k/file limit).
 *
 * Styled via `sitemap.xsl` for modern human-readable presentation in browsers
 * while maintaining 100% search crawler compatibility.
 *
 * Children:
 *   /sitemap-static.xml            — hub pages (home, search, trending, legal, …)
 *   /sitemap-anime-<n>.xml         — /anime/anilist-<id> for every ANIME row
 *   /sitemap-manga-<n>.xml         — /manga/anilist-<id> for every MANGA row
 *   /sitemap-profiles.xml          — /user/<username> for public profiles
 *   /sitemap-tierlists.xml         — /tierlist/<share_code> for public tier lists
 *   /sitemap-playlists.xml         — /p/<share_slug> or /playlist/<id> for public playlists
 *   /sitemap-posts.xml             — /community/forum/<id> for public approved posts
 *   /sitemap.xsl                   — XSLT stylesheet for browser rendering
 *
 * Watch/reader routes are intentionally excluded (per product decision: index
 * the anime *info* page, never /watch/:episodeId). Everything is cached in the
 * in-memory TTL cache; a slow/large query never blocks a page.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { prisma } from "../mirror/db.js";
import { getSupabase } from "../lib/supabase.js";
import { env } from "../config/env.js";
import { memoryCache, coalesce } from "../lib/cache.js";
import { XSL_STYLESHEET } from "./sitemapXsl.js";

const sitemapRouter = new Hono();

/** get-or-compute wrapper over MemoryCache (which only exposes get/set). */
async function cached<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T> {
  const hit = memoryCache.get<T>(key);
  if (hit) return hit.hit;
  return coalesce(key, async () => {
    const value = await fn();
    memoryCache.set(key, value, ttlSec);
    return value;
  });
}

type ChildResult = { xml: string; ok: boolean };

/** Like cached(), but a failed build is only cached for FAIL_TTL_SEC. */
async function cachedResult(
  key: string,
  fn: () => Promise<ChildResult>,
): Promise<ChildResult> {
  const hit = memoryCache.get<ChildResult>(key);
  if (hit) return hit.hit;
  return coalesce(key, async () => {
    const value = await fn();
    memoryCache.set(key, value, value.ok ? TTL_SEC : FAIL_TTL_SEC);
    return value;
  });
}

const SITE = env.PUBLIC_SITE_ORIGIN.replace(/\/+$/, "");
const SITEMAP_MAX_URLS = 45000; // under Google's 50k hard limit, with headroom
const TTL_SEC = 6 * 60 * 60; // 6h — the catalogue changes slowly
const FAIL_TTL_SEC = 60; // transient DB failure: retry soon, don't poison the cache for 6h
const PROFILE_CAP = 45000;

function esc(v: string): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface UrlEntry {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: string;
}

function renderUrlset(entries: UrlEntry[]): string {
  const body = entries
    .map((e) => {
      const parts = [`    <loc>${esc(e.loc)}</loc>`];
      if (e.lastmod) parts.push(`    <lastmod>${esc(e.lastmod)}</lastmod>`);
      if (e.changefreq) parts.push(`    <changefreq>${e.changefreq}</changefreq>`);
      if (e.priority) parts.push(`    <priority>${e.priority}</priority>`);
      return `  <url>\n${parts.join("\n")}\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<?xml-stylesheet type="text/xsl" href="/sitemap.xsl"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function renderIndex(locs: string[]): string {
  const now = new Date().toISOString().slice(0, 10);
  const body = locs
    .map((loc) => `  <sitemap>\n    <loc>${esc(loc)}</loc>\n    <lastmod>${now}</lastmod>\n  </sitemap>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<?xml-stylesheet type="text/xsl" href="/sitemap.xsl"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}

function sendXml(c: Context, xml: string, status: ContentfulStatusCode = 200) {
  c.header("Content-Type", "application/xml; charset=utf-8");
  c.header("Cache-Control", status === 200 ? `public, max-age=${TTL_SEC}` : "no-store");
  if (status === 503) c.header("Retry-After", "300");
  return c.body(xml, status);
}

/** Valid-but-empty urlset: parses as XML so crawlers retry on 503 instead of flagging "Sitemap is HTML". */
function emptyUrlset(): string {
  return renderUrlset([]);
}

/** 503 + valid XML for a child whose data source failed (DB down, timeout). */
function sendUnavailable(c: Context) {
  return sendXml(c, emptyUrlset(), 503);
}

/** Cached count of Media rows for a type. */
async function mediaCount(type: "ANIME" | "MANGA"): Promise<number> {
  return cached(`sitemap:count:${type}`, TTL_SEC, async () => {
    try {
      return await prisma.media.count({ where: { type } });
    } catch {
      return 0;
    }
  });
}

/** Fast check whether a Supabase table contains any eligible rows. */
async function supabaseHasRows(
  table: string,
  filterFn?: (query: any) => any,
): Promise<boolean> {
  return cached(`sitemap:has:${table}`, TTL_SEC, async () => {
    try {
      const db = getSupabase();
      if (!db) return false;
      let q = db.from(table).select("id", { count: "exact", head: true });
      if (filterFn) q = filterFn(q);
      const { count } = await q;
      return Boolean(count && count > 0);
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Stylesheet for browser rendering
// ---------------------------------------------------------------------------
sitemapRouter.get("/sitemap.xsl", (c) => {
  c.header("Content-Type", "text/xsl; charset=utf-8");
  c.header("Cache-Control", `public, max-age=${TTL_SEC}`);
  return c.body(XSL_STYLESHEET);
});

// ---------------------------------------------------------------------------
// Sitemap index
// ---------------------------------------------------------------------------
sitemapRouter.get("/sitemap.xml", async (c) => {
  const xml = await cached("sitemap:index", TTL_SEC, async () => {
    const locs: string[] = [`${SITE}/sitemap-static.xml`];

    const animeCount = await mediaCount("ANIME");
    const mangaCount = await mediaCount("MANGA");
    // Only advertise a child that will actually contain URLs. Advertising an
    // empty sitemap-anime-1.xml (count 0, e.g. mirror DB unreachable) makes
    // Search Console show "1 error, 0 discovered URLs" for that child.
    const animePages = Math.ceil(animeCount / SITEMAP_MAX_URLS);
    const mangaPages = Math.ceil(mangaCount / SITEMAP_MAX_URLS);
    if (animeCount > 0) {
      for (let i = 1; i <= animePages; i++) locs.push(`${SITE}/sitemap-anime-${i}.xml`);
    }
    if (mangaCount > 0) {
      for (let i = 1; i <= mangaPages; i++) locs.push(`${SITE}/sitemap-manga-${i}.xml`);
    }

    const [hasProfiles, hasTierlists, hasPlaylists, hasPosts] = await Promise.all([
      supabaseHasRows("profiles", (q) => q.eq("is_public", true).not("username", "is", null)),
      supabaseHasRows("tier_lists", (q) => q.eq("is_public", true).not("share_code", "is", null)),
      supabaseHasRows("playlists", (q) => q.eq("is_public", true)),
      supabaseHasRows("forum_posts", (q) => q.eq("is_approved", true).eq("is_nsfw", false)),
    ]);

    if (hasProfiles) locs.push(`${SITE}/sitemap-profiles.xml`);
    if (hasTierlists) locs.push(`${SITE}/sitemap-tierlists.xml`);
    if (hasPlaylists) locs.push(`${SITE}/sitemap-playlists.xml`);
    if (hasPosts) locs.push(`${SITE}/sitemap-posts.xml`);

    return renderIndex(locs);
  });
  return sendXml(c, xml);
});

// ---------------------------------------------------------------------------
// Static hub pages
// ---------------------------------------------------------------------------
sitemapRouter.get("/sitemap-static.xml", (c) => {
  const now = new Date().toISOString().slice(0, 10);
  const hubs: Array<[string, string, string]> = [
    ["/", "daily", "1.0"],
    ["/search", "weekly", "0.8"],
    ["/trending", "daily", "0.9"],
    ["/manga", "daily", "0.9"],
    ["/calendar", "daily", "0.7"],
    ["/community", "daily", "0.8"],
    ["/extensions", "weekly", "0.6"],
    ["/genre", "weekly", "0.6"],
    ["/welcome", "monthly", "0.7"],
    ["/download", "monthly", "0.7"],
    ["/terms", "monthly", "0.3"],
    ["/privacy", "monthly", "0.3"],
    ["/dmca", "monthly", "0.3"],
    ["/community/guidelines", "monthly", "0.3"],
  ];
  const entries: UrlEntry[] = hubs.map(([path, changefreq, priority]) => ({
    loc: `${SITE}${path}`,
    lastmod: now,
    changefreq,
    priority,
  }));
  return sendXml(c, renderUrlset(entries));
});

// ---------------------------------------------------------------------------
// Catalogue: anime / manga from the Tiger DB mirror
// ---------------------------------------------------------------------------
async function catalogSitemap(
  type: "ANIME" | "MANGA",
  page: number,
): Promise<{ xml: string; ok: boolean }> {
  const prefix = type === "ANIME" ? "anime" : "manga";
  return cachedResult(`sitemap:${prefix}:${page}`, async () => {
    let rows: Array<{ id: number; updatedAt: number | null }> = [];
    try {
      rows = await prisma.media.findMany({
        where: { type },
        select: { id: true, updatedAt: true },
        orderBy: { id: "asc" },
        skip: (page - 1) * SITEMAP_MAX_URLS,
        take: SITEMAP_MAX_URLS,
      });
    } catch (err) {
      // Mirror DB unreachable: signal failure so the route answers 503+XML
      // (crawlers retry) instead of 200-empty (crawlers de-index every URL).
      console.warn(`[sitemap] ${type} page ${page}: query failed`, (err as Error)?.message);
      return { xml: emptyUrlset(), ok: false };
    }
    if (rows.length === 0) {
      // Visible in server logs so an empty catalogue (mirror DB unseeded) is
      // caught without waiting for a Search Console round-trip.
      console.warn(`[sitemap] ${type} page ${page}: 0 rows (mirror empty or unreachable)`);
    }
    const entries: UrlEntry[] = rows.map((r) => ({
      loc: `${SITE}/${prefix}/anilist-${r.id}`,
      lastmod: r.updatedAt ? new Date(r.updatedAt * 1000).toISOString().slice(0, 10) : undefined,
      changefreq: "weekly",
      priority: "0.6",
    }));
    return { xml: renderUrlset(entries), ok: true };
  });
}

sitemapRouter.get("/:file{sitemap-anime-\\d+\\.xml}", async (c) => {
  const match = c.req.param("file").match(/sitemap-anime-(\d+)\.xml/);
  const page = Math.max(1, Number(match?.[1]) || 1);
  const { xml, ok } = await catalogSitemap("ANIME", page);
  return ok ? sendXml(c, xml) : sendUnavailable(c);
});

sitemapRouter.get("/:file{sitemap-manga-\\d+\\.xml}", async (c) => {
  const match = c.req.param("file").match(/sitemap-manga-(\d+)\.xml/);
  const page = Math.max(1, Number(match?.[1]) || 1);
  const { xml, ok } = await catalogSitemap("MANGA", page);
  return ok ? sendXml(c, xml) : sendUnavailable(c);
});

// ---------------------------------------------------------------------------
// Public profiles / tier lists / playlists / posts from Supabase
//
// Every child catches its own query failure and answers 503 + valid (empty)
// XML so crawlers retry. Letting the error propagate would hit Hono's onError
// (500 JSON) — a non-XML sitemap response is exactly what Search Console
// reports as "Sitemap is HTML".
// ---------------------------------------------------------------------------
async function supabaseChild(
  key: string,
  build: (db: NonNullable<ReturnType<typeof getSupabase>>) => Promise<string>,
): Promise<{ xml: string; ok: boolean }> {
  return cachedResult(key, async () => {
    try {
      const db = getSupabase();
      if (!db) return { xml: emptyUrlset(), ok: false };
      return { xml: await build(db), ok: true };
    } catch (err) {
      console.warn(`[sitemap] ${key}: query failed`, (err as Error)?.message);
      return { xml: emptyUrlset(), ok: false };
    }
  });
}

sitemapRouter.get("/sitemap-profiles.xml", async (c) => {
  const { xml, ok } = await supabaseChild("sitemap:profiles", async (db) => {
    const { data, error } = await db
      .from("profiles")
      .select("username, updated_at")
      .eq("is_public", true)
      .not("username", "is", null)
      .limit(PROFILE_CAP);
    if (error) throw error;
    const entries: UrlEntry[] = (data || [])
      .filter((p: any) => p.username)
      .map((p: any) => ({
        loc: `${SITE}/user/${encodeURIComponent(p.username)}`,
        lastmod: p.updated_at ? String(p.updated_at).slice(0, 10) : undefined,
        changefreq: "weekly",
        priority: "0.5",
      }));
    return renderUrlset(entries);
  });
  return ok ? sendXml(c, xml) : sendUnavailable(c);
});

sitemapRouter.get("/sitemap-tierlists.xml", async (c) => {
  const { xml, ok } = await supabaseChild("sitemap:tierlists", async (db) => {
    const { data, error } = await db
      .from("tier_lists")
      .select("share_code, updated_at")
      .eq("is_public", true)
      .not("share_code", "is", null)
      .limit(PROFILE_CAP);
    if (error) throw error;
    const entries: UrlEntry[] = (data || [])
      .filter((t: any) => t.share_code)
      .map((t: any) => ({
        loc: `${SITE}/tierlist/${encodeURIComponent(t.share_code)}`,
        lastmod: t.updated_at ? String(t.updated_at).slice(0, 10) : undefined,
        changefreq: "weekly",
        priority: "0.5",
      }));
    return renderUrlset(entries);
  });
  return ok ? sendXml(c, xml) : sendUnavailable(c);
});

sitemapRouter.get("/sitemap-playlists.xml", async (c) => {
  const { xml, ok } = await supabaseChild("sitemap:playlists", async (db) => {
    const { data, error } = await db
      .from("playlists")
      .select("id, share_slug, updated_at")
      .eq("is_public", true)
      .limit(PROFILE_CAP);
    if (error) throw error;
    const entries: UrlEntry[] = (data || []).map((p: any) => ({
      loc: p.share_slug
        ? `${SITE}/p/${encodeURIComponent(p.share_slug)}`
        : `${SITE}/playlist/${encodeURIComponent(p.id)}`,
      lastmod: p.updated_at ? String(p.updated_at).slice(0, 10) : undefined,
      changefreq: "weekly",
        priority: "0.5",
      }));
    return renderUrlset(entries);
  });
  return ok ? sendXml(c, xml) : sendUnavailable(c);
});

sitemapRouter.get("/sitemap-posts.xml", async (c) => {
  const { xml, ok } = await supabaseChild("sitemap:posts", async (db) => {
    const { data, error } = await db
      .from("forum_posts")
      .select("id, updated_at")
      .eq("is_approved", true)
      .eq("is_nsfw", false)
      .limit(PROFILE_CAP);
    if (error) throw error;
    const entries: UrlEntry[] = (data || [])
      .filter((p: any) => p.id)
      .map((p: any) => ({
        loc: `${SITE}/community/forum/${encodeURIComponent(p.id)}`,
        lastmod: p.updated_at ? String(p.updated_at).slice(0, 10) : undefined,
        changefreq: "weekly",
        priority: "0.6",
      }));
    return renderUrlset(entries);
  });
  return ok ? sendXml(c, xml) : sendUnavailable(c);
});

// ---------------------------------------------------------------------------
// Health: row counts behind each child, so an empty catalogue (mirror DB
// unreachable / unseeded, or zero public rows) is visible in seconds instead
// of after a Search Console round-trip. Not part of the sitemap index.
// ---------------------------------------------------------------------------
sitemapRouter.get("/sitemap-health", async (c) => {
  const [animeCount, mangaCount, hasProfiles, hasTierlists, hasPlaylists, hasPosts] =
    await Promise.all([
      mediaCount("ANIME"),
      mediaCount("MANGA"),
      supabaseHasRows("profiles", (q) => q.eq("is_public", true).not("username", "is", null)),
      supabaseHasRows("tier_lists", (q) => q.eq("is_public", true).not("share_code", "is", null)),
      supabaseHasRows("playlists", (q) => q.eq("is_public", true)),
      supabaseHasRows("forum_posts", (q) => q.eq("is_approved", true).eq("is_nsfw", false)),
    ]);
  return c.json({
    success: true,
    data: {
      animeCount,
      mangaCount,
      animePages: Math.ceil(animeCount / SITEMAP_MAX_URLS),
      mangaPages: Math.ceil(mangaCount / SITEMAP_MAX_URLS),
      hasProfiles,
      hasTierlists,
      hasPlaylists,
      hasPosts,
    },
  });
});

export { sitemapRouter };
