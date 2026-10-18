/**
 * News aggregation constants. Ported from temp/AniNewsAPI/utils/constants.js.
 */

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Default HTTP timeout for list/feed requests (ms). */
export const REQUEST_TIMEOUT = 15000;

/** Timeout for per-article OG-image fetches (ms). */
export const ARTICLE_TIMEOUT = 10000;

/** Upper bound per source before dedup. */
export const MAX_ARTICLES_PER_SOURCE = 15;

/** Cache TTL for the aggregated feed (seconds). */
export const NEWS_CACHE_TTL_SEC = 600;

/** Default page size for the /news route. */
export const DEFAULT_LIMIT = 20;

/** Hard cap for the /news route `limit` param. */
export const MAX_LIMIT = 100;
