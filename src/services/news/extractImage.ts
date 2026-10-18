/**
 * Image extraction. Ported from temp/AniNewsAPI/utils/extractImage.js.
 * RSS items hide their image in one of several places; some feeds carry none,
 * so those sources fall back to fetching the article page for an OG image.
 */
import * as cheerio from "cheerio";
import type { RssItem } from "./types.js";
import { httpGet } from "./httpClient.js";
import { ARTICLE_TIMEOUT } from "./constants.js";

/** Force protocol-relative to https and strip common CDN resize params. */
export function normalizeUrl(url: string): string {
  if (!url) return "";
  let out = url.trim();
  if (out.startsWith("//")) out = `https:${out}`;
  try {
    const u = new URL(out);
    const drop = ["ssl", "w", "resize", "strip", "fit", "h", "width", "height", "quality"];
    drop.forEach((k) => u.searchParams.delete(k));
    return u.toString();
  } catch {
    return out;
  }
}

/** Pull the best image out of an RSS item, or "" if none is present inline. */
export function extractImage(item: RssItem): string {
  const media = item["media:thumbnail"] as { $?: { url?: string }; url?: string } | undefined;
  const mediaUrl = media?.$?.url || media?.url;
  if (mediaUrl) return normalizeUrl(mediaUrl);

  if (item.enclosure?.url && (item.enclosure.type || "").startsWith("image")) {
    return normalizeUrl(item.enclosure.url);
  }

  const html =
    (item["content:encoded"] as string) ||
    item.content ||
    item.contentSnippet ||
    (item.description as string) ||
    "";
  const m = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? normalizeUrl(m[1]) : "";
}

/**
 * Fetch an article page and return its OG/twitter image (or first article img).
 * Used by feeds whose RSS carries no images. Never throws — returns "".
 */
export async function fetchArticleImage(url: string): Promise<string> {
  try {
    const html = await httpGet(url, ARTICLE_TIMEOUT);
    const $ = cheerio.load(html);
    const src =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") ||
      $("article img").first().attr("src") ||
      "";
    return normalizeUrl(src);
  } catch {
    return "";
  }
}
