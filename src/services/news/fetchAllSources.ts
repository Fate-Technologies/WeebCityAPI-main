/**
 * Aggregation. Ported from temp/AniNewsAPI/utils/fetchAllSources.js — fan out
 * to every source, tolerate individual failures (allSettled), dedup by
 * normalized title, sort newest-first. node-cache/cacheHandler are replaced by
 * the app's MemoryCache + coalesce (single in-flight aggregate under load).
 */
import type { Article } from "./types.js";
import { SOURCES } from "./sources.js";
import { runSource } from "./fetchers.js";
import { memoryCache, coalesce, type MemoryCache } from "../../lib/cache.js";
import type { CacheMeta } from "../../lib/envelope.js";
import { NEWS_CACHE_TTL_SEC } from "./constants.js";

const CACHE_KEY = "news:all";

/** Collapse near-duplicate headlines across sources; first (newest) wins. */
function dedupeByTitle(articles: Article[]): Article[] {
  const seen = new Set<string>();
  const out: Article[] = [];
  for (const a of articles) {
    const key = a.title.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** Guarantee every field is present and fold the source name into tags. */
function normalize(a: Article): Article {
  const sourceTag = a.source.toLowerCase().replace(/\s+/g, "-");
  return {
    ...a,
    excerpt: a.excerpt || "",
    image: a.image || "",
    date: a.date || new Date().toISOString(),
    link: a.link || "",
    tags: [...new Set([...(a.tags || []), sourceTag])],
  };
}

async function aggregate(): Promise<Article[]> {
  const results = await Promise.allSettled(SOURCES.map((s) => runSource(s)));
  const all: Article[] = [];
  for (const r of results) if (r.status === "fulfilled") all.push(...r.value);

  const deduped = dedupeByTitle(all.filter((a) => a.title && a.link));
  deduped.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return deduped.map(normalize);
}

/**
 * Fetch (and cache) the aggregated feed. Returns the cache disposition so the
 * route can report it in `meta`. `force` bypasses a warm cache (used by the job).
 */
export async function fetchAllNews(
  force = false,
  cache: MemoryCache = memoryCache,
): Promise<{ articles: Article[]; cache: CacheMeta }> {
  if (!force) {
    const cached = cache.get<Article[]>(CACHE_KEY);
    if (cached && cached.meta === "hit") return { articles: cached.hit, cache: "hit" };
  }
  const articles = await coalesce(CACHE_KEY, aggregate);
  cache.set(CACHE_KEY, articles, NEWS_CACHE_TTL_SEC);
  return { articles, cache: "miss" };
}
