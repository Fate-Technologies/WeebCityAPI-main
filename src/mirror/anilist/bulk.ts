/**
 * Bulk AniList operations shared by the dataset scraper (scripts/scrape.ts) and
 * the freshness refresher (src/anilist/refresh.ts, scripts/refresh.ts).
 *
 * All upstream calls go through the rate-limited `anilistRequest`, and every
 * node is persisted through the same normalizeMedia -> persistMedia pipeline the
 * live fallback and CSV importer use, so the stored shape is identical everywhere.
 */
import { prisma } from '../db.js';
import { anilistRequest } from './client.js';
import {
  MEDIA_PAGE_BY_IDS, MEDIA_PAGE_BY_IDS_ANY, MEDIA_PAGE_TRENDING, MAX_MEDIA_ID,
  MEDIA_PAGE_BY_DATE, MEDIA_DATE_PROBE,
} from './queries.js';
import { normalizeMedia, type RawMediaNode } from './ingest.js';
import { persistMedia } from './persist.js';

export type MediaType = 'ANIME' | 'MANGA';

/** Highest media id currently on AniList (upper bound for a full scan). */
export async function fetchMaxMediaId(): Promise<number> {
  const data = await anilistRequest<{ Page: { media: { id: number }[] } }>(MAX_MEDIA_ID, {});
  return data?.Page?.media?.[0]?.id ?? 0;
}

/** Fetch up to 50 fully-hydrated media by explicit ids. Filters to `type` when given. */
export async function fetchMediaByIds(ids: number[], type?: MediaType | null): Promise<RawMediaNode[]> {
  if (!ids.length) return [];
  const data = type
    ? await anilistRequest<{ Page: { media: RawMediaNode[] } }>(MEDIA_PAGE_BY_IDS, { ids, type })
    : await anilistRequest<{ Page: { media: RawMediaNode[] } }>(MEDIA_PAGE_BY_IDS_ANY, { ids });
  return data?.Page?.media ?? [];
}

/**
 * True when a start-date range holds more than 5000 entries and must be split.
 * AniList caps deep paging at 5000 entries (page 100 @ perPage 50); if page 100
 * still reports hasNextPage, a 101st page exists and the range overflows.
 */
export async function probeDateOverflow(type: MediaType, gt: number, lt: number): Promise<boolean> {
  const data = await anilistRequest<{ Page: { pageInfo: { hasNextPage: boolean } } }>(
    MEDIA_DATE_PROBE, { type, gt, lt },
  );
  return data?.Page?.pageInfo?.hasNextPage ?? false;
}

/** Fetch one page (50) of media whose start date falls in a FuzzyDateInt range. */
export async function fetchMediaByDatePage(
  type: MediaType, gt: number, lt: number, page: number,
): Promise<{ nodes: RawMediaNode[]; hasNext: boolean }> {
  const data = await anilistRequest<{ Page: { pageInfo: { hasNextPage: boolean }; media: RawMediaNode[] } }>(
    MEDIA_PAGE_BY_DATE, { type, gt, lt, page },
  );
  return { nodes: data?.Page?.media ?? [], hasNext: data?.Page?.pageInfo?.hasNextPage ?? false };
}

/** Fetch the top trending media of a type (paged, `count` total). */
export async function fetchTrending(type: MediaType, count: number): Promise<RawMediaNode[]> {
  const perPage = 50;
  const out: RawMediaNode[] = [];
  for (let page = 1; out.length < count; page++) {
    const data = await anilistRequest<{ Page: { pageInfo: { hasNextPage: boolean }; media: RawMediaNode[] } }>(
      MEDIA_PAGE_TRENDING, { page, perPage, type },
    );
    const media = data?.Page?.media ?? [];
    out.push(...media);
    if (!media.length || !data?.Page?.pageInfo?.hasNextPage) break;
    if (page >= 100) break; // AniList hard page-depth cap
  }
  return out.slice(0, count);
}

/** Persist a batch of media nodes; returns how many rows were written. */
export async function persistNodes(nodes: (RawMediaNode | null | undefined)[]): Promise<number> {
  let n = 0;
  for (const node of nodes) {
    if (!node?.id) continue;
    await persistMedia(prisma, normalizeMedia(node));
    n++;
  }
  return n;
}

/** Tally format/country of a batch, for scraper progress output. */
export function tally(nodes: RawMediaNode[], into: Record<string, number>, key: 'format' | 'countryOfOrigin'): void {
  for (const node of nodes) {
    const v = (node[key] as string | null | undefined) ?? 'null';
    into[v] = (into[v] ?? 0) + 1;
  }
}
