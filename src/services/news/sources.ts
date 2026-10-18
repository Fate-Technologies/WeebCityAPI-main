/**
 * Source registry. Ported from temp/AniNewsAPI/utils/sources.js — the same 13
 * anime-news publishers, expressed as data for the generic pipeline in
 * fetchers.ts instead of 13 separate modules. URLs, selectors, per-source
 * limits and default tags are preserved from the originals.
 */
import type { SourceConfig } from "./types.js";

/** Selectors most WordPress/news themes respond to. */
const DEFAULT_SELECTORS = ["article", ".post", ".entry", ".news-item", ".article-card"];

/** Build a Google News RSS search URL for a site query. */
const gnews = (query: string): string =>
  `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;

export const SOURCES: SourceConfig[] = [
  {
    key: "ann",
    name: "Anime News Network",
    rss: {
      url: gnews("site:animenewsnetwork.com%2Fnews"),
      kind: "gnews",
      image: "gnews",
      stripSuffixes: [" - Anime News Network"],
      limit: 15,
      defaultTags: ["news", "anime"],
    },
    web: {
      urls: ["https://www.animenewsnetwork.com/news/"],
      selectors: [".herald.box.news", ".news-item", "article.news", ".news-article"],
      baseUrl: "https://www.animenewsnetwork.com",
      limit: 15,
      defaultTags: ["news", "anime"],
    },
  },
  {
    key: "animecorner",
    name: "Anime Corner",
    rss: {
      url: "https://animecorner.me/feed/",
      kind: "standard",
      image: "inline",
      limit: 12,
      defaultTags: ["community", "news"],
    },
    web: {
      urls: ["https://animecorner.me/"],
      selectors: ["article.post", "article.type-post", ".post-item", "article", ".entry-card"],
      baseUrl: "https://animecorner.me",
      limit: 12,
      defaultTags: ["community", "news"],
    },
  },
  {
    key: "otakuusa",
    name: "Otaku USA Magazine",
    rss: {
      url: gnews("site:otakuusamagazine.com"),
      kind: "gnews",
      image: "gnews",
      stripSuffixes: [" - Otaku USA Magazine"],
      limit: 12,
      defaultTags: ["community", "magazine"],
    },
    web: {
      urls: ["https://otakuusamagazine.com/anime-latest-news/", "https://otakuusamagazine.com/"],
      selectors: DEFAULT_SELECTORS,
      baseUrl: "https://otakuusamagazine.com",
      limit: 12,
      defaultTags: ["community", "magazine"],
    },
  },
  {
    key: "crunchyroll",
    name: "Crunchyroll",
    rss: {
      url: gnews("site:crunchyroll.com%2Fnews"),
      kind: "gnews",
      image: "gnews",
      stripSuffixes: [" - Crunchyroll News", " - Crunchyroll"],
      limit: 15,
      defaultTags: ["official", "news"],
    },
    web: {
      urls: ["https://www.crunchyroll.com/news", "https://www.crunchyroll.com/news/latest"],
      selectors: DEFAULT_SELECTORS,
      baseUrl: "https://www.crunchyroll.com",
      limit: 12,
      defaultTags: ["official", "news"],
    },
  },
  {
    key: "animeherald",
    name: "Anime Herald",
    rss: {
      url: "https://www.animeherald.com/feed/",
      kind: "standard",
      image: "inline",
      limit: 10,
      defaultTags: ["news", "anime"],
    },
    web: {
      urls: ["https://www.animeherald.com/"],
      selectors: DEFAULT_SELECTORS,
      baseUrl: "https://www.animeherald.com",
      limit: 10,
      defaultTags: ["news", "anime"],
    },
  },
  {
    key: "comicbook",
    name: "ComicBook",
    webFirst: true,
    web: {
      urls: ["https://comicbook.com/anime/"],
      selectors: [".wp-block-post", "article", ".article-card", ".post"],
      excerptSelectors: [".wp-block-savage-platform-post-subheadline"],
      baseUrl: "https://comicbook.com",
      limit: 10,
      defaultTags: ["news", "anime", "manga"],
    },
    rss: {
      url: "https://comicbook.com/anime/feed/",
      kind: "standard",
      image: "inline",
      limit: 10,
      defaultTags: ["news", "anime", "manga"],
    },
  },
  {
    key: "tokyootakumode",
    name: "Tokyo Otaku Mode",
    rss: {
      url: "https://otakumode.com/news/feed",
      kind: "standard",
      image: "inline",
      limit: 12,
      defaultTags: ["anime", "manga"],
    },
    web: {
      urls: ["https://otakumode.com/news", "https://otakumode.com/"],
      selectors: DEFAULT_SELECTORS,
      baseUrl: "https://otakumode.com",
      limit: 10,
      defaultTags: ["anime", "manga", "otaku"],
    },
  },
  {
    key: "animetrending",
    name: "Anime Trending",
    rss: {
      url: "https://anitrendz.net/news/feed",
      kind: "standard",
      image: "inline",
      limit: 12,
      defaultTags: ["anime", "news"],
    },
    web: {
      urls: ["https://anitrendz.net/news", "https://anitrendz.net/"],
      selectors: DEFAULT_SELECTORS,
      baseUrl: "https://anitrendz.net",
      limit: 10,
      defaultTags: ["anime", "trending", "charts"],
    },
  },
  {
    key: "animeuknews",
    name: "Anime UK News",
    rss: {
      url: "https://animeuknews.net/category/news/feed",
      kind: "standard",
      image: "og",
      limit: 12,
      defaultTags: ["anime", "uk"],
    },
    web: {
      urls: ["https://animeuknews.net/category/news", "https://animeuknews.net/"],
      selectors: DEFAULT_SELECTORS,
      baseUrl: "https://animeuknews.net",
      limit: 10,
      defaultTags: ["anime", "uk", "news"],
    },
  },
  {
    key: "randomcuriosity",
    name: "Random Curiosity",
    rss: {
      url: "https://randomc.net/feed",
      kind: "standard",
      image: "inline",
      limit: 12,
      defaultTags: ["anime", "review"],
    },
    web: {
      urls: ["https://randomc.net", "https://randomc.net/news"],
      selectors: ["article", ".post", ".entry", ".article", 'a[href*="/2026/"]'],
      baseUrl: "https://randomc.net",
      limit: 10,
      defaultTags: ["anime", "preview", "review"],
    },
  },
  {
    key: "honeysanime",
    name: "Honey's Anime",
    rss: {
      url: "https://honeysanime.com/feed",
      kind: "standard",
      image: "inline",
      limit: 12,
      defaultTags: ["anime", "news"],
    },
    web: {
      urls: ["https://honeysanime.com/category/news", "https://honeysanime.com"],
      selectors: ["article", ".post", ".entry", ".news-item", 'a[href*="/2026/"]'],
      baseUrl: "https://honeysanime.com",
      limit: 10,
      defaultTags: ["anime", "music", "anisong"],
    },
  },
  {
    key: "otakunewsnew",
    name: "Otaku News",
    rss: {
      url: "https://www.otakunews.com/rss/rss.xml",
      kind: "standard",
      image: "og",
      limit: 12,
      defaultTags: ["anime", "otaku"],
    },
    web: {
      urls: ["https://www.otakunews.com", "https://www.otakunews.com/News"],
      selectors: ["article", ".post", ".entry", ".news-item", ".article-card", 'a[href*="/Article/"]'],
      baseUrl: "https://www.otakunews.com",
      limit: 10,
      defaultTags: ["anime", "otaku", "uk"],
    },
  },


];
