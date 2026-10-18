/**
 * Shared news-ingestion routine, used by BOTH the CLI job
 * (jobs/newsRefresh.ts) and the admin on-demand refresh route
 * (routes/admin/news.ts). Aggregates the upstream sources, purges retired
 * ones, and inserts genuinely new stories as forum_posts owned by the News
 * bot. Dedup is on the normalized article link stored at metadata.news_link,
 * so re-running only inserts new stories.
 */
import { getSupabase } from "../../lib/supabase.js";
import { fetchAllNews } from "./fetchAllSources.js";
import { normalizeLink } from "./generateSlug.js";
import type { Article } from "./types.js";

type Supa = NonNullable<ReturnType<typeof getSupabase>>;

const PAGE = 1000;

/** Sources that used to be ingested but are now dropped — their existing bot
 *  posts are purged on every run so old stories disappear from the feed. */
const RETIRED_SOURCES = ["MyAnimeList"];

export interface IngestResult {
  aggregated: number;
  inserted: number;
  existing: number;
  purged: number;
}

/** All normalized links already ingested by the bot (paginated past PostgREST's cap). */
async function loadExistingLinks(supa: Supa, botId: string): Promise<Set<string>> {
  const seen = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa
      .from("forum_posts")
      .select("news_link:metadata->>news_link")
      .eq("user_id", botId)
      .eq("flair", "News")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`load existing links failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ news_link: string | null }>;
    for (const r of rows) if (r.news_link) seen.add(r.news_link);
    if (rows.length < PAGE) break;
  }
  return seen;
}

/** Build a forum_posts insert row from an aggregated article. */
function toPost(botId: string, article: Article, normalizedLink: string) {
  return {
    user_id: botId,
    title: article.title.slice(0, 300),
    content: article.excerpt || article.title,
    content_type: "link",
    flair: "News",
    is_approved: true,
    image_url: article.image || null,
    created_at: article.date, // published date → correct chronological position in the feed
    metadata: {
      news_link: normalizedLink,
      news_url: article.link,
      source: article.source,
      tags: article.tags,
      published_at: article.date,
      news_slug: article.slug,
    },
  };
}

/** Delete bot-authored News posts from sources we no longer ingest. Returns count removed. */
async function purgeRetiredSources(supa: Supa, botId: string): Promise<number> {
  let removed = 0;
  for (const source of RETIRED_SOURCES) {
    const { error, count } = await supa
      .from("forum_posts")
      .delete({ count: "exact" })
      .eq("user_id", botId)
      .eq("flair", "News")
      .eq("metadata->>source", source);
    if (error) throw new Error(`purge ${source} failed: ${error.message}`);
    removed += count ?? 0;
  }
  return removed;
}

/**
 * Run one ingestion pass: aggregate → purge retired → dedup → insert fresh.
 * Pure of process concerns (no env checks, no logging, no process.exit) so it
 * can be called from a request handler as well as the CLI entrypoint.
 */
export async function ingestNews(supa: Supa, botId: string): Promise<IngestResult> {
  const { articles } = await fetchAllNews(true);
  const purged = await purgeRetiredSources(supa, botId);
  const existing = await loadExistingLinks(supa, botId);

  const fresh: ReturnType<typeof toPost>[] = [];
  const batchSeen = new Set<string>();
  for (const a of articles) {
    if (!a.link) continue;
    const norm = normalizeLink(a.link);
    if (!norm || existing.has(norm) || batchSeen.has(norm)) continue;
    batchSeen.add(norm);
    fresh.push(toPost(botId, a, norm));
  }

  if (fresh.length > 0) {
    const { error } = await supa.from("forum_posts").insert(fresh);
    if (error) throw new Error(`insert failed: ${error.message}`);
  }

  return { aggregated: articles.length, inserted: fresh.length, existing: existing.size, purged };
}
