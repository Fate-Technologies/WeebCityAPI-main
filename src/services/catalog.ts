import { hasSupabase } from "../config/env.js";
import { log } from "../config/logger.js";
import { prisma } from "../mirror/db.js";
import { anilistClient } from "../providers/anilist/client.js";
import {
  QUERY_GENRE_COLLECTION,
  QUERY_MEDIA,
  QUERY_MEDIA_BY_MAL,
  QUERY_NEXT_AIRING,
  QUERY_PAGE,
  QUERY_SEARCH,
  QUERY_STUDIO_SEARCH,
  QUERY_TAG_COLLECTION,
  QUERY_TRENDING,
} from "../providers/anilist/queries.js";
import type { AniListMedia } from "../providers/anilist/types.js";
import { jikanClient } from "../providers/jikan/client.js";
import { jikanToAniListShape } from "../providers/jikan/mapper.js";
import { anilistToTatakaiMedia } from "./normalize.js";
import { upsertFromAniListMedia } from "./contentIngestion.js";
import * as repo from "./contentRepository.js";
import { saveFeed } from "./contentFeeds.js";
import type { HomePageBundle, TatakaiMedia } from "../types/tatakaiMedia.js";
import type { ContentSearchResult } from "../types/tatakaiMedia.js";
import type { SearchParams } from "./searchService.js";
import { searchContent } from "./searchService.js";
import {
  resolveAnimeMappingByAniListId,
  resolveAnimeMappingByMalId,
  resolveMangaMappingByAniListId,
  resolveMangaMappingByMalId,
} from "./mapping/mappingResolver.js";
import type { AnimeMapping, MangaMapping } from "./mapping/types.js";

type MetaSource = "anilist" | "jikan" | "db" | "mixed";

async function maybeUpsert(raw: AniListMedia) {
  if (!hasSupabase) return;
  try {
    await upsertFromAniListMedia(raw);
  } catch {
    /* ignore single-row ingest failures */
  }
}

/**
 * Mirror-row presence + lock state in a single PK lookup.
 *
 * `present` — the Tiger DB (AniList mirror) genuinely holds this id. Now that the
 * catalog is served in-process from the mirror, ANY present row is "in the
 * Tatakai DB", so the read path reports it as `source: "db"` and stamps
 * `source_api: "tatakai"` even when it isn't locked — that's what lights up the
 * "In Tatakai DB" badge for the 24k+ stored titles.
 *
 * `locked` — an admin curated this row. Locked rows are authoritative: prefer
 * them over the legacy Supabase shadow and never re-upsert (that would clobber
 * the curated values on the next sync).
 *
 * Resilient to a down mirror (returns both false → previous Supabase-first
 * behaviour, and an upstream-fallback row correctly stays "anilist").
 */
async function getMirrorPresence(id: number): Promise<{ present: boolean; locked: boolean }> {
  try {
    const row = await prisma.media.findUnique({ where: { id }, select: { isLocked: true } });
    return { present: row !== null, locked: row?.isLocked === true };
  } catch {
    return { present: false, locked: false };
  }
}

function slimFeedItems(media: TatakaiMedia[]) {
  return media.map((m) => ({ anilistId: m.anilistId, malId: m.malId, tatakaiId: m.tatakaiId }));
}

function normalizeTitleKey(value?: string | null): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/**
 * Title relevance against a free-text query, lower is better:
 * 0 exact, 1 prefix, 2 word-prefix, 3 substring, 4 no match.
 *
 * The merged search result used to keep source insertion order, and the DB
 * source sorts by popularity — so "Naru" returned whatever was most popular
 * instead of Naruto. `searchAnilist` re-ranks by this score.
 */
function searchMatchScore(media: TatakaiMedia, rawQuery: string): number {
  const query = normalizeTitleKey(rawQuery);
  if (!query) return 0;
  const candidates = [media.titleEnglish, media.titleRomaji, media.titleNative, ...(media.synonyms ?? [])];
  let best = 4;
  for (const title of candidates) {
    const key = normalizeTitleKey(title);
    if (!key) continue;
    if (key === query) return 0;
    if (key.startsWith(query)) {
      best = Math.min(best, 1);
      continue;
    }
    const words = String(title).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (words.some((word) => word.startsWith(query))) best = Math.min(best, 2);
    else if (key.includes(query)) best = Math.min(best, 3);
  }
  return best;
}

