import { getSupabase } from "../../lib/supabase.js";
import type { MappingEnvelope, AnimeMapping, MangaMapping } from "./types.js";
import { extractAnimeMappingFromAniList } from "./extractor.js";
import { anilistClient } from "../../providers/anilist/client.js";
import { QUERY_MEDIA } from "../../providers/anilist/queries.js";
import type { AniListMedia } from "../../providers/anilist/types.js";

const FRIBB_URL = "https://raw.githubusercontent.com/Fribb/anime-lists/refs/heads/master/anime-list-full.json";
let fribbLoadedAt = 0;
let fribbLoading: Promise<void> | null = null;
let fribbByAnilist = new Map<number, AnimeMapping>();
let fribbByMal = new Map<number, AnimeMapping>();

async function ensureFribbCache() {
  const now = Date.now();
  if (fribbByAnilist.size > 0 && now - fribbLoadedAt < 6 * 60 * 60 * 1000) return;
  if (fribbLoading) {
    await fribbLoading;
    return;
  }

  fribbLoading = (async () => {
    try {
      const res = await fetch(FRIBB_URL);
      if (!res.ok) return;
      const rows = (await res.json()) as Array<Record<string, unknown>>;
      const nextByAnilist = new Map<number, AnimeMapping>();
      const nextByMal = new Map<number, AnimeMapping>();

      for (const row of rows) {
        const mapping = normalizeAnimeRow(row);
        if (mapping.anilist_id && Number.isFinite(mapping.anilist_id)) {
          nextByAnilist.set(mapping.anilist_id, mapping);
        }
        if (mapping.mal_id && Number.isFinite(mapping.mal_id)) {
          nextByMal.set(mapping.mal_id, mapping);
        }
      }

      fribbByAnilist = nextByAnilist;
      fribbByMal = nextByMal;
      fribbLoadedAt = Date.now();
    } catch {
      // Best-effort fallback only.
    } finally {
      fribbLoading = null;
    }
  })();

  await fribbLoading;
}

function normalizeAnimeRow(row: Record<string, unknown>): AnimeMapping {
  return {
    type: (row.type as string | null) ?? null,
    anidb_id: (row.anidb_id as number | null) ?? null,
    anilist_id: (row.anilist_id as number | null) ?? null,
    "anime-planet_id": (row.anime_planet_id as string | null) ?? null,
    animecountdown_id: (row.animecountdown_id as number | null) ?? null,
    animenewsnetwork_id: (row.animenewsnetwork_id as number | null) ?? null,
    anisearch_id: (row.anisearch_id as number | null) ?? null,
    imdb_id: (row.imdb_id as string | null) ?? null,
    kitsu_id: (row.kitsu_id as number | null) ?? null,
    livechart_id: (row.livechart_id as number | null) ?? null,
    mal_id: (row.mal_id as number | null) ?? null,
    simkl_id: (row.simkl_id as number | null) ?? null,
    themoviedb_id: (row.themoviedb_id as number | null) ?? null,
    tvdb_id: (row.tvdb_id as number | null) ?? null,
    season: {
      tmdb: (row.season_tmdb as number | null) ?? null,
      tvdb: (row.season_tvdb as number | null) ?? null,
    },
  };
}

function normalizeMangaRow(row: Record<string, unknown>): MangaMapping {
  return {
    anilist_id: (row.anilist_id as number | null) ?? null,
    mal_id: (row.mal_id as number | null) ?? null,
    kitsu_id: (row.kitsu_id as number | null) ?? null,
    "anime-planet_id": (row.anime_planet_id as string | null) ?? null,
    mangaupdates_id: (row.mangaupdates_id as number | null) ?? null,
    mangadex_slug: (row.mangadex_slug as string | null) ?? null,
  };
}

function mergeAnimeMappings(primary: AnimeMapping, fallback: AnimeMapping): AnimeMapping {
  const merged: AnimeMapping = { ...fallback, ...primary, season: { ...fallback.season, ...primary.season } };
  for (const key of Object.keys(fallback) as Array<keyof AnimeMapping>) {
    if (merged[key] === null || merged[key] === undefined) {
      merged[key] = fallback[key] as never;
    }
  }
  return merged;
}

