/**
 * Slug generation. Ported from temp/AniNewsAPI/utils/generateSlug.js, but the
 * original appended a non-deterministic in-memory daily counter, which made
 * slugs unstable across process restarts. Dedup keys on the normalized `link`
 * instead (see fetchAllSources / newsRefresh job), so a deterministic
 * `source-title` slug is both sufficient and stable.
 */
export function generateSlug(title: string, source: string): string {
  const cleanTitle = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .substring(0, 80)
    .replace(/-+$/g, "");
  const cleanSource = source
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return `${cleanSource}-${cleanTitle}`;
}

/**
 * Normalize a URL for dedup: force protocol-relative to https, lowercase host,
 * drop a trailing slash and the query/hash. Two links that differ only by
 * tracking params or a trailing slash collapse to one key.
 */
export function normalizeLink(link: string): string {
  if (!link) return "";
  let url = link.trim();
  if (url.startsWith("//")) url = `https:${url}`;
  try {
    const u = new URL(url);
    const host = u.host.toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${host}${path}`.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}