/** Studio names resolve to ids once; the vocabulary never changes at runtime. */
const studioIdCache = new Map<string, number | null>();

async function resolveStudioId(name: string): Promise<number | null> {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  if (studioIdCache.has(key)) return studioIdCache.get(key) ?? null;
  let id: number | null = null;
  try {
    const data = await anilistClient.query<{ Studio: { id: number; name: string } | null }>(
      QUERY_STUDIO_SEARCH,
      { search: name.trim() },
    );
    id = data.Studio?.id ?? null;
  } catch {
    id = null;
  }
  studioIdCache.set(key, id);
  return id;
}

function sourceRank(source: TatakaiMedia["source_api"]): number {
  if (source === "tatakai") return 3;
  if (source === "anilist") return 2;
  return 1;
}

function mergeMedia(primary: TatakaiMedia, fallback: TatakaiMedia): TatakaiMedia {
  const merged: TatakaiMedia = {
    ...fallback,
    ...primary,
  };

  merged.anilistId = primary.anilistId || fallback.anilistId;
  merged.malId = primary.malId ?? fallback.malId;
  merged.titleRomaji = primary.titleRomaji || fallback.titleRomaji;
  merged.titleEnglish = primary.titleEnglish ?? fallback.titleEnglish;
  merged.titleNative = primary.titleNative ?? fallback.titleNative;
  merged.synonyms = primary.synonyms?.length ? primary.synonyms : fallback.synonyms ?? [];
  merged.genres = primary.genres?.length ? primary.genres : fallback.genres ?? [];
  merged.tags = primary.tags?.length ? primary.tags : fallback.tags ?? [];
  merged.studios = primary.studios?.length ? primary.studios : fallback.studios ?? [];
  merged.externalLinks = primary.externalLinks?.length ? primary.externalLinks : fallback.externalLinks;
  merged.streamingEpisodes = primary.streamingEpisodes?.length ? primary.streamingEpisodes : fallback.streamingEpisodes;
  merged.characters = primary.characters?.length ? primary.characters : fallback.characters;
  merged.staff = primary.staff?.length ? primary.staff : fallback.staff;
  merged.relations = primary.relations?.length ? primary.relations : fallback.relations;
  merged.coverImageLarge = primary.coverImageLarge ?? fallback.coverImageLarge;
  merged.coverImageMedium = primary.coverImageMedium ?? fallback.coverImageMedium;
  merged.bannerImage = primary.bannerImage ?? fallback.bannerImage;
  merged.description = primary.description ?? fallback.description;
  merged.averageScore = primary.averageScore ?? fallback.averageScore;
  merged.meanScore = primary.meanScore ?? fallback.meanScore;
  merged.popularity = primary.popularity ?? fallback.popularity;
  merged.favourites = primary.favourites ?? fallback.favourites;
  merged.format = primary.format ?? fallback.format;
  merged.status = primary.status ?? fallback.status;
  merged.season = primary.season ?? fallback.season;
  merged.seasonYear = primary.seasonYear ?? fallback.seasonYear;
  merged.episodes = primary.episodes ?? fallback.episodes;
  merged.duration = primary.duration ?? fallback.duration;
  merged.nextAiringEpisode = primary.nextAiringEpisode ?? fallback.nextAiringEpisode;
  merged.trailerUrl = primary.trailerUrl ?? fallback.trailerUrl;
  merged.isAdult = primary.isAdult ?? fallback.isAdult;
  merged.countryOfOrigin = primary.countryOfOrigin ?? fallback.countryOfOrigin;
  merged.source_api = primary.source_api;
  merged.fetchedAt = primary.fetchedAt ?? fallback.fetchedAt;

  return merged;
}

function matchesSearchFilters(media: TatakaiMedia, p: SearchParams): boolean {
  if (p.isAdult === false && media.isAdult) return false;

  if (p.format?.length && media.format && !p.format.includes(media.format)) return false;
  if (p.status?.length && media.status && !p.status.includes(media.status)) return false;
  if (p.genres?.length) {
    const normalized = media.genres.map((g) => g.toLowerCase());
    const target = p.genres.map((g) => g.toLowerCase());
    if (!target.every((g) => normalized.includes(g))) return false;
  }

  const year = media.seasonYear ?? media.startDate?.year;
  if (p.yearMin && year && year < p.yearMin) return false;
  if (p.yearMax && year && year > p.yearMax) return false;

  if (p.scoreMin != null && media.averageScore != null && media.averageScore < p.scoreMin) return false;
  if (p.scoreMax != null && media.averageScore != null && media.averageScore > p.scoreMax) return false;

  if (p.epMin != null && media.episodes != null && media.episodes < p.epMin) return false;
  if (p.epMax != null && media.episodes != null && media.episodes > p.epMax) return false;

  return true;
}

