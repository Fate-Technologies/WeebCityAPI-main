import { anilistClient } from "../providers/anilist/client.js";
import {
  QUERY_MANGA_BY_ID,
  QUERY_MANGA_BY_MAL,
  QUERY_MANGA_CARD_PAGE,
  QUERY_MANGA_CARD_SEARCH,
  QUERY_MANGA_PAGE,
  QUERY_MANGA_SEARCH,
} from "../providers/anilist/queries.js";
import type { AniListMedia, AniListPage } from "../providers/anilist/types.js";
import { anilistToTatakaiMedia } from "./normalize.js";
import { upsertMangaMapping } from "./mapping/mangaMapping.js";
import { jikanClient } from "../providers/jikan/client.js";
import type { MangaHomeBundle, TatakaiMedia } from "../types/tatakaiMedia.js";
import { prisma } from "../mirror/db.js";
import { ensureMedia } from "../mirror/anilist/fallback.js";

export type MangaBrowseParams = {
  query?: string;
  page?: number;
  perPage?: number;
  isAdult?: boolean;
  mode?: string;
  sort?: string;
  genre?: string;
  tags?: string[];
  origin?: string;
  format?: string;
  status?: string;
};

export type MangaBrowseResult = {
  media: TatakaiMedia[];
  pageInfo: AniListPage<AniListMedia>["pageInfo"];
};

const SORT_MAP: Record<string, string> = {
  TRENDING_DESC: "TRENDING_DESC",
  POPULARITY_DESC: "POPULARITY_DESC",
  SCORE_DESC: "SCORE_DESC",
  CHAPTERS_DESC: "CHAPTERS_DESC",
  UPDATED_AT_DESC: "UPDATED_AT_DESC",
  START_DATE_DESC: "START_DATE_DESC",
  FAVOURITES_DESC: "FAVOURITES_DESC",
  trending: "TRENDING_DESC",
  popularity: "POPULARITY_DESC",
  rating: "SCORE_DESC",
  latestUpdate: "UPDATED_AT_DESC",
  relevance: "SEARCH_MATCH",
  chapterCount: "CHAPTERS_DESC",
};

const ORIGIN_MAP: Record<string, string> = {
  jp: "JP",
  japan: "JP",
  kr: "KR",
  korea: "KR",
  cn: "CN",
  zh: "CN",
  china: "CN",
  tw: "TW",
};

const FORMAT_MAP: Record<string, string> = {
  manga: "MANGA",
  novel: "NOVEL",
  oneshot: "ONE_SHOT",
  "one_shot": "ONE_SHOT",
};

function resolveSort(params: MangaBrowseParams): string[] {
  const mode = String(params.mode || "").toLowerCase();
  if (params.sort && SORT_MAP[params.sort]) return [SORT_MAP[params.sort]];
  if (mode === "latest" || mode === "new-chap" || mode === "added") return ["UPDATED_AT_DESC"];
  if (mode === "popular" || mode === "explore") return ["POPULARITY_DESC"];
  if (mode === "recommendation" || mode === "foryou") return ["SCORE_DESC"];
  if (mode === "random") return ["POPULARITY_DESC"];
  if (params.query?.trim()) return ["SEARCH_MATCH", "POPULARITY_DESC"];
  return ["TRENDING_DESC"];
}

function resolveOrigin(params: MangaBrowseParams): string | undefined {
  const origin = String(params.origin || "").toLowerCase().trim();
  if (origin && ORIGIN_MAP[origin]) return ORIGIN_MAP[origin];
  const format = String(params.format || "").toLowerCase();
  if (format === "manhwa") return "KR";
  if (format === "manhua") return "CN";
  return undefined;
}

async function mapAndUpsert(page: AniListPage<AniListMedia>) {
  const media = page.media.map((m) => anilistToTatakaiMedia(m));
  await Promise.all(page.media.map((m) => upsertMangaMapping(m).catch(() => null)));
  return { media, pageInfo: page.pageInfo };
}

/** @deprecated Prefer browseManga — kept for simple call sites */
export async function searchManga(query: string, page = 1, perPage = 20, isAdult?: boolean) {
  return browseManga({ query, page, perPage, isAdult });
}

