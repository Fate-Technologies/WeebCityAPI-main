/**
 * Generated Open Graph cards (1200×630 PNG) — the "otherwise" branch of the
 * Hybrid image strategy. Anime / manga / profile use their native art; tier
 * lists, playlists and posts (which have no single strong image) get a branded
 * card rendered here: title + subtitle + Tatakai wordmark over a brand gradient,
 * with a best-effort strip of real thumbnails composited in.
 *
 * Pure Node, no headless browser: satori (JSX-object tree → SVG) + @resvg/resvg-js
 * (SVG → PNG). Crawlers reject SVG og:images, so PNG rasterization is required.
 *
 * Like the share endpoints, these are crawler reads: public rows only, and never
 * the view-count RPCs.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { getSupabase } from "../lib/supabase.js";
import { memoryCache } from "../lib/cache.js";
import { log } from "../config/logger.js";

const ogRouter = new Hono();

const WIDTH = 1200;
const HEIGHT = 630;
const BRAND = "#6366f1";
const BG_FROM = "#0b0b12";
const BG_TO = "#1a1730";
/** Rendered PNGs are ~50–120 KB; cache a day, they change rarely. */
const OG_TTL_SEC = 60 * 60 * 24;

// --- Fonts ------------------------------------------------------------------
// Satori needs real font buffers. Rather than commit a binary TTF, fetch Inter
// from Google Fonts once (with a legacy UA so Google serves TTF, not WOFF2 —
// satori can't parse WOFF2) and cache the buffers for the process lifetime.
type SatoriFont = { name: string; data: ArrayBuffer; weight: 400 | 700; style: "normal" };
let fontsPromise: Promise<SatoriFont[]> | null = null;

async function fetchTtf(weight: 400 | 700): Promise<ArrayBuffer> {
  const cssUrl = `https://fonts.googleapis.com/css2?family=Inter:wght@${weight}`;
  const cssRes = await fetch(cssUrl, {
    headers: {
      // Ancient UA → Google returns a TTF `src: url(...)` instead of WOFF2.
      "User-Agent":
        "Mozilla/5.0 (Windows NT 5.1; rv:1.9) Gecko/20100101 Firefox/3.5",
    },
  });
  const css = await cssRes.text();
  const match = css.match(/src:\s*url\((https:\/\/[^)]+\.ttf)\)/i);
  if (!match) throw new Error(`no ttf url in google fonts css (weight ${weight})`);
  const fontRes = await fetch(match[1]);
  return fontRes.arrayBuffer();
}

async function loadFonts(): Promise<SatoriFont[]> {
  if (!fontsPromise) {
    fontsPromise = Promise.all([fetchTtf(400), fetchTtf(700)])
      .then(([regular, bold]) => [
        { name: "Inter", data: regular, weight: 400, style: "normal" } as SatoriFont,
        { name: "Inter", data: bold, weight: 700, style: "normal" } as SatoriFont,
      ])
      .catch((err) => {
        // Reset so the next request can retry rather than caching the failure.
        fontsPromise = null;
        throw err;
      });
  }
  return fontsPromise;
}

// --- Thumbnails -------------------------------------------------------------
// Satori does not fetch remote images, so pull them server-side and inline as
// data URIs. Best-effort: a slow/broken thumb is dropped, never fatal.
async function toDataUri(url: string): Promise<string | null> {
  try {
    if (!/^https?:\/\//i.test(url)) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "image/jpeg";
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > 3_000_000) return null;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

async function collectThumbs(urls: Array<string | null | undefined>, max = 5): Promise<string[]> {
  const seen = new Set<string>();
  const picks: string[] = [];
  for (const u of urls) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    picks.push(u);
    if (picks.length >= max) break;
  }
  const resolved = await Promise.all(picks.map(toDataUri));
  return resolved.filter((x): x is string => Boolean(x));
}

// --- Card rendering ---------------------------------------------------------
// Satori accepts a plain JSX-object tree ({ type, props }), so this .ts file
// builds one directly — no TSX/React needed. Every multi-child node must set
// display:flex (satori is strict about that).
type Node = { type: string; props: Record<string, unknown> };
function el(type: string, style: Record<string, unknown>, children?: unknown): Node {
  return { type, props: children === undefined ? { style } : { style, children } };
}

function clamp(s: string, max: number): string {
  const t = (s || "").trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

interface CardOpts {
  kicker: string;
  title: string;
  subtitle?: string;
  thumbs: string[];
}

async function renderCard(opts: CardOpts): Promise<Buffer> {
  const fonts = await loadFonts();

  const thumbNodes: Node[] = opts.thumbs.slice(0, 5).map((src) => ({
    type: "img",
    props: {
      src,
      width: 156,
      height: 220,
      style: {
        width: 156,
        height: 220,
        borderRadius: 14,
        objectFit: "cover",
        border: "2px solid rgba(255,255,255,0.10)",
      },
    },
  }));

  const headerChildren: Node[] = [
    el("div", {
      fontSize: 26,
      fontWeight: 700,
      letterSpacing: 4,
      textTransform: "uppercase",
      color: BRAND,
    }, opts.kicker),
    el("div", {
      fontSize: 68,
      fontWeight: 700,
      lineHeight: 1.1,
      marginTop: 20,
      color: "white",
    }, clamp(opts.title, 90)),
  ];
  if (opts.subtitle) {
    headerChildren.push(
      el("div", {
        fontSize: 30,
        fontWeight: 400,
        lineHeight: 1.35,
        marginTop: 22,
        color: "rgba(255,255,255,0.72)",
      }, clamp(opts.subtitle, 160)),
    );
  }

  const footerChildren: Node[] = [];
  if (thumbNodes.length > 0) {
    footerChildren.push(el("div", { display: "flex", gap: 16 }, thumbNodes));
  } else {
    footerChildren.push(el("div", {}, ""));
  }
  footerChildren.push(
    el("div", {
      display: "flex",
      fontSize: 30,
      fontWeight: 700,
      color: "white",
      alignItems: "center",
    }, "tatakai.me"),
  );

  const tree = el(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      width: WIDTH,
      height: HEIGHT,
      padding: 72,
      backgroundColor: BG_FROM,
      backgroundImage: `linear-gradient(135deg, ${BG_FROM} 0%, ${BG_TO} 55%, ${BRAND} 160%)`,
      fontFamily: "Inter",
    },
    [
      el("div", { display: "flex", flexDirection: "column" }, headerChildren),
      el("div", { display: "flex", justifyContent: "space-between", alignItems: "flex-end" }, footerChildren),
    ],
  );

  const svg = await satori(tree as never, { width: WIDTH, height: HEIGHT, fonts });
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: WIDTH },
  }).render().asPng();
  return Buffer.from(png);
}