function isAnimeMappingShallow(mapping: AnimeMapping | null | undefined): boolean {
  if (!mapping) return true;
  return Boolean(
    mapping.anilist_id &&
    !mapping.kitsu_id &&
    !mapping.imdb_id &&
    !mapping.anidb_id &&
    !mapping["anime-planet_id"],
  );
}

function isMangaMappingShallow(mapping: MangaMapping | null | undefined): boolean {
  if (!mapping) return true;
  return Boolean(
    mapping.anilist_id &&
    !mapping.kitsu_id &&
    !mapping.mangadex_slug &&
    !mapping["anime-planet_id"] &&
    !mapping.mangaupdates_id,
  );
}

export function isShallowMapping(mapping: AnimeMapping | MangaMapping | null | undefined): boolean {
  if (!mapping) return true;
  const looksManga = (mapping as MangaMapping).mangadex_slug !== undefined
    || (mapping as MangaMapping).mangaupdates_id !== undefined;
  return looksManga
    ? isMangaMappingShallow(mapping as MangaMapping)
    : isAnimeMappingShallow(mapping as AnimeMapping);
}

export async function resolveMappingByTatakaiId(tatakaiId: string): Promise<MappingEnvelope | null> {
  const sb = getSupabase();
  if (!sb) return null;

  const { data: unifiedRow, error: unifiedError } = await sb
    .schema("mappings")
    .from("tatakai_id_map")
    .select("*")
    .eq("tatakai_id", tatakaiId)
    .maybeSingle();

  if (!unifiedError && unifiedRow) {
    const kind = String((unifiedRow as Record<string, unknown>).kind || "").toLowerCase();
    if (kind === "manga") {
      return { id: String((unifiedRow as Record<string, unknown>).tatakai_id), mapping: normalizeMangaRow(unifiedRow as Record<string, unknown>) };
    }
    return { id: String((unifiedRow as Record<string, unknown>).tatakai_id), mapping: normalizeAnimeRow(unifiedRow as Record<string, unknown>) };
  }

  const { data: link } = await sb
    .schema("mappings")
    .from("tatakai_id_link")
    .select("tatakai_id, anilist_id, kind")
    .eq("tatakai_id", tatakaiId)
    .maybeSingle();

  if (!link) return null;

  if (link.kind === "anime") {
    const { data: row } = await sb.schema("mappings").from("anime_id_map").select("*").eq("anilist_id", link.anilist_id).maybeSingle();
    return { id: link.tatakai_id, mapping: row ? normalizeAnimeRow(row as Record<string, unknown>) : null };
  }

  const { data: row } = await sb.schema("mappings").from("manga_id_map").select("*").eq("anilist_id", link.anilist_id).maybeSingle();
  return { id: link.tatakai_id, mapping: row ? normalizeMangaRow(row as Record<string, unknown>) : null };
}

export async function resolveTatakaiIdByAniListId(anilistId: number): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return null;

  const { data: unifiedRow, error: unifiedError } = await sb
    .schema("mappings")
    .from("tatakai_id_map")
    .select("tatakai_id")
    .eq("anilist_id", anilistId)
    .maybeSingle();

  if (!unifiedError && unifiedRow?.tatakai_id) return String(unifiedRow.tatakai_id);

  const { data: link } = await sb
    .schema("mappings")
    .from("tatakai_id_link")
    .select("tatakai_id")
    .eq("anilist_id", anilistId)
    .maybeSingle();

  return link?.tatakai_id ? String(link.tatakai_id) : null;
}

export async function resolveTatakaiIdByMalId(malId: number): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return null;

  const { data: unifiedRow, error: unifiedError } = await sb
    .schema("mappings")
    .from("tatakai_id_map")
    .select("tatakai_id")
    .eq("mal_id", malId)
    .maybeSingle();

  if (!unifiedError && unifiedRow?.tatakai_id) return String(unifiedRow.tatakai_id);

  // Try anime map
  const { data: animeMap } = await sb
    .schema("mappings")
    .from("anime_id_map")
    .select("anilist_id")
    .eq("mal_id", malId)
    .maybeSingle();

  if (animeMap?.anilist_id) return resolveTatakaiIdByAniListId(animeMap.anilist_id);

  // Try manga map
  const { data: mangaMap } = await sb
    .schema("mappings")
    .from("manga_id_map")
    .select("anilist_id")
    .eq("mal_id", malId)
    .maybeSingle();

  if (mangaMap?.anilist_id) return resolveTatakaiIdByAniListId(mangaMap.anilist_id);

  return null;
}

