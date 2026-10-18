import { cacheStore } from '../lib/cacheStore.js';
import { Hono } from "hono";
import { jsonOk, jsonError } from "../lib/envelope.js";
import { coalesce, defaultTtlSec } from "../lib/cache.js";
import * as mangaCatalog from "../services/mangaCatalog.js";
import { getMangaSectionItems } from "../services/mangaSections.js";
import { getMangaSectionsPage, SECTION_TOTAL_PAGES } from "../services/mangaSections.js";
import { attachMangaMappings, attachMappingToMedia } from "../services/mapping/mappingResolver.js";
import type { MangaHomeBundle, MangaSectionsPage } from "../types/tatakaiMedia.js";

const mangaRouter = new Hono();

function normalizeAniListTags(tags: string[] | undefined): string[] | undefined {
  return tags?.map((tag) => tag.trim().toLowerCase() === "regression" ? "Age Regression" : tag.trim()).filter(Boolean);
}

/**
 * The endless feed only rotates once a day and each page is a single upstream
 * call, so a five-minute TTL would mean going cold for no reason. Half an hour
 * keeps the whole feed warm through a normal browsing session.
 */
const SECTIONS_TTL_SEC = 30 * 60;

function num(v: string | undefined, d: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function flag(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

mangaRouter.get("/search", async (c) => {
  const q = String(c.req.query("q") || "").trim();
  const page = num(c.req.query("page"), 1);
  const perPage = num(c.req.query("perPage"), 20);
  const isAdultRaw = c.req.query("isAdult");
  const isAdult =
    isAdultRaw === "true"
      ? true
      : isAdultRaw === "false"
        ? false
        : undefined;
  const genre = c.req.query("genre") || undefined;
  const tags = normalizeAniListTags(c.req.query("tags")?.split(","));

  const res = await mangaCatalog.browseManga({
    query: q || undefined,
    page,
    perPage,
    isAdult,
    mode: c.req.query("mode") || undefined,
    sort: c.req.query("sort") || undefined,
    genre,
    tags,
    origin: c.req.query("origin") || undefined,
    format: c.req.query("type") || c.req.query("format") || undefined,
    status: c.req.query("status") || undefined,
  });

  let combinedResults: any[] = [...res.media];
  const metaSource = "anilist" as const;

  const wrapped = await attachMangaMappings(combinedResults as any);
  return c.json(jsonOk(wrapped, {
    page: res.pageInfo.currentPage,
    perPage: res.pageInfo.perPage,
    total: res.pageInfo.total + (combinedResults.length - res.media.length),
    hasNextPage: res.pageInfo.hasNextPage || combinedResults.length >= perPage,
    lastPage: res.pageInfo.lastPage,
    source: metaSource,
  }));
});

/**
 * Everything above the fold on `/manga`, in one cached response.
 *
 * Registered before `/:id` so the literal path wins. `?adult=1` gets its own
 * cache key rather than a flag on the shared one — the default bundle has to
 * stay servable to everyone.
 */
mangaRouter.get("/home", async (c) => {
  const adult = flag(c.req.query("adult"));
  const key = adult ? "manga:home:adult" : "manga:home";
  const ttlSec = defaultTtlSec();

  const cached = await cacheStore.get<MangaHomeBundle>(key);
  if (cached && cached.meta === "hit") {
    return c.json(jsonOk(cached.hit, { cache: "hit", ttlSec, source: "anilist" }));
  }

  const bundle = await coalesce(key, async () => {
    const fresh = await mangaCatalog.getMangaHomeBundle({ adult });
    await cacheStore.set(key, fresh, ttlSec);
    return fresh;
  });

  return c.json(jsonOk(bundle, { cache: "miss", ttlSec, source: "anilist" }));
});

/**
 * One scroll page of the hub's endless feed — four shelves, one AniList request.
 * The shelf list, its order and its filters all live in `mangaSections.ts`; the
 * client only asks for a page number.
 */
mangaRouter.get("/sections", async (c) => {
  const page = Math.max(1, num(c.req.query("page"), 1));
  const adult = flag(c.req.query("adult"));
  const key = `manga:sections:${page}:${adult ? "adult" : "safe"}`;

  const cached = await cacheStore.get<MangaSectionsPage>(key);
  if (cached && cached.meta === "hit") {
    return c.json(
      jsonOk(cached.hit, {
        cache: "hit",
        ttlSec: SECTIONS_TTL_SEC,
        source: "anilist",
        page,
        lastPage: SECTION_TOTAL_PAGES,
        hasNextPage: cached.hit.hasNextPage,
      }),
    );
  }

  const data = await coalesce(key, async () => {
    const fresh = await getMangaSectionsPage(page, { adult });
    await cacheStore.set(key, fresh, SECTIONS_TTL_SEC);
    return fresh;
  });

  return c.json(
    jsonOk(data, {
      cache: "miss",
      ttlSec: SECTIONS_TTL_SEC,
      source: "anilist",
      page,
      lastPage: SECTION_TOTAL_PAGES,
      hasNextPage: data.hasNextPage,
    }),
  );
});

mangaRouter.get("/sections/:id/items", async (c) => {
  const id = String(c.req.param("id") || "");
  const page = num(c.req.query("page"), 1);
  const adult = flag(c.req.query("adult"));
  const perPage = num(c.req.query("perPage"), 24);

  const data = await getMangaSectionItems(id, page, { adult, perPage });
  if (!data) return c.json({ success: false, error: "section not found" }, 404);

  return c.json(
    jsonOk(data, { source: "anilist", page, perPage }),
  );
});

mangaRouter.get("/mal/:id/full", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ success: false, error: "invalid id" }, 400);
  const data = await mangaCatalog.getJikanMangaFull(id);
  return c.json(jsonOk(data, { source: "jikan" }));
});

