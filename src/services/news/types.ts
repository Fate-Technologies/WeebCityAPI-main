/**
 * News aggregation types. Ported from temp/AniNewsAPI (CommonJS) to TS/ESM.
 * The Article shape is the aggregator's public contract; the SourceConfig
 * shape is our config-driven replacement for AniNewsAPI's 13 hand-written
 * fetchers (one generic RSS/GNews/web pipeline driven by a table).
 */

/** A single normalized news article. */
export interface Article {
  title: string;
  slug: string;
  source: string;
  excerpt: string;
  /** ISO 8601 string. */
  date: string;
  image: string;
  link: string;
  tags: string[];
}

/** rss-parser items carry arbitrary custom fields; type them loosely. */
export interface RssItem {
  title?: string;
  link?: string;
  pubDate?: string;
  isoDate?: string;
  content?: string;
  contentSnippet?: string;
  categories?: string[];
  enclosure?: { url?: string; type?: string };
  [key: string]: unknown;
}

/** How the RSS/feed image is resolved for a source. */
export type ImageMode = "inline" | "og" | "gnews";

/** RSS (or Google-News-search) feed config for a source. */
export interface RssConfig {
  url: string;
  /** "gnews" strips the trailing " - <Publisher>" suffix Google appends. */
  kind: "standard" | "gnews";
  image: ImageMode;
  stripSuffixes?: string[];
  limit: number;
  defaultTags: string[];
}

/** Generic web-scrape config (fallback, or primary when webFirst). */
export interface WebConfig {
  urls: string[];
  selectors: string[];
  baseUrl: string;
  limit: number;
  defaultTags: string[];
  /** Extra excerpt selectors tried before the generic p/.excerpt/.summary. */
  excerptSelectors?: string[];
}

/** One news source. `custom` fully overrides the generic pipeline (MAL). */
export interface SourceConfig {
  key: string;
  name: string;
  rss?: RssConfig;
  web?: WebConfig;
  /** Try web scrape before RSS (comicbook). */
  webFirst?: boolean;
  custom?: (retries: number) => Promise<Article[]>;
}