export async function resolveAnimeMappingByAniListId(anilistId: number) {
  const sb = getSupabase();
  const { data: row } = sb
    ? await sb.schema("mappings").from("anime_id_map").select("*").eq("anilist_id", anilistId).maybeSingle()
    : { data: null };
  const dbMapping = row ? normalizeAnimeRow(row as Record<string, unknown>) : null;
  if (dbMapping && !isAnimeMappingShallow(dbMapping)) return dbMapping;

  await ensureFribbCache();
  const fribbMapping = fribbByAnilist.get(anilistId) ?? null;
  if (!dbMapping) return fribbMapping;
  if (!fribbMapping) return dbMapping;

  return mergeAnimeMappings(dbMapping, fribbMapping);
}

export async function resolveAnimeMappingByMalId(malId: number) {
  const sb = getSupabase();
  const { data: row } = sb
    ? await sb.schema("mappings").from("anime_id_map").select("*").eq("mal_id", malId).maybeSingle()
    : { data: null };
  const dbMapping = row ? normalizeAnimeRow(row as Record<string, unknown>) : null;
  if (dbMapping && !isAnimeMappingShallow(dbMapping)) return dbMapping;

  await ensureFribbCache();
  const fribbMapping = fribbByMal.get(malId) ?? null;
  if (!dbMapping) return fribbMapping;
  if (!fribbMapping) return dbMapping;

  return mergeAnimeMappings(dbMapping, fribbMapping);
}

export async function resolveMangaMappingByAniListId(anilistId: number) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data: row } = await sb.schema("mappings").from("manga_id_map").select("*").eq("anilist_id", anilistId).maybeSingle();
  return row ? normalizeMangaRow(row as Record<string, unknown>) : null;
}

export async function resolveMangaMappingByMalId(malId: number) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data: row } = await sb.schema("mappings").from("manga_id_map").select("*").eq("mal_id", malId).maybeSingle();
  return row ? normalizeMangaRow(row as Record<string, unknown>) : null;
}

export async function resolveAnimeMappingByAnidbId(anidbId: number) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data: row } = await sb.schema("mappings").from("anime_id_map").select("*").eq("anidb_id", anidbId).maybeSingle();
  return row ? normalizeAnimeRow(row as Record<string, unknown>) : null;
}

/**
 * A manga mapping salvaged from AniList's `externalLinks`, for titles the mapping
 * tables don't know yet. Shared by the single- and list-path resolvers so the two
 * can't drift.
 */
function mangaMappingFromExternalLinks(media: {
  anilistId?: number;
  malId?: number;
  externalLinks?: any[];
}): MangaMapping {
  const extLinks = media.externalLinks ?? [];
  const animePlanet = extLinks.find((l) => /anime-planet/i.test(l.site || ""))?.url || null;
  const mangadex = extLinks.find((l) => /mangadex/i.test(l.site || ""))?.url || null;
  const mangadexSlug = mangadex ? mangadex.split("/").filter(Boolean).pop() || null : null;

  return normalizeMangaRow({
    anilist_id: media.anilistId,
    mal_id: media.malId,
    anime_planet_id: animePlanet ? animePlanet.split("/").filter(Boolean).pop() || null : null,
    mangadex_slug: mangadexSlug,
  });
}

/**
 * Formats that mean "this is not an anime". AniList sends these in `format` for
 * written works; the union in `MediaFormat` only covers the anime side, so this
 * reads the field loosely.
 */
const MANGA_FORMATS = new Set([
  "MANGA", "MANHWA", "MANHUA", "ONE_SHOT", "NOVEL", "LIGHT_NOVEL", "DOUJINSHI",
]);