async function resolveMappingForMedia(media: TatakaiMedia): Promise<AnimeMapping | MangaMapping | null> {
  const isManga = media.chapters !== undefined || media.volumes !== undefined;
  if (media.anilistId) {
    if (isManga) {
      const mapping = await resolveMangaMappingByAniListId(media.anilistId).catch(() => null);
      if (mapping) return mapping;
    }
    const mapping = await resolveAnimeMappingByAniListId(media.anilistId).catch(() => null);
    if (mapping) return mapping;
  }
  if (media.malId) {
    if (isManga) {
      const mapping = await resolveMangaMappingByMalId(media.malId).catch(() => null);
      if (mapping) return mapping;
    }
    return resolveAnimeMappingByMalId(media.malId).catch(() => null);
  }
  return null;
}

async function normalizeSearchMedia(media: TatakaiMedia): Promise<{ key: string; media: TatakaiMedia; rank: number }> {
  const mapping = await resolveMappingForMedia(media);
  const normalized: TatakaiMedia = { ...media };

  if (mapping?.anilist_id && (!normalized.anilistId || normalized.anilistId === 0)) {
    normalized.anilistId = mapping.anilist_id;
  }
  if (mapping?.mal_id && !normalized.malId) {
    normalized.malId = mapping.mal_id;
  }

  const anidbId =
    mapping && "anidb_id" in mapping && typeof mapping.anidb_id === "number"
      ? mapping.anidb_id
      : null;

  const key =
    anidbId
      ? `anidb:${anidbId}`
      : normalized.anilistId
        ? `anilist:${normalized.anilistId}`
        : normalized.malId
          ? `mal:${normalized.malId}`
          : `title:${normalizeTitleKey(normalized.titleRomaji || normalized.titleEnglish || normalized.titleNative)}`;

  return { key, media: normalized, rank: sourceRank(normalized.source_api) };
}

async function fetchTrending(page: number, perPage: number): Promise<{ media: TatakaiMedia[]; source: MetaSource }> {
  // Trending is volatile — always read real AniList, never the mirror's snapshot.
  const pageData = await anilistClient.pageMedia({ page, perPage }, QUERY_TRENDING, { forceUpstream: true });
  const media = pageData.media.map((m) => anilistToTatakaiMedia(m));
  // Cache enrichment is independent of delivering the response — a sequential
  // upsert per row on a cold DB connection used to gate the whole bundle past
  // the request timeout. Run it in the background instead.
  void (async () => {
    for (const raw of pageData.media) await maybeUpsert(raw);
  })();
  if (hasSupabase) void saveFeed("trending", slimFeedItems(media), null, null).catch(() => {});
  return { media, source: "anilist" };
}

async function fetchPageSort(
  sort: string,
  page: number,
  perPage: number,
  extra?: Record<string, unknown>,
  opts?: { forceUpstream?: boolean },
): Promise<{ media: TatakaiMedia[]; source: MetaSource }> {
  const variables = { page, perPage, sort: [sort], ...extra };
  const pageData = await anilistClient.pageMedia(variables, QUERY_PAGE, opts);
  const media = pageData.media.map((m) => anilistToTatakaiMedia(m));
  // Same as above: never let row-by-row enrichment gate the response.
  void (async () => {
    for (const raw of pageData.media) await maybeUpsert(raw);
  })();
  return { media, source: "anilist" };
}

export async function getTrending(page: number, perPage: number) {
  return fetchTrending(page, perPage);
}

export async function getPopular(page: number, perPage: number) {
  return fetchPageSort("POPULARITY_DESC", page, perPage);
}

export async function getTopRated(page: number, perPage: number) {
  return fetchPageSort("SCORE_DESC", page, perPage);
}

export async function getSeasonal(season: string, year: number, page: number, perPage: number) {
  // Current-season/airing content ("latest episodes", "top airing") is volatile.
  return fetchPageSort("POPULARITY_DESC", page, perPage, { season, seasonYear: year }, { forceUpstream: true });
}

