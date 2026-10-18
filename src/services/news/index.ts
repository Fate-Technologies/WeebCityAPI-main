/**
 * Public surface of the news aggregation service.
 * Route + ingestion job import from here.
 */
export type { Article } from "./types.js";
export { fetchAllNews } from "./fetchAllSources.js";
export { SOURCES } from "./sources.js";
export {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  NEWS_CACHE_TTL_SEC,
} from "./constants.js";
export { normalizeLink } from "./generateSlug.js";