/**
 * Is this record a written work?
 *
 * `chapters`/`volumes` alone are not enough: AniList leaves both null for most
 * ongoing series, so Berserk, One Piece, One-Punch Man and Vagabond all used to
 * read as anime here. That sent them down the anime resolver, which looks their
 * *manga* MAL id up in an anime-only table — Vagabond (manga MAL 656) came back
 * carrying the ids of whatever anime holds MAL 656, `anilist_id` included.
 */
function looksLikeWrittenWork(media: { chapters?: number; volumes?: number; format?: string }): boolean {
  return (
    media.chapters !== undefined
    || media.volumes !== undefined
    || MANGA_FORMATS.has(String(media.format ?? "").toUpperCase())
  );
}

export async function attachMappingToMedia<T extends { tatakaiId?: string; anilistId?: number; malId?: number; chapters?: number; volumes?: number; format?: string; externalLinks?: any[]; source_api?: string }>(
  media: T,
  options: { fetchMissingLinks?: boolean } = {},
) {
  const tatakaiId =
    media.tatakaiId
    ?? (media.anilistId ? await resolveTatakaiIdByAniListId(media.anilistId).catch(() => null) : null)
    ?? (media.malId ? await resolveTatakaiIdByMalId(media.malId).catch(() => null) : null);

  const isManga = looksLikeWrittenWork(media);

  const mappingCandidates: (AnimeMapping | MangaMapping | null)[] = [];

  if (tatakaiId) {
    const envelope = await resolveMappingByTatakaiId(String(tatakaiId));
    if (envelope?.mapping) mappingCandidates.push(envelope.mapping);
  }

  if (media.anilistId) {
    if (isManga) {
      mappingCandidates.push(await resolveMangaMappingByAniListId(media.anilistId).catch(() => null));
    } else {
      mappingCandidates.push(await resolveAnimeMappingByAniListId(media.anilistId).catch(() => null));
    }
  }

  if (media.malId) {
    if (isManga) {
      mappingCandidates.push(await resolveMangaMappingByMalId(media.malId).catch(() => null));
    } else {
      mappingCandidates.push(await resolveAnimeMappingByMalId(media.malId).catch(() => null));
    }
  }

  // Merge candidates, preferring non-null values
  let mapping: any = null;
  for (const candidate of mappingCandidates) {
    if (!candidate) continue;
    if (!mapping) {
      mapping = { ...candidate };
      continue;
    }
    // Simple merge: fill in nulls
    for (const key of Object.keys(candidate)) {
      if (mapping[key] === null || mapping[key] === undefined) {
        mapping[key] = (candidate as any)[key];
      }
    }
  }

  // If still shallow, try to extract from externalLinks if available
  // Shallow means missing crucial IDs like Kitsu, IMDb, AniDB, or Anime-Planet
  const isShallow = isShallowMapping(mapping);
  
  // Last resort: if shallow and no links, and we have an anilistId, fetch fresh from AniList
  // We remove the source_api !== "anilist" check to be extra aggressive
  if (options.fetchMissingLinks !== false && isShallow && !media.externalLinks?.length && media.anilistId && !isManga) {
    try {
      const { Media } = await anilistClient.query<{ Media: AniListMedia }>(QUERY_MEDIA, { id: media.anilistId });
      if (Media?.externalLinks?.length) {
        (media as any).externalLinks = Media.externalLinks;
      }
    } catch (err) {
      // Ignore fetch failures but could log if we had a logger here
    }
  }

  if (media.externalLinks?.length && isShallow) {
    if (isManga) {
      const extractedManga = mangaMappingFromExternalLinks(media);

      if (!mapping) {
        mapping = extractedManga;
      } else {
        for (const key of Object.keys(extractedManga)) {
          if (mapping[key] === null || mapping[key] === undefined) {
            mapping[key] = (extractedManga as any)[key];
          }
        }
      }
    } else {
      const extractedAnime = extractAnimeMappingFromAniList({
        id: media.anilistId ?? 0,
        idMal: media.malId,
        externalLinks: media.externalLinks,
      } as any);

      if (!mapping) {
        mapping = extractedAnime;
      } else {
        for (const key of Object.keys(extractedAnime)) {
          if (mapping[key] === null || mapping[key] === undefined) {
            mapping[key] = (extractedAnime as any)[key];
          }
        }
      }
    }
  }

  // Final stub fallback if absolutely nothing found
  if (!mapping && (media.anilistId || media.malId)) {
    if (isManga) {
      mapping = normalizeMangaRow({ anilist_id: media.anilistId, mal_id: media.malId });
    } else {
      mapping = normalizeAnimeRow({ anilist_id: media.anilistId, mal_id: media.malId });
    }
  }

  const id = String(tatakaiId || media.anilistId || media.malId || "");
  const nextMedia = tatakaiId ? { ...media, tatakaiId } : media;
  return { id, mapping, media: nextMedia };
}