export async function browseManga(params: MangaBrowseParams = {}): Promise<MangaBrowseResult> {
  return runBrowse(params, { cardsOnly: false });
}

/**
 * `browseManga` for shelves: the light AniList fragment, and no mapping writes.
 *
 * Two costs disappear. AniList stops sending `characters`/`staff`/`relations`
 * for records that will only ever be a poster and a title, and the read path
 * stops issuing one `upsertMangaMapping` per item — 20 writes per lane, on
 * every lane, on a page nobody asked to index. Mapping ingest still happens on
 * the detail routes and in `bulkRefreshMangaMappings`, which is where it belongs.
 */
export async function browseMangaCards(params: MangaBrowseParams = {}): Promise<MangaBrowseResult> {
  return runBrowse(params, { cardsOnly: true });
}

async function runBrowse(
  params: MangaBrowseParams,
  options: { cardsOnly: boolean },
): Promise<MangaBrowseResult> {
  const page = params.page ?? 1;
  const perPage = Math.min(Math.max(params.perPage ?? 20, 1), 50);
  const isAdultParam = params.isAdult === true ? undefined : params.isAdult === false ? false : false;
  const sort = resolveSort(params);
  const countryOfOrigin = resolveOrigin(params);
  const genres = params.genre ? [params.genre] : undefined;
  const tags = params.tags?.length ? params.tags : undefined;
  const format = params.format && FORMAT_MAP[params.format.toLowerCase()]
    ? FORMAT_MAP[params.format.toLowerCase()]
    : undefined;
  const search = params.query?.trim() || undefined;

  const finish = async (result: AniListPage<AniListMedia>) =>
    options.cardsOnly
      ? { media: result.media.map((m) => anilistToTatakaiMedia(m)), pageInfo: result.pageInfo }
      : mapAndUpsert(result);

  // Empty browse (trending/popular feeds) — no search string required
  if (!search && !genres && !tags) {
    const data = await anilistClient.query<{ Page: AniListPage<AniListMedia> }>(
      options.cardsOnly ? QUERY_MANGA_CARD_PAGE : QUERY_MANGA_PAGE,
      {
        page,
        perPage,
        sort,
        countryOfOrigin,
        isAdult: isAdultParam,
        format,
        formats: format ? undefined : ['MANGA', 'ONE_SHOT'],
      },
    );
    return finish(data.Page);
  }

  const data = await anilistClient.query<{ Page: AniListPage<AniListMedia> }>(
    options.cardsOnly ? QUERY_MANGA_CARD_SEARCH : QUERY_MANGA_SEARCH,
    {
      page,
      perPage,
      search,
      isAdult: isAdultParam,
      sort,
      genres,
      tags,
      countryOfOrigin,
      format,
      formats: format ? undefined : ['MANGA', 'ONE_SHOT'],
      status: params.status || undefined,
    },
  );
  return finish(data.Page);
}

export async function getMangaByAniListId(id: number) {
  const data = await anilistClient.query<{ Media: AniListMedia | null }>(QUERY_MANGA_BY_ID, { id });
  if (!data.Media) return null;
  await upsertMangaMapping(data.Media).catch(() => null);
  return anilistToTatakaiMedia(data.Media);
}

export async function getMangaByMalId(idMal: number) {
  const data = await anilistClient.query<{ Media: AniListMedia | null }>(QUERY_MANGA_BY_MAL, { idMal });
  if (!data.Media) return null;
  await upsertMangaMapping(data.Media).catch(() => null);
  return anilistToTatakaiMedia(data.Media);
}

export async function getJikanMangaFull(malId: number) {
  return jikanClient.getMangaFull(malId);
}

export async function getJikanMangaCharacters(malId: number) {
  return jikanClient.getMangaCharacters(malId);
}

/**
 * Persist a discovered chapter count into the mirror `Media.chapters` ("Tiger DB").
 *
 * The extension runtime scrapes chapter lists client-side, so the backend never
 * sees a real total unless the reader reports it back. We bump `chapters` UPWARD
 * only: an ongoing series' scraped total can exceed AniList's stale count, but we
 * never lower a curated/AniList value (this also leaves `isLocked` overrides that
 * are higher untouched). Returns the value now stored, or null when the row can't
 * be backfilled.
 */
