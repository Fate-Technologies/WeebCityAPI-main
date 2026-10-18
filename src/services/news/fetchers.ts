/**
 * Config-driven fetch pipeline. AniNewsAPI shipped 13 near-identical
 * hand-written fetchers (RSS-primary → web-scrape fallback, plus a couple of
 * special cases); this collapses them into one generic RSS fetcher, one
 * generic web scraper, and a MAL-specific scraper, all driven by SourceConfig.
 */
import * as cheerio from "cheerio";
import Parser from "rss-parser";
import he from "he";
import type { Article, RssConfig, WebConfig, RssItem, SourceConfig } from "./types.js";
import { REQUEST_TIMEOUT } from "./constants.js";
import { httpGet } from "./httpClient.js";
import { generateSlug } from "./generateSlug.js";
import { parse, parseMALDate } from "./dateParser.js";
import { extractImage, normalizeUrl, fetchArticleImage } from "./extractImage.js";

const rssParser = new Parser({
  customFields: {
    item: [
      ["media:thumbnail", "media:thumbnail"],
      ["content:encoded", "content:encoded"],
    ],
  },
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Strip HTML tags, decode entities, collapse whitespace. */
function cleanText(input: string): string {
  if (!input) return "";
  return he.decode(input.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Resolve a possibly-relative href against the source's base URL. */
function absolutize(link: string, baseUrl: string): string {
  if (!link) return "";
  if (link.startsWith("http")) return link;
  if (link.startsWith("//")) return `https:${link}`;
  return `${baseUrl}${link}`;
}

/** Generic RSS / Google-News-search fetcher. */
async function fetchRss(cfg: RssConfig, name: string, key: string): Promise<Article[]> {
  const xml = await httpGet(cfg.url, REQUEST_TIMEOUT);
  const feed = await rssParser.parseString(xml);
  const items = (feed.items || []).slice(0, cfg.limit) as unknown as RssItem[];
  const out: Article[] = [];

  for (const item of items) {
    let title = (item.title || "").trim();
    if (!title || !item.link) continue;

    // Google News appends " - <Publisher>" to every headline.
    if (cfg.kind === "gnews" && cfg.stripSuffixes) {
      for (const suffix of cfg.stripSuffixes) {
        if (title.endsWith(suffix)) {
          title = title.slice(0, -suffix.length).trim();
          break;
        }
      }
    }

    const excerpt = cleanText(item.contentSnippet || item.content || "");
    const date = parse(item.pubDate || item.isoDate, new Date());
    const tags =
      item.categories && item.categories.length
        ? item.categories.map((c) => String(c).toLowerCase())
        : [...cfg.defaultTags];

    let image = "";
    if (cfg.image === "inline") {
      image = extractImage(item);
    } else if (cfg.image === "gnews") {
      const html = (item["content:encoded"] as string) || item.content || "";
      const m = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
      image = m ? normalizeUrl(m[1]) : "";
    }

    out.push({
      title,
      slug: generateSlug(title, key),
      source: name,
      excerpt,
      date: date.toISOString(),
      image,
      link: item.link,
      tags,
    });
  }

  // Feeds with no inline images: enrich from each article's OG tags.
  if (cfg.image === "og") {
    await Promise.all(
      out.map(async (a) => {
        a.image = await fetchArticleImage(a.link);
      }),
    );
  }

  return out;
}

/** Generic web scraper: walk candidate selectors until one yields articles. */
async function fetchWeb(cfg: WebConfig, name: string, key: string, urlIndex: number): Promise<Article[]> {
  const url = cfg.urls[urlIndex];
  if (!url) return [];
  const html = await httpGet(url, REQUEST_TIMEOUT);
  const $ = cheerio.load(html);
  const out: Article[] = [];
  const excerptSel = [...(cfg.excerptSelectors || []), "p", ".excerpt", ".summary", ".description"].join(", ");

  for (const selector of cfg.selectors) {
    $(selector).each((_i, el) => {
      if (out.length >= cfg.limit) return false;
      const $el = $(el);
      const title =
        $el.find("h2, h3, .title, .entry-title").first().text().trim() ||
        ($el.attr("title") || "").trim();
      if (!title) return;

      const excerpt = cleanText($el.find(excerptSel).first().text());
      const dateText =
        $el.find("time, .date, .published").first().text().trim() ||
        $el.find("time").attr("datetime") ||
        "";
      const date = parse(dateText, new Date());
      const image = $el.find("img").first().attr("src") || "";
      const rawLink = $el.find("a").first().attr("href") || $el.attr("href") || "";
      const link = absolutize(rawLink, cfg.baseUrl);
      if (!link) return;

      out.push({
        title,
        slug: generateSlug(title, key),
        source: name,
        excerpt,
        date: date.toISOString(),
        image: normalizeUrl(image),
        link,
        tags: [...cfg.defaultTags],
      });
    });
    if (out.length > 0) break;
  }

  return out;
}

/** MyAnimeList is scrape-only: no RSS, lazy images, MAL-format dates. */
async function fetchMalPage(pageUrl: string): Promise<Article[]> {
  const html = await httpGet(pageUrl, REQUEST_TIMEOUT, { Cookie: "mqlid=1; is_logged_in=0" });
  const $ = cheerio.load(html);
  const out: Article[] = [];

  $(".news-unit").each((_i, el) => {
    if (out.length >= 15) return false;
    const $el = $(el);
    const title = $el.find(".title").first().text().trim();
    const rawLink = $el.find("a.title, a").first().attr("href") || "";
    if (!title || !rawLink) return;

    const excerpt = cleanText($el.find(".text").first().text());
    const dateText = $el.find(".info .date, .date, time").first().text().trim();
    const date = parseMALDate(dateText, new Date());
    const img = $el.find("img").first();
    const image = img.attr("data-src") || img.attr("src") || "";
    const link = rawLink.startsWith("http") ? rawLink : `https://myanimelist.net${rawLink}`;

    out.push({
      title,
      slug: generateSlug(title, "myanimelist"),
      source: "MyAnimeList",
      excerpt,
      date: date.toISOString(),
      image: normalizeUrl(image),
      link,
      tags: ["official", "news"],
    });
  });

  return out;
}

/** MAL entry point: page 1, plus page 2 when page 1 is thin. */
export async function fetchMal(retries = 2): Promise<Article[]> {
  for (let i = 0; i <= retries; i++) {
    try {
      const articles = await fetchMalPage("https://myanimelist.net/news");
      if (articles.length < 10) {
        const more = await fetchMalPage("https://myanimelist.net/news?p=2").catch(() => []);
        const seen = new Set(articles.map((a) => a.link));
        for (const a of more) if (!seen.has(a.link)) articles.push(a);
      }
      if (articles.length > 0) return articles;
      if (i < retries) await sleep(1000 * (i + 1));
    } catch {
      if (i < retries) await sleep(1000 * (i + 1));
    }
  }
  return [];
}

/** Try each web URL variant in order until one yields articles. */
async function tryWeb(source: SourceConfig): Promise<Article[]> {
  if (!source.web) return [];
  for (let idx = 0; idx < source.web.urls.length; idx++) {
    const arts = await fetchWeb(source.web, source.name, source.key, idx).catch(() => []);
    if (arts.length > 0) return arts;
  }
  return [];
}

/**
 * Fetch one source with the same retry/backoff AniNewsAPI used: RSS-primary
 * (or web-primary when `webFirst`), fall back to the other, retry with linear
 * backoff. `custom` sources (MAL) bypass the generic pipeline. Never throws.
 */
export async function runSource(source: SourceConfig, retries = 2): Promise<Article[]> {
  if (source.custom) return source.custom(retries).catch(() => []);

  for (let i = 0; i <= retries; i++) {
    try {
      let articles: Article[] = [];
      if (source.webFirst) {
        articles = await tryWeb(source);
        if (articles.length === 0 && source.rss) {
          articles = await fetchRss(source.rss, source.name, source.key).catch(() => []);
        }
      } else {
        if (source.rss) {
          articles = await fetchRss(source.rss, source.name, source.key).catch(() => []);
        }
        if (articles.length === 0) articles = await tryWeb(source);
      }
      if (articles.length > 0) return articles;
      if (i < retries) await sleep(1000 * (i + 1));
    } catch {
      if (i < retries) await sleep(1000 * (i + 1));
    }
  }
  return [];
}