/** Render (or serve cached) and reply as image/png; on failure, 500 → the web
 *  server keeps the default meta image, so a broken card is never fatal. */
async function servePng(c: Context, cacheKey: string, build: () => Promise<CardOpts | null>) {
  try {
    const cached = memoryCache.get(cacheKey);
    let png = cached?.hit as Buffer | undefined;
    if (!png) {
      const opts = await build();
      if (!opts) return c.text("Not found", 404);
      png = await renderCard(opts);
      memoryCache.set(cacheKey, png, OG_TTL_SEC);
    }
    c.header("Content-Type", "image/png");
    c.header("Cache-Control", `public, max-age=${OG_TTL_SEC}, s-maxage=${OG_TTL_SEC}`);
    // Hand Hono a clean ArrayBuffer (its body union doesn't include Node Buffer).
    const ab = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
    return c.body(ab);
  } catch (err) {
    log.warn({ err: (err as Error).message, cacheKey }, "[og] render failed");
    return c.text("OG render failed", 500);
  }
}

// --- Endpoints --------------------------------------------------------------
ogRouter.get("/tierlist/:shareCode", async (c) => {
  const shareCode = c.req.param("shareCode");
  return servePng(c, `og:tierlist:${shareCode}`, async () => {
    const db = getSupabase();
    if (!db) return null;
    const { data } = await db
      .from("tier_lists")
      .select("title, description, items, is_public")
      .eq("share_code", shareCode)
      .eq("is_public", true)
      .maybeSingle();
    if (!data) return null;
    const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [];
    const posters = items
      .map((it) => (it.poster || it.image || it.coverImage || it.anime_poster) as string | undefined)
      .filter(Boolean) as string[];
    return {
      kicker: "Tatakai · Tier List",
      title: data.title || "Tier List",
      subtitle: data.description || undefined,
      thumbs: await collectThumbs(posters),
    };
  });
});

ogRouter.get("/playlist/:slug", async (c) => {
  const slug = c.req.param("slug");
  return servePng(c, `og:playlist:${slug}`, async () => {
    const db = getSupabase();
    if (!db) return null;
    const cols = "id, name, description, share_description, share_slug, is_public";
    let { data } = await db
      .from("playlists")
      .select(cols)
      .eq("share_slug", slug)
      .eq("is_public", true)
      .maybeSingle();
    if (!data && /^[0-9a-f-]{36}$/i.test(slug)) {
      ({ data } = await db.from("playlists").select(cols).eq("id", slug).eq("is_public", true).maybeSingle());
    }
    if (!data) return null;
    const { data: rows } = await db
      .from("playlist_items")
      .select("anime_poster, position")
      .eq("playlist_id", data.id)
      .order("position", { ascending: true })
      .limit(5);
    const posters = (rows || []).map((r) => r.anime_poster as string | undefined).filter(Boolean) as string[];
    return {
      kicker: "Tatakai · Playlist",
      title: data.name || "Playlist",
      subtitle: data.share_description || data.description || undefined,
      thumbs: await collectThumbs(posters),
    };
  });
});

ogRouter.get("/post/:id", async (c) => {
  const id = c.req.param("id");
  return servePng(c, `og:post:${id}`, async () => {
    const db = getSupabase();
    if (!db) return null;
    const { data } = await db
      .from("forum_posts")
      .select("title, content, image_url, anime_poster, is_approved, is_nsfw")
      .eq("id", id)
      .eq("is_approved", true)
      .eq("is_nsfw", false)
      .maybeSingle();
    if (!data) return null;
    return {
      kicker: "Tatakai · Community",
      title: data.title || "Community Post",
      subtitle: (data.content as string) || undefined,
      thumbs: await collectThumbs([data.image_url, data.anime_poster]),
    };
  });
});

export { ogRouter };
