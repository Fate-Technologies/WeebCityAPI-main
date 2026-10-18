/**
 * Freshness: keep volatile fields (trending, popularity, nextAiringEpisode,
 * airingSchedule, rankings) current for the titles where they actually move.
 *
 *  - refreshTrending: re-pull the top trending ANIME + MANGA so trend ranks and
 *    scores track AniList.
 *  - refreshCurrentlyAiring: re-pull every locally-stored title that is still
 *    RELEASING or NOT_YET_RELEASED, so "next episode" countdowns stay accurate.
 *
 * Both persist through the shared pipeline and bump `fetchedAt`. Called by the
 * CLI (scripts/refresh.ts) and, optionally, on an interval from the server.
 */
import { prisma } from '../db.js';
import { fetchTrending, fetchMediaByIds, persistNodes, type MediaType } from './bulk.js';

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Re-pull the top `count` trending titles for each given type. */
export async function refreshTrending(types: MediaType[], count: number): Promise<number> {
  let total = 0;
  for (const type of types) {
    const nodes = await fetchTrending(type, count);
    total += await persistNodes(nodes);
  }
  return total;
}

/** Re-pull stored titles that are still airing/releasing so schedules stay live. */
export async function refreshCurrentlyAiring(limit = 2000): Promise<number> {
  const rows = await prisma.media.findMany({
    where: { status: { in: ['RELEASING', 'NOT_YET_RELEASED'] } },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: limit,
  });
  const ids = rows.map((r) => r.id);
  let total = 0;
  for (const batch of chunk(ids, 50)) {
    const nodes = await fetchMediaByIds(batch); // mixed anime/manga -> no type filter
    total += await persistNodes(nodes);
  }
  return total;
}

/** One full freshness pass: airing schedules first, then trending. */
export async function refreshAll(trendingCount: number, airingLimit: number): Promise<{ airing: number; trending: number }> {
  const airing = await refreshCurrentlyAiring(airingLimit);
  const trending = await refreshTrending(['ANIME', 'MANGA'], trendingCount);
  return { airing, trending };
}