export async function setMangaTotalChapters(anilistId: number, total: number): Promise<number | null> {
  if (!Number.isFinite(anilistId) || anilistId <= 0) return null;
  if (!Number.isFinite(total) || total <= 0) return null;
  const next = Math.floor(total);

  await ensureMedia(anilistId).catch(() => null);
  const current = await prisma.media.findUnique({
    where: { id: anilistId },
    select: { chapters: true },
  });
  if (!current) return null;

  const existing = Number(current.chapters ?? 0);
  if (existing >= next) return existing; // never lower a real value
  await prisma.media.update({ where: { id: anilistId }, data: { chapters: next } });
  return next;
}

/** Bulk ingest manga mappings from AniList trending/popular pages. */
export async function bulkRefreshMangaMappings(pages = 5, perPage = 50): Promise<{ upserted: number }> {
  let upserted = 0;
  for (let page = 1; page <= pages; page += 1) {
    for (const sort of [["TRENDING_DESC"], ["POPULARITY_DESC"]] as string[][]) {
      const data = await anilistClient.query<{ Page: AniListPage<AniListMedia> }>(QUERY_MANGA_PAGE, {
        page,
        perPage,
        sort,
        isAdult: false,
      });
      for (const m of data.Page.media) {
        await upsertMangaMapping(m).catch(() => null);
        upserted += 1;
      }
    }
  }
  return { upserted };
}

/**
 * AniList's manga genre vocabulary, inlined.
 *
 * `catalog.getGenresList()` exists, but it reads `GenreCollection` as a list of
 * objects when AniList returns a list of strings, so it yields nothing and the
 * anime bundle silently falls back to a literal list anyway. A constant is
 * honest about that and costs the bundle no upstream call.
 */
const MANGA_GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror",
  "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological", "Romance",
  "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller",
];

const HOME_LANE_SIZE = 20;

function isMangaFamilyFormat(media: TatakaiMedia): boolean {
  const format = String(media.format || "").toUpperCase();
  return !format || format === "MANGA" || format === "MANHWA" || format === "MANHUA" || format === "ONE_SHOT";
}

/**
 * The whole top of `/manga` in one shot — six AniList reads behind one cache key.
 *
 * Shaped after `catalog.getHomeBundle`: a single `Promise.all`, card-only
 * browses, and no per-item mapping work. The hub previously issued four
 * `/manga/search` calls on first paint (plus two more per showcase lane), each
 * of which upserted 20 mappings and then walked a 5–9-deep sequential Supabase
 * chain per item through `attachMappingToMedia`. None of that reaches a poster.
 */
export async function getMangaHomeBundle(
  options: { adult?: boolean } = {},
): Promise<MangaHomeBundle> {
  const lane = async (params: MangaBrowseParams): Promise<TatakaiMedia[]> => {
    try {
      const result = await browseMangaCards({ perPage: HOME_LANE_SIZE, ...params });
      return result.media.filter(isMangaFamilyFormat);
    } catch {
      // One dead lane should not blank the whole hub.
      return [];
    }
  };

  const [trending, popular, topRated, newChapters, manhwa, manhua] = await Promise.all([
    lane({ sort: "TRENDING_DESC" }),
    lane({ sort: "POPULARITY_DESC" }),
    lane({ sort: "SCORE_DESC" }),
    lane({ sort: "UPDATED_AT_DESC" }),
    lane({ sort: "POPULARITY_DESC", origin: "kr" }),
    lane({ sort: "POPULARITY_DESC", origin: "cn" }),
  ]);

  // Mature lanes are opt-in, so they get their own cache key upstream and cost
  // nothing for the default bundle.
  const [adultLatest, adultPopular] = options.adult
    ? await Promise.all([
        lane({ sort: "UPDATED_AT_DESC", isAdult: true, perPage: 24 }),
        lane({ sort: "POPULARITY_DESC", isAdult: true, perPage: 24 }),
      ])
    : [[] as TatakaiMedia[], [] as TatakaiMedia[]];

  return {
    spotlight: topRated.slice(0, 8),
    trending,
    popular,
    topRated,
    newChapters,
    manhwa,
    manhua,
    adultLatest,
    adultPopular,
    genres: MANGA_GENRES,
    fetchedAt: Date.now(),
  };
}
