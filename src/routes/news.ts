/**
 * GET /api/v3/news — aggregated anime-news feed.
 *
 * Public (v3 uses optionalCatalogAuth). Backed by the in-memory news cache
 * (see services/news): a warm cache returns instantly, a cold one coalesces
 * concurrent misses into a single upstream aggregate. Supports page/limit
 * pagination and an optional `source` (source-slug or tag) filter.
 */
import { Hono } from "hono";
import { jsonOk, jsonError } from "../lib/envelope.js";
import {
  fetchAllNews,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  NEWS_CACHE_TTL_SEC,
} from "../services/news/index.js";

export const newsRouter = new Hono();

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

newsRouter.get("/", async (c) => {
  try {
    const perPage = clampInt(c.req.query("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const page = clampInt(c.req.query("page"), 1, 1, Number.MAX_SAFE_INTEGER);
    const sourceFilter = (c.req.query("source") || "").trim().toLowerCase();
    const force = c.req.query("refresh") === "1";

    const { articles, cache } = await fetchAllNews(force);
    const filtered = sourceFilter
      ? articles.filter(
          (a) =>
            a.source.toLowerCase().replace(/\s+/g, "-") === sourceFilter ||
            a.tags.includes(sourceFilter),
        )
      : articles;

    const total = filtered.length;
    const lastPage = Math.max(1, Math.ceil(total / perPage));
    const start = (page - 1) * perPage;
    const paged = filtered.slice(start, start + perPage);

    return c.json(
      jsonOk(paged, {
        page,
        perPage,
        total,
        lastPage,
        hasNextPage: page < lastPage,
        cache,
        ttlSec: NEWS_CACHE_TTL_SEC,
        source: "mixed",
      }),
    );
  } catch (err) {
    return c.json(jsonError(err instanceof Error ? err.message : "news fetch failed"), 502);
  }
});