// ─── Batched manga resolution, for list responses ────────────────────────────
//
// `attachMappingToMedia` resolves one title through a chain of `.maybeSingle()`
// reads: the Tatakai id by AniList id (2 queries), else by MAL id (up to 3), then
// the unified row for that id (up to 3), then the manga row by AniList id and by
// MAL id. Five to nine sequential round trips, per title — a 20-record search page
// paid 100–180 of them end to end.
//
// `attachMangaMappings` answers the same questions with a fixed six `.in(...)`
// sweeps for the whole list, run in parallel, then joins them in memory. The
// per-item output is identical: same candidate order, same null-filling merge,
// same `externalLinks` salvage when the result is shallow, same stub fallback,
// same `{ id, mapping, media }`. (The AniList re-fetch in the single-title path is
// gated on `!isManga`, so there is nothing to mirror there.)

/** Ids per `.in(...)` query, so a large page doesn't build an oversized URL. */
const MAPPING_BATCH_SIZE = 200;

type MappingRow = Record<string, unknown>;

export type MangaMappingInput = {
  tatakaiId?: string;
  anilistId?: number;
  malId?: number;
  externalLinks?: any[];
};

function chunkIds<T>(ids: T[], size = MAPPING_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * One chunked `.in(...)` sweep. Errors resolve to no rows on purpose: a mapping
 * miss degrades to a stub mapping, and must never fail the list request.
 */
async function fetchMappingRows(
  table: string,
  column: string,
  ids: Array<number | string>,
  select = "*",
): Promise<MappingRow[]> {
  const sb = getSupabase();
  if (!sb || ids.length === 0) return [];

  const batches = await Promise.all(
    chunkIds(ids).map(async (batch) => {
      try {
        const { data, error } = await sb
          .schema("mappings")
          .from(table)
          .select(select)
          .in(column, batch);
        return error ? [] : (((data ?? []) as unknown) as MappingRow[]);
      } catch {
        return [];
      }
    }),
  );

  return batches.flat();
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function uniqueNumbers(values: Array<number | undefined>): number[] {
  const set = new Set<number>();
  for (const value of values) {
    const n = positiveInt(value);
    if (n !== null) set.add(n);
  }
  return [...set];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const set = new Set<string>();
  for (const value of values) {
    const s = String(value ?? "").trim();
    if (s) set.add(s);
  }
  return [...set];
}

/** First row wins, matching `.maybeSingle()`'s "one row or nothing". */
function indexRowsBy<K>(rows: MappingRow[], key: (row: MappingRow) => K | null): Map<K, MappingRow> {
  const map = new Map<K, MappingRow>();
  for (const row of rows) {
    const k = key(row);
    if (k === null || k === undefined) continue;
    if (!map.has(k)) map.set(k, row);
  }
  return map;
}

type MangaMappingIndex = {
  /** `tatakai_id_map` rows, reachable by every id that found them. */
  unifiedByTatakaiId: Map<string, MappingRow>;
  unifiedByAnilistId: Map<number, MappingRow>;
  unifiedByMalId: Map<number, MappingRow>;
  /** `tatakai_id_link` rows — the fallback route to a Tatakai id. */
  linkByAnilistId: Map<number, MappingRow>;
  mangaByAnilistId: Map<number, MappingRow>;
  mangaByMalId: Map<number, MappingRow>;
};

async function buildMangaMappingIndex(items: MangaMappingInput[]): Promise<MangaMappingIndex> {
  const anilistIds = uniqueNumbers(items.map((m) => m.anilistId));
  const malIds = uniqueNumbers(items.map((m) => m.malId));
  const knownTatakaiIds = uniqueStrings(items.map((m) => m.tatakaiId));

  const [unifiedByAnilist, unifiedByMal, unifiedByKnownId, links, mangaByAnilist, mangaByMal] =
    await Promise.all([
      fetchMappingRows("tatakai_id_map", "anilist_id", anilistIds),
      fetchMappingRows("tatakai_id_map", "mal_id", malIds),
      fetchMappingRows("tatakai_id_map", "tatakai_id", knownTatakaiIds),
      fetchMappingRows("tatakai_id_link", "anilist_id", anilistIds, "tatakai_id, anilist_id, kind"),
      fetchMappingRows("manga_id_map", "anilist_id", anilistIds),
      fetchMappingRows("manga_id_map", "mal_id", malIds),
    ]);

  const index: MangaMappingIndex = {
    unifiedByTatakaiId: indexRowsBy([...unifiedByKnownId, ...unifiedByAnilist, ...unifiedByMal], (row) =>
      row.tatakai_id ? String(row.tatakai_id) : null,
    ),
    unifiedByAnilistId: indexRowsBy(unifiedByAnilist, (row) => positiveInt(row.anilist_id)),
    unifiedByMalId: indexRowsBy(unifiedByMal, (row) => positiveInt(row.mal_id)),
    linkByAnilistId: indexRowsBy(links, (row) => positiveInt(row.anilist_id)),
    mangaByAnilistId: indexRowsBy(mangaByAnilist, (row) => positiveInt(row.anilist_id)),
    mangaByMalId: indexRowsBy(mangaByMal, (row) => positiveInt(row.mal_id)),
  };

  /*
   * The single-title path has one more route to a Tatakai id: for a title whose own
   * AniList id has no row, it takes the `manga_id_map` row found by MAL id and
   * retries with *that* row's AniList id. Those ids are only different when a
   * mapping row disagrees with AniList, so this second pass almost never fires —
   * but skipping it would silently hand back a different id when it should.
   */
  const indirect = uniqueNumbers(
    items
      .filter((m) => {
        if (m.tatakaiId) return false;
        const own = positiveInt(m.anilistId);
        if (own !== null && (index.unifiedByAnilistId.has(own) || index.linkByAnilistId.has(own))) return false;
        const mal = positiveInt(m.malId);
        return mal !== null && !index.unifiedByMalId.has(mal);
      })
      .map((m) => {
        const mal = positiveInt(m.malId);
        const row = mal === null ? undefined : index.mangaByMalId.get(mal);
        const discovered = positiveInt(row?.anilist_id);
        return discovered !== null && discovered !== positiveInt(m.anilistId) ? discovered : undefined;
      }),
  );

  if (indirect.length > 0) {
    const [extraUnified, extraLinks] = await Promise.all([
      fetchMappingRows("tatakai_id_map", "anilist_id", indirect),
      fetchMappingRows("tatakai_id_link", "anilist_id", indirect, "tatakai_id, anilist_id, kind"),
    ]);
    for (const row of extraUnified) {
      const key = positiveInt(row.anilist_id);
      if (key !== null && !index.unifiedByAnilistId.has(key)) index.unifiedByAnilistId.set(key, row);
      if (row.tatakai_id && !index.unifiedByTatakaiId.has(String(row.tatakai_id))) {
        index.unifiedByTatakaiId.set(String(row.tatakai_id), row);
      }
    }
    for (const row of extraLinks) {
      const key = positiveInt(row.anilist_id);
      if (key !== null && !index.linkByAnilistId.has(key)) index.linkByAnilistId.set(key, row);
    }
  }

  return index;
}

/**
 * The Tatakai id for one title, read off the index.
 *
 * Mirrors `resolveTatakaiIdByAniListId` then `resolveTatakaiIdByMalId`, minus the
 * latter's `anime_id_map` probe: an anime row keyed by a manga's MAL id would be a
 * cross-type mismapping, and following it here would attach an anime's ids to a
 * manga card.
 */
function tatakaiIdFor(media: MangaMappingInput, index: MangaMappingIndex): string | null {
  if (media.tatakaiId) return String(media.tatakaiId);

  const anilistId = positiveInt(media.anilistId);
  if (anilistId !== null) {
    const unified = index.unifiedByAnilistId.get(anilistId);
    if (unified?.tatakai_id) return String(unified.tatakai_id);
    const link = index.linkByAnilistId.get(anilistId);
    if (link?.tatakai_id) return String(link.tatakai_id);
  }

  const malId = positiveInt(media.malId);
  if (malId !== null) {
    const unified = index.unifiedByMalId.get(malId);
    if (unified?.tatakai_id) return String(unified.tatakai_id);

    const discovered = positiveInt(index.mangaByMalId.get(malId)?.anilist_id);
    if (discovered !== null) {
      const viaUnified = index.unifiedByAnilistId.get(discovered);
      if (viaUnified?.tatakai_id) return String(viaUnified.tatakai_id);
      const viaLink = index.linkByAnilistId.get(discovered);
      if (viaLink?.tatakai_id) return String(viaLink.tatakai_id);
    }
  }

  return null;
}

/**
 * The `resolveMappingByTatakaiId` candidate, read off the index: the unified row if
 * there is one, otherwise the `manga_id_map` row the link points at. A link whose
 * `kind` says "anime" is followed into the manga table anyway — same as the manga
 * branch of the sequential resolver, and the only sane read for a manga list.
 */
function unifiedMappingFor(
  tatakaiId: string,
  media: MangaMappingInput,
  index: MangaMappingIndex,
): AnimeMapping | MangaMapping | null {
  const unified = index.unifiedByTatakaiId.get(tatakaiId);
  if (unified) {
    return String(unified.kind || "").toLowerCase() === "manga"
      ? normalizeMangaRow(unified)
      : normalizeAnimeRow(unified);
  }

  const anilistId = positiveInt(media.anilistId);
  const link = anilistId === null ? undefined : index.linkByAnilistId.get(anilistId);
  if (!link || String(link.tatakai_id ?? "") !== tatakaiId) return null;

  const linkAnilistId = positiveInt(link.anilist_id);
  const row = linkAnilistId === null ? undefined : index.mangaByAnilistId.get(linkAnilistId);
  return row ? normalizeMangaRow(row) : null;
}

/** `attachMappingToMedia`'s merge: first candidate wins, later ones fill its nulls. */
function fillNulls(mapping: any, candidate: object | null | undefined): any {
  if (!candidate) return mapping;
  if (!mapping) return { ...candidate };
  for (const key of Object.keys(candidate)) {
    if (mapping[key] === null || mapping[key] === undefined) {
      mapping[key] = (candidate as any)[key];
    }
  }
  return mapping;
}

/**
 * `attachMappingToMedia` for a whole list of manga, at a fixed six queries instead
 * of five to nine per title. Use this on every list path — search, browse, shelves.
 * Single titles should keep using `attachMappingToMedia`.
 */
export async function attachMangaMappings<T extends MangaMappingInput>(items: T[]) {
  if (items.length === 0) return [];

  const index = await buildMangaMappingIndex(items);

  return items.map((media) => {
    const tatakaiId = tatakaiIdFor(media, index);
    const anilistId = positiveInt(media.anilistId);
    const malId = positiveInt(media.malId);

    let mapping: any = null;
    if (tatakaiId) mapping = fillNulls(mapping, unifiedMappingFor(tatakaiId, media, index));
    if (anilistId !== null) {
      const row = index.mangaByAnilistId.get(anilistId);
      mapping = fillNulls(mapping, row ? normalizeMangaRow(row) : null);
    }
    if (malId !== null) {
      const row = index.mangaByMalId.get(malId);
      mapping = fillNulls(mapping, row ? normalizeMangaRow(row) : null);
    }

    // Same salvage as the single-title path: a mapping that has the AniList id and
    // nothing else is worth topping up from the links AniList already sent.
    if (media.externalLinks?.length && isShallowMapping(mapping)) {
      mapping = fillNulls(mapping, mangaMappingFromExternalLinks(media));
    }

    if (!mapping && (anilistId !== null || malId !== null)) {
      mapping = normalizeMangaRow({ anilist_id: media.anilistId, mal_id: media.malId });
    }

    return {
      id: String(tatakaiId || media.anilistId || media.malId || ""),
      mapping,
      media: tatakaiId ? { ...media, tatakaiId } : media,
    };
  });
}