mangaRouter.get("/mal/:id/characters", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ success: false, error: "invalid id" }, 400);
  const data = await mangaCatalog.getJikanMangaCharacters(id);
  return c.json(jsonOk(data, { source: "jikan" }));
});

mangaRouter.get("/by-anilist/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ success: false, error: "invalid anilist id" }, 400);
  try {
    const media = await mangaCatalog.getMangaByAniListId(id);
    if (!media) return c.json({ success: false, error: "not found" }, 404);
    return c.json(jsonOk(await attachMappingToMedia(media), { source: "anilist" }));
  } catch (err) {
    // Upstream (AniList) failure is a gateway problem, not a server bug — 502,
    // not an unhandled 500. The renderer can treat it like a transient miss.
    return c.json(jsonError(err instanceof Error ? err.message : "manga lookup failed"), 502);
  }
});

mangaRouter.get("/by-mal/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ success: false, error: "invalid mal id" }, 400);
  try {
    const media = await mangaCatalog.getMangaByMalId(id);
    if (!media) return c.json({ success: false, error: "not found" }, 404);
    return c.json(jsonOk(await attachMappingToMedia(media), { source: "anilist" }));
  } catch (err) {
    return c.json(jsonError(err instanceof Error ? err.message : "manga lookup failed"), 502);
  }
});

mangaRouter.get("/:id/chapters", async (c) => {
  const rawId = String(c.req.param("id") || "");
  let anilistId = Number(rawId);
  let media = Number.isFinite(anilistId) && anilistId > 0 ? await mangaCatalog.getMangaByAniListId(anilistId) : null;

  if (!media && rawId.startsWith("anilist:")) {
    anilistId = Number(rawId.replace("anilist:", ""));
    if (Number.isFinite(anilistId) && anilistId > 0) {
      media = await mangaCatalog.getMangaByAniListId(anilistId);
    }
  }

  if (!media && rawId.startsWith("mal:")) {
    const malId = Number(rawId.replace("mal:", ""));
    if (Number.isFinite(malId) && malId > 0) {
      media = await mangaCatalog.getMangaByMalId(malId);
    }
  }

  if (!media) return c.json({ success: false, error: "not found" }, 404);

  // Optional client-supplied extension chapter payloads (desktop merge)
  let extensionChapters: unknown[] = [];
  try {
    const raw = c.req.query("extensionChapters");
    if (raw) extensionChapters = JSON.parse(raw);
  } catch {
    extensionChapters = [];
  }

  const { buildChapterHierarchy } = await import("../services/mapping/chapterMerge.js");
  const hierarchy = buildChapterHierarchy({
    anilistId: media.anilistId,
    totalChapters: Number(media.chapters ?? 0),
    extensionChapters: Array.isArray(extensionChapters) ? extensionChapters as any : [],
  });

  return c.json(jsonOk(hierarchy, { source: "anilist" }));
});

/**
 * Store a manga's total chapter count in the mirror ("Tiger DB").
 *
 * Chapters are scraped client-side by the extension runtime, so the reader POSTs
 * the discovered total here to persist it on `Media.chapters`. Accepts the same
 * id forms as the chapters route (numeric / `anilist:` / `mal:`). The write is
 * upward-only inside the service, so replaying it is harmless. Different HTTP
 * method from GET `/:id`, so route order relative to it does not matter.
 */
mangaRouter.post("/:id/total-chapters", async (c) => {
  const rawId = String(c.req.param("id") || "");

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const total = Number(body?.total ?? body?.totalChapters);
  if (!Number.isFinite(total) || total <= 0) {
    return c.json({ success: false, error: "invalid total" }, 400);
  }

  let anilistId = Number(rawId);
  if (!(Number.isFinite(anilistId) && anilistId > 0) && rawId.startsWith("anilist:")) {
    anilistId = Number(rawId.replace("anilist:", ""));
  }
  if (!(Number.isFinite(anilistId) && anilistId > 0) && rawId.startsWith("mal:")) {
    const malId = Number(rawId.replace("mal:", ""));
    if (Number.isFinite(malId) && malId > 0) {
      const media = await mangaCatalog.getMangaByMalId(malId).catch(() => null);
      anilistId = Number(media?.anilistId ?? 0);
    }
  }
  if (!(Number.isFinite(anilistId) && anilistId > 0)) {
    return c.json({ success: false, error: "unresolved manga id" }, 404);
  }

  try {
    const stored = await mangaCatalog.setMangaTotalChapters(anilistId, total);
    if (stored == null) return c.json({ success: false, error: "not found" }, 404);
    return c.json(jsonOk({ anilistId, chapters: stored }, { source: "db" }));
  } catch (err) {
    return c.json(jsonError(err instanceof Error ? err.message : "failed to store chapters"), 500);
  }
});

mangaRouter.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ success: false, error: "invalid id" }, 400);
  const media = await mangaCatalog.getMangaByAniListId(id);
  if (!media) return c.json({ success: false, error: "not found" }, 404);
  return c.json(jsonOk(await attachMappingToMedia(media), { source: "anilist" }));
});

export { mangaRouter };