export async function getUpcoming(page: number, perPage: number) {
  // Upcoming/next-season announcements are volatile — read real AniList.
  return fetchPageSort("POPULARITY_DESC", page, perPage, { status: "NOT_YET_RELEASED" }, { forceUpstream: true });
}

export async function getGenresList(): Promise<string[]> {
  const data = await anilistClient.query<{ GenreCollection: { genre: string }[] }>(QUERY_GENRE_COLLECTION);
  return (data.GenreCollection ?? []).map((g) => g.genre).filter(Boolean);
}

export interface MediaTag {
  id: number;
  name: string;
  description: string | null;
  category: string | null;
  rank: number | null;
  isGeneralSpoiler: boolean;
  isAdult: boolean;
}

/**
 * The AniList tag vocabulary behind the search page's advanced filters. Tags
 * are the finer-grained siblings of genres ("Cultivation", "Villainess");
 * media-spoiler tags are dropped because naming one spoils the show.
 */
export async function getTagsList(): Promise<MediaTag[]> {
  const data = await anilistClient.query<{
    MediaTagCollection: Array<{
      id: number;
      name: string;
      description?: string | null;
      category?: string | null;
      rank?: number | null;
      isGeneralSpoiler?: boolean;
      isMediaSpoiler?: boolean;
      isAdult?: boolean;
    }>;
  }>(QUERY_TAG_COLLECTION);
  return (data.MediaTagCollection ?? [])
    .filter((tag) => tag && tag.name && !tag.isMediaSpoiler)
    .map((tag) => ({
      id: tag.id,
      name: tag.name,
      description: tag.description ?? null,
      category: tag.category ?? null,
      rank: tag.rank ?? null,
      isGeneralSpoiler: Boolean(tag.isGeneralSpoiler),
      isAdult: Boolean(tag.isAdult),
    }));
}

