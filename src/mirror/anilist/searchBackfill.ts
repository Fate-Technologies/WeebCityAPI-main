/**
 * Background write-through backfill for search / Page misses.
 *
 * Exact-id roots already fetch-on-miss synchronously (see fallback.ts). Search
 * and filtered Page reads, by contrast, only ever read our Postgres — so a query
 * for a title we haven't scraped yet returns thin/empty results. This module
 * closes that gap WITHOUT slowing the response: after the DB read, if the result
 * looks under-filled, we fire-and-forget a live AniList search and persist the
 * nodes, so the *next* identical request (or an id lookup) is served locally.
 *
 * Guarantees:
 *  - Never blocks the resolver (fire-and-forget; caller does not await).
 *  - Coalesces identical in-flight backfills by a normalized arg key.
 *  - Caps concurrency and drops jobs when saturated (the upstream is precious;
 *    the mirror's Bottleneck limiter is the hard cap, this is the soft one).
 *  - Guarded by ENABLE_LIVE_FALLBACK / SEARCH_BACKFILL_ENABLED.
 */
import { anilistRequest } from './client.js';
import { MEDIA_PAGE_SEARCH } from './queries.js';
import { persistNodes } from './bulk.js';
import type { RawMediaNode } from './ingest.js';

const LIVE_FALLBACK = (process.env.ENABLE_LIVE_FALLBACK ?? 'true') !== 'false';
// Search backfill follows ENABLE_LIVE_FALLBACK unless explicitly overridden.
const ENABLED =
  (process.env.SEARCH_BACKFILL_ENABLED ?? String(LIVE_FALLBACK)) !== 'false';

const MAX_CONCURRENT = Number(process.env.SEARCH_BACKFILL_CONCURRENCY || 3);
// AniList caps perPage at 50; keep our backfill page modest.
const BACKFILL_PER_PAGE = Math.min(Number(process.env.SEARCH_BACKFILL_PER_PAGE || 25), 50);

/** The subset of a Media/Page.media filter that maps onto a live AniList search. */
export interface SearchBackfillArgs {
  page?: number | null;
  perPage?: number | null;
  search?: string | null;
  type?: string | null;
  format?: string | null; format_in?: readonly string[] | null;
  status?: string | null; status_in?: readonly string[] | null;
  season?: string | null; seasonYear?: number | null;
  genre?: string | null; genre_in?: readonly string[] | null;
  tag?: string | null; tag_in?: readonly string[] | null;
  countryOfOrigin?: string | null; isAdult?: boolean | null;
  sort?: readonly string[] | string | null;
  averageScore_greater?: number | null; averageScore_lesser?: number | null;
  episodes_greater?: number | null; episodes_lesser?: number | null;
  startDate_greater?: number | null; startDate_lesser?: number | null;
}

const inflight = new Set<string>();
let active = 0;

/** Build the live-query variables from the resolver args (only meaningful keys). */
function toVariables(a: SearchBackfillArgs): Record<string, unknown> {
  const sort = Array.isArray(a.sort) ? a.sort : a.sort != null ? [a.sort] : undefined;
  const v: Record<string, unknown> = {
    page: 1,
    perPage: BACKFILL_PER_PAGE,
    search: a.search ?? undefined,
    type: a.type ?? undefined,
    format: a.format ?? undefined,
    format_in: a.format_in?.length ? [...a.format_in] : undefined,
    status: a.status ?? undefined,
    status_in: a.status_in?.length ? [...a.status_in] : undefined,
    season: a.season ?? undefined,
    seasonYear: a.seasonYear ?? undefined,
    // AniList has no singular genre/tag `_in`-free arg on this doc; fold singulars in.
    genre_in: a.genre_in?.length ? [...a.genre_in] : a.genre ? [a.genre] : undefined,
    tag_in: a.tag_in?.length ? [...a.tag_in] : a.tag ? [a.tag] : undefined,
    countryOfOrigin: a.countryOfOrigin ?? undefined,
    isAdult: a.isAdult ?? undefined,
    // SEARCH_MATCH only makes sense with a search term; drop it otherwise so the
    // upstream doesn't reject/ignore it oddly.
    sort: sort?.filter((s) => s && (s !== 'SEARCH_MATCH' || a.search)) ?? undefined,
    averageScore_greater: a.averageScore_greater ?? undefined,
    averageScore_lesser: a.averageScore_lesser ?? undefined,
    episodes_greater: a.episodes_greater ?? undefined,
    episodes_lesser: a.episodes_lesser ?? undefined,
    startDate_greater: a.startDate_greater ?? undefined,
    startDate_lesser: a.startDate_lesser ?? undefined,
  };
  if (Array.isArray(v.sort) && !(v.sort as unknown[]).length) v.sort = undefined;
  return v;
}

/** Only backfill searches that name *something* — an unfiltered page is the scraper's job. */
function isSearchable(a: SearchBackfillArgs): boolean {
  return Boolean(
    (a.search && a.search.trim()) ||
    a.genre || a.genre_in?.length ||
    a.tag || a.tag_in?.length,
  );
}

/** Stable key over the meaningful variables, so identical searches coalesce. */
function keyFor(vars: Record<string, unknown>): string {
  const entries = Object.entries(vars)
    .filter(([, val]) => val !== undefined)
    .sort(([x], [y]) => x.localeCompare(y));
  return JSON.stringify(entries);
}

/**
 * Fire-and-forget a live search + persist when the DB read looks under-filled.
 * `rowsReturned` is how many the DB gave the caller; `perPage` the page size.
 * Text searches backfill even on a partial page (relevance matters); filtered
 * browse pages only backfill when they came back short of a full page.
 */
export function maybeBackfillSearch(
  a: SearchBackfillArgs,
  rowsReturned: number,
  perPage: number,
): void {
  if (!ENABLED || !isSearchable(a)) return;

  const isTextSearch = Boolean(a.search && a.search.trim());
  const underFilled = isTextSearch ? rowsReturned < perPage : rowsReturned < perPage;
  // For a text search we also want to backfill on zero rows (nothing matched yet).
  if (!underFilled && !(isTextSearch && rowsReturned === 0)) return;

  const vars = toVariables(a);
  const key = keyFor(vars);
  if (inflight.has(key)) return;              // already fetching this search
  if (active >= MAX_CONCURRENT) return;       // saturated — drop, the limiter is the real cap

  inflight.add(key);
  active++;
  void (async () => {
    try {
      const data = await anilistRequest<{ Page?: { media?: (RawMediaNode | null)[] } }>(
        MEDIA_PAGE_SEARCH,
        vars,
      );
      const nodes = data?.Page?.media ?? [];
      if (nodes.length) await persistNodes(nodes);
    } catch {
      // Fire-and-forget: upstream errors / rate limits are swallowed. The DB read
      // already answered the user; the backfill is best-effort.
    } finally {
      active--;
      inflight.delete(key);
    }
  })();
}