export async function searchAnilist(p: SearchParams): Promise<ContentSearchResult> {
  const qtext = p.query ?? p.q;
  const hasFilters = !!(p.genres?.length || p.tags?.length || p.studio?.length || p.format?.length || p.status?.length || p.yearMin || p.yearMax || p.scoreMin || p.scoreMax || p.epMin || p.epMax);

  // The DB has no tag or studio columns, so its rows can't honour those
  // filters — including them would flood a tag/studio browse with unrelated
  // popular titles.
  const dbCanHonourFilters = !p.tags?.length && !p.studio?.length;
  let dbResult: ContentSearchResult | null = null;
  if (hasSupabase && dbCanHonourFilters && (qtext?.trim() || hasFilters)) {
    try {
      dbResult = await searchContent({ ...p, q: qtext });
    } catch {
      /* fall through */
    }
  }

  const sortKey = (p.sortBy ?? p.sort ?? "SEARCH_MATCH") as string;
  // If isAdult is true, we pass undefined to AniList to "include" adult content (show both)
  // If isAdult is false, we pass false to AniList to "hide" adult content
  const isAdultParam = p.isAdult === true ? undefined : false;

  const studioId = p.studio?.length ? await resolveStudioId(p.studio[0]) : null;
  // An unresolvable studio name must not degrade into an unfiltered search.
  const studioUnresolved = Boolean(p.studio?.length) && studioId == null;

  const variables: Record<string, unknown> = {
    page: p.page,
    perPage: p.perPage,
    search: qtext?.trim() ? qtext : undefined,
    genres: p.genres?.length ? p.genres : undefined,
    tags: p.tags?.length ? p.tags : undefined,
    studioId: studioId ?? undefined,
    season: p.season?.[0] ?? undefined,
    seasonYear: p.yearMin ?? undefined,
    format: p.format?.length ? p.format : undefined,
    status: p.status?.length ? p.status : undefined,
    isAdult: isAdultParam,
    sort: [qtext?.trim() ? (sortKey === "SEARCH_MATCH" ? "SEARCH_MATCH" : sortKey) : "POPULARITY_DESC"],
    averageScoreGreater: p.scoreMin,
    averageScoreLesser: p.scoreMax,
    episodesGreater: p.epMin,
    episodesLesser: p.epMax,
  };
  let anilistPage: { media: TatakaiMedia[]; pageInfo: ContentSearchResult["pageInfo"] } | null = null;
  if (!studioUnresolved && (qtext?.trim() || hasFilters)) {
    try {
      const pageData = await anilistClient.pageMedia(variables, QUERY_SEARCH);
      const media = pageData.media.map((m) => anilistToTatakaiMedia(m));
      // Cache enrichment is independent of delivering the search page.
      void (async () => {
        for (const raw of pageData.media) await maybeUpsert(raw);
      })();
      anilistPage = {
        media,
        pageInfo: {
          total: pageData.pageInfo.total,
          currentPage: pageData.pageInfo.currentPage,
          lastPage: pageData.pageInfo.lastPage,
          hasNextPage: pageData.pageInfo.hasNextPage,
          perPage: pageData.pageInfo.perPage,
        },
      };
    } catch {
      /* fall through to DB/Jikan */
    }
  }

  let jikanPage:
    | { media: TatakaiMedia[]; pagination: { has_next_page: boolean; last_visible_page: number; items?: { total: number } } }
    | null = null;
  if (qtext?.trim()) {
    try {
      const jikanRes = await jikanClient.searchAnime(qtext.trim(), p.page, p.perPage);
      const jikanMedia = jikanRes.data
        .map((row) => anilistToTatakaiMedia(jikanToAniListShape(row, null), "jikan"))
        .filter((row) => matchesSearchFilters(row, p));
      jikanPage = { media: jikanMedia, pagination: jikanRes.pagination };
    } catch {
      /* ignore jikan failures */
    }
  }

  const candidates: TatakaiMedia[] = [];
  if (dbResult?.media?.length) candidates.push(...dbResult.media);
  if (anilistPage?.media?.length) candidates.push(...anilistPage.media);
  if (jikanPage?.media?.length) candidates.push(...jikanPage.media);

  const normalized = await Promise.all(candidates.map((m) => normalizeSearchMedia(m)));
  const merged = new Map<string, { media: TatakaiMedia; rank: number }>();

  for (const item of normalized) {
    const existing = merged.get(item.key);
    if (!existing) {
      merged.set(item.key, { media: item.media, rank: item.rank });
      continue;
    }

    const primary = item.rank >= existing.rank ? item.media : existing.media;
    const fallback = item.rank >= existing.rank ? existing.media : item.media;
    const nextRank = Math.max(item.rank, existing.rank);
    merged.set(item.key, { media: mergeMedia(primary, fallback), rank: nextRank });
  }

  const mergedMedia = Array.from(merged.values()).map((entry) => entry.media);
  // Re-rank by title relevance. The merge preserves source insertion order and
  // the DB source sorts by popularity, so without this "Naru" surfaced whatever
  // was most popular rather than Naruto. Ties keep the source order, which for
  // AniList is its own SEARCH_MATCH ranking.
  const query = qtext?.trim() ?? "";
  const media = query
    ? mergedMedia
        .map((m, index) => ({ m, index, score: searchMatchScore(m, query) }))
        .sort((a, b) => a.score - b.score || a.index - b.index)
        .map((entry) => entry.m)
    : mergedMedia;
  const totals = [
    dbResult?.pageInfo.total,
    anilistPage?.pageInfo.total,
    jikanPage?.pagination?.items?.total,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const total = totals.length ? Math.max(...totals) : media.length;
  const lastPage = Math.max(1, Math.ceil(total / p.perPage));
  const hasNextPage = [
    dbResult?.pageInfo.hasNextPage,
    anilistPage?.pageInfo.hasNextPage,
    jikanPage?.pagination?.has_next_page,
  ].some(Boolean);

  return {
    media,
    pageInfo: {
      total,
      currentPage: p.page,
      lastPage,
      hasNextPage,
      perPage: p.perPage,
    },
  };
}

export async function getMediaByAnilistId(id: number): Promise<{ media: TatakaiMedia; source: MetaSource } | null> {
  // An admin-locked mirror row is authoritative — skip the Supabase shadow and
  // don't re-upsert it (that would clobber the curated values on the next sync).
  const { present, locked } = await getMirrorPresence(id);

  if (hasSupabase && !locked) {
    const db = await repo.findByAnilistId(id);
    if (db) {
      log.info({ diag: "media-resolve", by: "anilist", id, source: "db" }, "[media-resolve] db hit");
      return { media: db, source: "db" };
    }
  }
  const data = await anilistClient.query<{ Media: AniListMedia | null }>(QUERY_MEDIA, { id }, {
    diag: `media-by-anilist:${id}`,
  });
  if (!data.Media) {
    // NOTE: the in-process mirror returns `{ Media: null }` for an id it doesn't
    // have — a *valid* GraphQL response, so AniListClient treats it as a hit and
    // does NOT fall back to upstream. Result: any title present on real AniList
    // but not yet in the mirror resolves to null here → 404 → "details not
    // available" on the detail page. This log line is where that surfaces.
    log.warn(
      { diag: "media-resolve", by: "anilist", id, hasSupabase, reason: "Media null (mirror miss w/o upstream fallback, or upstream empty)" },
      "[media-resolve] NULL → 404",
    );
    return null;
  }
  if (!locked) await maybeUpsert(data.Media);
  const after = hasSupabase && !locked ? await repo.findByAnilistId(id) : null;
  // A row that lives in the mirror (Tiger DB) — locked or not — is served from
  // our own catalog, so report "db" and stamp source_api: "tatakai" so the
  // frontend "In Tatakai DB" badge lights up. Only a genuine mirror miss served
  // via upstream fallback stays "anilist".
  const inMirror = present || locked;
  const source: MetaSource = after || inMirror ? "db" : "anilist";
  log.info({ diag: "media-resolve", by: "anilist", id, source, locked, present }, "[media-resolve] resolved");
  return {
    media: after ?? anilistToTatakaiMedia(data.Media, inMirror ? "tatakai" : "anilist"),
    source,
  };
}

/**
 * Live next-airing schedule for an anime — always fetched from real AniList
 * (`forceUpstream`), never from the mirror/DB.
 *
 * The info page's next-episode countdown must reflect the real airing schedule,
 * which drifts (delays, breaks) faster than the mirror is refreshed. Returns
 * null on any error or for a title AniList doesn't know — callers fall back to
 * ani.zip / Jikan.
 */
export async function getLiveNextAiring(anilistId: number): Promise<{
  status: string | null;
  episodes: number | null;
  nextAiringEpisode: { episode: number; airingAt: number; timeUntilAiring: number } | null;
} | null> {
  if (!Number.isFinite(anilistId) || anilistId <= 0) return null;
  try {
    const data = await anilistClient.query<{
      Media: {
        id: number;
        status?: string | null;
        episodes?: number | null;
        nextAiringEpisode?: { episode: number; airingAt: number; timeUntilAiring: number } | null;
      } | null;
    }>(QUERY_NEXT_AIRING, { id: anilistId }, { forceUpstream: true, diag: `next-airing:${anilistId}` });
    if (!data.Media) return null;
    return {
      status: data.Media.status ?? null,
      episodes: data.Media.episodes ?? null,
      nextAiringEpisode: data.Media.nextAiringEpisode ?? null,
    };
  } catch (err) {
    log.warn(
      { diag: "next-airing", anilistId, err: (err as Error).message },
      "[next-airing] live upstream fetch failed",
    );
    return null;
  }
}

export async function getMediaByMalId(malId: number): Promise<{ media: TatakaiMedia; source: MetaSource } | null> {
  if (hasSupabase) {
    const db = await repo.findByMalId(malId);
    if (db) {
      log.info({ diag: "media-resolve", by: "mal", malId, source: "db" }, "[media-resolve] db hit");
      return { media: db, source: "db" };
    }
  }
  try {
    const data = await anilistClient.query<{ Media: AniListMedia | null }>(QUERY_MEDIA_BY_MAL, { idMal: malId }, {
      diag: `media-by-mal:${malId}`,
    });
    if (data.Media) {
      await maybeUpsert(data.Media);
      const after = hasSupabase ? await repo.findByMalId(malId) : null;
      // Confirm mirror presence by the resolved AniList id so a mirror-served
      // row reports "db" + source_api: "tatakai" (lights the "In Tatakai DB"
      // badge); an upstream-fallback row stays "anilist".
      const present = data.Media.id ? (await getMirrorPresence(data.Media.id)).present : false;
      const source: MetaSource = after || present ? "db" : "anilist";
      log.info({ diag: "media-resolve", by: "mal", malId, source, present }, "[media-resolve] resolved");
      return {
        media: after ?? anilistToTatakaiMedia(data.Media, present ? "tatakai" : "anilist"),
        source,
      };
    }
  } catch (err) {
    log.warn(
      { diag: "media-resolve", by: "mal", malId, err: (err as Error).message },
      "[media-resolve] anilist-by-mal threw — falling through to Jikan",
    );
  }
  try {
    const full = await jikanClient.getAnimeFull(malId);
    const shaped = jikanToAniListShape(full, null);
    const media = anilistToTatakaiMedia(shaped, "jikan");
    log.info({ diag: "media-resolve", by: "mal", malId, source: "jikan" }, "[media-resolve] resolved via Jikan");
    return { media, source: "jikan" };
  } catch (err) {
    log.warn(
      { diag: "media-resolve", by: "mal", malId, err: (err as Error).message },
      "[media-resolve] Jikan fallback failed → NULL → 404",
    );
    return null;
  }
}

export async function getJikanAnimeEpisodes(malId: number, page = 1) {
  return jikanClient.getAnimeEpisodes(malId, page);
}

export async function getJikanAnimeFull(malId: number) {
  return jikanClient.getAnimeFull(malId);
}

export async function resolveIdParam(
  id: string,
): Promise<{ media: TatakaiMedia; source: MetaSource } | null> {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  if (uuid && hasSupabase) {
    const db = await repo.findByTatakaiId(id);
    if (db) {
      log.info({ diag: "media-resolve", by: "param", id, branch: "uuid", source: "db" }, "[media-resolve] uuid db hit");
      return { media: db, source: "db" };
    }
    log.warn({ diag: "media-resolve", by: "param", id, branch: "uuid" }, "[media-resolve] uuid not in db");
  }
  const match = /^(?:(anilist|mal):)?([1-9]\d*)$/.exec(id);
  const num = match ? Number(match[2]) : NaN;
  if (!Number.isSafeInteger(num) || num <= 0) {
    log.warn({ diag: "media-resolve", by: "param", id, branch: "invalid" }, "[media-resolve] non-numeric, non-uuid id → NULL");
    return null;
  }
  if (match?.[1] === 'mal') return getMediaByMalId(num);
  log.info({ diag: "media-resolve", by: "param", id, branch: "numeric→anilist", num }, "[media-resolve] treating id as AniList id");
  return getMediaByAnilistId(num);
}

export async function getHomeBundle(): Promise<HomePageBundle> {
  // Degrade gracefully: a single upstream (AniList/Jikan) failure must not turn
  // the whole home page into a 500. Each source is settled independently and a
  // failed one falls back to an empty list.
  const now = new Date();
  const m = now.getMonth() + 1;
  const y = now.getFullYear();
  const season = m <= 3 ? "WINTER" : m <= 6 ? "SPRING" : m <= 9 ? "SUMMER" : "FALL";

  const [trendingR, popularR, seasonalR, upcomingR, genresR] = await Promise.allSettled([
    fetchTrending(1, 10),
    fetchPageSort("POPULARITY_DESC", 1, 10),
    fetchPageSort("POPULARITY_DESC", 1, 12, { season, seasonYear: y }, { forceUpstream: true }),
    getUpcoming(1, 12),
    getGenresList(),
  ]);

  const mediaOf = (r: PromiseSettledResult<{ media: TatakaiMedia[] }>): TatakaiMedia[] =>
    r.status === "fulfilled" && Array.isArray(r.value?.media) ? r.value.media : [];

  const trending = mediaOf(trendingR);
  const popular = mediaOf(popularR);
  const seasonal = mediaOf(seasonalR);
  const upcoming = mediaOf(upcomingR);
  const genres = genresR.status === "fulfilled" && Array.isArray(genresR.value) ? genresR.value : [];

  const topAiring = seasonal.filter((x) => x.status === "RELEASING").slice(0, 15);
  const latestCompleted = seasonal.filter((x) => x.status === "FINISHED").slice(0, 12);

  return {
    spotlight: trending.slice(0, 8),
    trending,
    topAiring: topAiring.length ? topAiring : trending.slice(0, 15),
    popular,
    topUpcoming: upcoming,
    latestCompleted: latestCompleted.length ? latestCompleted : popular.slice(0, 12),
    top10: {
      today: trending.slice(0, 10),
      week: popular.slice(0, 10),
      month: seasonal.slice(0, 10),
    },
    genres: genres.length ? genres : ["Action", "Adventure", "Comedy", "Drama", "Fantasy", "Romance", "Sci-Fi", "Slice of Life"],
    fetchedAt: Date.now(),
  };
}
