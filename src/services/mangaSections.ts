/**
 * The manga hub's endless feed, assembled server-side.
 *
 * It used to live in `src/hooks/api/useInfiniteMangaSections.ts`: 61 shelf
 * configs, shuffled with `Math.random()` at module load, four of which were
 * fetched per scroll page as four separate `/manga/search` calls. Each of those
 * asked for 20 heavy records to render 5 cards, upserted 20 mapping rows, and
 * then walked a sequential Supabase chain per item — several hundred round trips
 * for one screen of posters.
 *
 * Three things change by moving it here:
 *
 *  - **One request per scroll page.** AniList accepts aliased `Page` queries in a
 *    single document, so four shelves cost one HTTP call and one rate-limiter
 *    token instead of four of each.
 *  - **It caches.** The order is deterministic, so `manga:sections:{page}` is a
 *    real cache key. A random client-side shuffle can't be cached by anyone and
 *    reshuffled the feed on every remount.
 *  - **The right AniList filter.** Most of these shelves are AniList *tags*
 *    ("Cultivation", "Villainess", "Time Manipulation"), not genres. The old code
 *    searched the free text `"cultivation manga"` and took what came back; this
 *    uses `tag_in` for tags and `genre_in` for genres.
 */
import { anilistClient } from "../providers/anilist/client.js";
import { MEDIA_CARD_FIELDS } from "../providers/anilist/queries.js";
import type { AniListMedia, AniListPage } from "../providers/anilist/types.js";
import { anilistToTatakaiMedia } from "./normalize.js";
import type { MangaFeedSection, MangaSectionsPage, TatakaiMedia } from "../types/tatakaiMedia.js";

/** Shelves per scroll page. Four is what the client renders per batch. */
export const SECTION_PAGE_SIZE = 4;

/**
 * Items requested per shelf. The client shows 5; the spare two absorb the adult
 * filter and de-duplication without a second round trip.
 */
const SECTION_ITEM_COUNT = 7;

type MangaSectionConfig = {
  /** Stable slug — the client's React key, so it must not depend on order. */
  id: string;
  title: string;
  layout: "grid" | "carousel" | "featured" | "compact" | "masonry";
  /** lucide icon name; the client maps it to a component. */
  icon: string;
  /** AniList genre (exact vocabulary). */
  genre?: string;
  /**
   * AniList tag(s) (exact vocabulary from `MediaTagCollection`) — used when
   * there is no matching genre. Several tags OR together, which is how a shelf
   * like "Monsters" covers both `Monster Girl` and `Monster Boy`.
   */
  tag?: string | string[];
  /** Free-text search, for shelves that are neither a genre nor a tag. */
  search?: string;
  /** Country filter, for the manhwa/manhua shelves. */
  origin?: "JP" | "KR" | "CN" | "TW";
};

const SECTION_CONFIGS: readonly MangaSectionConfig[] = [
  { id: "action", title: "Action", layout: "grid", icon: "Sword", genre: "Action" },
  { id: "romance", title: "Romance", layout: "carousel", icon: "Heart", genre: "Romance" },
  { id: "comedy", title: "Comedy", layout: "featured", icon: "Laugh", genre: "Comedy" },
  { id: "fantasy", title: "Fantasy", layout: "masonry", icon: "Sparkles", genre: "Fantasy" },
  { id: "sci-fi", title: "Sci-Fi", layout: "compact", icon: "Rocket", genre: "Sci-Fi" },
  { id: "horror", title: "Horror", layout: "grid", icon: "Ghost", genre: "Horror" },
  { id: "slice-of-life", title: "Slice of Life", layout: "carousel", icon: "Flower2", genre: "Slice of Life" },
  { id: "adventure", title: "Adventure", layout: "featured", icon: "Compass", genre: "Adventure" },
  { id: "mystery", title: "Mystery", layout: "masonry", icon: "Search", genre: "Mystery" },
  { id: "psychological", title: "Psychological", layout: "compact", icon: "Brain", genre: "Psychological" },
  { id: "thriller", title: "Thriller", layout: "grid", icon: "Zap", genre: "Thriller" },
  { id: "drama", title: "Drama", layout: "featured", icon: "Sparkles", genre: "Drama" },
  { id: "supernatural", title: "Supernatural", layout: "masonry", icon: "Ghost", genre: "Supernatural" },
  { id: "sports", title: "Sports", layout: "compact", icon: "Zap", genre: "Sports" },
  { id: "mecha", title: "Mecha", layout: "featured", icon: "Rocket", genre: "Mecha" },
  { id: "historical", title: "Historical", layout: "grid", icon: "Compass", tag: "Historical" },
  { id: "isekai", title: "Isekai", layout: "carousel", icon: "Rocket", tag: "Isekai" },
  { id: "martial-arts", title: "Martial Arts", layout: "grid", icon: "Sword", tag: "Martial Arts" },
  { id: "school-life", title: "School Life", layout: "carousel", icon: "Flower2", tag: "School" },
  { id: "seinen", title: "Seinen", layout: "featured", icon: "Brain", tag: "Seinen" },
  { id: "shounen", title: "Shounen", layout: "masonry", icon: "Flame", tag: "Shounen" },
  { id: "josei", title: "Josei", layout: "compact", icon: "Heart", tag: "Josei" },
  { id: "shoujo", title: "Shoujo", layout: "grid", icon: "Flower2", tag: "Shoujo" },
  { id: "tragedy", title: "Tragedy", layout: "featured", icon: "Sparkles", tag: "Tragedy" },
  { id: "crime", title: "Crime", layout: "carousel", icon: "Search", tag: "Crime" },
  { id: "detective", title: "Detective", layout: "grid", icon: "Search", tag: "Detective" },
  { id: "survival", title: "Survival", layout: "masonry", icon: "Zap", tag: "Survival" },
  { id: "military", title: "Military", layout: "grid", icon: "Sword", tag: "Military" },
  { id: "vampire", title: "Vampires", layout: "compact", icon: "Ghost", tag: "Vampire" },
  { id: "magic", title: "Magic", layout: "masonry", icon: "Sparkles", tag: "Magic" },
  { id: "post-apocalyptic", title: "Post-Apocalyptic", layout: "compact", icon: "Rocket", tag: "Post-Apocalyptic" },
  { id: "delinquents", title: "Delinquents", layout: "carousel", icon: "Flame", tag: "Delinquents" },
  { id: "mythology", title: "Mythology", layout: "featured", icon: "Compass", tag: "Mythology" },
  { id: "medical", title: "Medical", layout: "grid", icon: "Brain", tag: "Medicine" },
  { id: "video-games", title: "Video Games", layout: "compact", icon: "Zap", tag: "Video Games" },
  { id: "time-travel", title: "Time Travel", layout: "featured", icon: "Rocket", tag: "Time Manipulation" },
  { id: "reverse-harem", title: "Reverse Harem", layout: "carousel", icon: "Heart", tag: "Male Harem" },
  { id: "harem", title: "Harem", layout: "masonry", icon: "Heart", tag: ["Female Harem", "Mixed Gender Harem"] },
  { id: "samurai", title: "Samurai", layout: "grid", icon: "Sword", tag: "Samurai" },
  { id: "urban-fantasy", title: "Urban Fantasy", layout: "compact", icon: "Ghost", tag: "Urban Fantasy" },
  { id: "cultivation", title: "Cultivation", layout: "masonry", icon: "Flame", tag: "Cultivation" },
  { id: "villainess", title: "Villainess", layout: "carousel", icon: "Heart", tag: "Villainess" },
  { id: "reincarnation", title: "Reincarnation", layout: "featured", icon: "Rocket", tag: "Reincarnation" },
  { id: "manhwa-hits", title: "Manhwa Hits", layout: "featured", icon: "Flame", origin: "KR" },
  { id: "manhua-picks", title: "Manhua Picks", layout: "compact", icon: "Compass", origin: "CN" },
  { id: "webtoon", title: "Webtoons", layout: "grid", icon: "Flower2", tag: "Full Color" },
  { id: "otome-isekai", title: "Reverse Isekai", layout: "featured", icon: "Heart", tag: "Reverse Isekai" },
  { id: "regression", title: "Regression", layout: "grid", icon: "Rocket", tag: "Time Loop" },
  { id: "academy", title: "Academy", layout: "compact", icon: "Brain", tag: "Boarding School" },
  { id: "space", title: "Space Opera", layout: "masonry", icon: "Rocket", tag: "Space" },
  { id: "monsters", title: "Monsters", layout: "carousel", icon: "Ghost", tag: ["Monster Girl", "Monster Boy"] },
  { id: "coming-of-age", title: "Coming of Age", layout: "featured", icon: "Sparkles", tag: "Coming of Age" },
  { id: "office-romance", title: "Office Romance", layout: "grid", icon: "Heart", tag: "Office Lady" },
  { id: "dungeons", title: "Dungeons", layout: "masonry", icon: "Sword", tag: "Dungeon" },
  { id: "battle-royale", title: "Battle Royale", layout: "compact", icon: "Zap", tag: "Battle Royale" },
  { id: "revenge", title: "Revenge", layout: "carousel", icon: "Flame", tag: "Revenge" },
  { id: "demons", title: "Demons", layout: "grid", icon: "Ghost", tag: "Demons" },
  { id: "cooking", title: "Cooking", layout: "compact", icon: "Flower2", tag: "Food" },
  { id: "music", title: "Music", layout: "carousel", icon: "Sparkles", genre: "Music" },
  { id: "gender-bender", title: "Gender Bender", layout: "grid", icon: "Sparkles", tag: "Gender Bending" },
  { id: "super-power", title: "Super Power", layout: "featured", icon: "Flame", tag: "Super Power" },
];

export const SECTION_TOTAL_PAGES = Math.ceil(SECTION_CONFIGS.length / SECTION_PAGE_SIZE);

/**
 * A rotation of the shelf list that changes once a day and is identical for
 * every client within that day.
 *
 * The point of the old `Math.random()` shuffle was variety; the cost was that no
 * two clients — and no two remounts — agreed on the feed, so nothing could be
 * cached and shelves reappeared under fresh keys. Rotating by day keeps the
 * variety and keeps every shelf appearing exactly once per pass.
 */
function orderedConfigs(): readonly MangaSectionConfig[] {
  const day = Math.floor(Date.now() / 86_400_000);
  const offset = ((day % SECTION_CONFIGS.length) + SECTION_CONFIGS.length) % SECTION_CONFIGS.length;
  return [...SECTION_CONFIGS.slice(offset), ...SECTION_CONFIGS.slice(0, offset)];
}

/**
 * One GraphQL document with one aliased `Page` per shelf.
 *
 * Every alias declares the same five filter variables and wires them all into
 * its `media(...)` call; `sectionVariables` then supplies only the ones that
 * shelf uses. A declared-but-unsupplied variable makes its argument absent,
 * which is what AniList needs to see (see the note there). The upshot is that
 * the document is a pure function of the shelf *count*, so it is the same string
 * for every page.
 */
function buildSectionsDocument(count: number): string {
  const vars = ["$perPage: Int", "$isAdult: Boolean", "$format: MediaFormat"];
  const pages: string[] = [];

  for (let i = 0; i < count; i += 1) {
    vars.push(
      `$search${i}: String`,
      `$genres${i}: [String]`,
      `$tags${i}: [String]`,
      `$origin${i}: CountryCode`,
      `$sort${i}: [MediaSort]`,
    );
    pages.push(
      `  s${i}: Page(page: 1, perPage: $perPage) {
    media(
      type: MANGA
      format: $format
      search: $search${i}
      genre_in: $genres${i}
      tag_in: $tags${i}
      countryOfOrigin: $origin${i}
      sort: $sort${i}
      isAdult: $isAdult
    ) { ...MediaCardFields }
  }`,
    );
  }

  return `${MEDIA_CARD_FIELDS}
query MangaSections(${vars.join(", ")}) {
${pages.join("\n")}
}`;
}

/** Cached per shelf count, which in practice means built once. */
const documentCache = new Map<number, string>();

function sectionsDocument(count: number): string {
  const cached = documentCache.get(count);
  if (cached) return cached;
  const built = buildSectionsDocument(count);
  documentCache.set(count, built);
  return built;
}

/**
 * Only the variables a shelf actually uses are set.
 *
 * This is load-bearing, not tidiness: AniList treats an explicitly-null filter
 * as a filter that matches nothing, while an *omitted* variable makes the
 * argument absent. Sending `search: null` alongside `tag_in: ["Josei"]` returns
 * an empty page; omitting `search` returns the shelf. (`browseManga` gets this
 * right by accident — it passes `undefined`, which `JSON.stringify` drops.)
 */
function sectionVariables(configs: readonly MangaSectionConfig[], adult: boolean) {
  const variables: Record<string, unknown> = {
    perPage: SECTION_ITEM_COUNT,
    format: "MANGA",
  };
  // Absent lets adult titles through; `false` excludes them. Same convention as
  // browseManga.
  if (!adult) variables.isAdult = false;

  configs.forEach((config, index) => {
    if (config.search) variables[`search${index}`] = config.search;
    if (config.genre) variables[`genres${index}`] = [config.genre];
    if (config.tag) variables[`tags${index}`] = Array.isArray(config.tag) ? config.tag : [config.tag];
    if (config.origin) variables[`origin${index}`] = config.origin;
    // SEARCH_MATCH is meaningless without a search string, so only the free-text
    // shelves ask for it.
    variables[`sort${index}`] = config.search
      ? ["SEARCH_MATCH", "POPULARITY_DESC"]
      : ["POPULARITY_DESC"];
  });

  return variables;
}

/** Human-readable subtitle for a shelf ("Curated cultivation"). */
function subtitleFor(config: MangaSectionConfig): string {
  const tag = Array.isArray(config.tag) ? config.tag[0] : config.tag;
  return (config.genre ?? tag ?? config.search ?? config.title).toLowerCase();
}

export function getMangaSectionConfig(id: string): MangaSectionConfig | undefined {
  const lowered = String(id || "").trim().toLowerCase();
  return SECTION_CONFIGS.find((c) => c.id === lowered);
}

const SECTION_ITEMS_PAGE_SIZE = 24;

const SECTION_ITEMS_DOCUMENT = `
${MEDIA_CARD_FIELDS}
query MangaSectionItems($page: Int, $perPage: Int, $search: String, $genres: [String], $tags: [String], $origin: CountryCode, $sort: [MediaSort], $isAdult: Boolean, $format: MediaFormat) {
  page: Page(page: $page, perPage: $perPage) {
    pageInfo { total perPage currentPage lastPage hasNextPage }
    media(type: MANGA, format: $format, search: $search, genre_in: $genres, tag_in: $tags, countryOfOrigin: $origin, sort: $sort, isAdult: $isAdult) {
      ...MediaCardFields
    }
  }
}`;

export interface MangaSectionItemsPage {
  id: string;
  title: string;
  layout: string;
  icon: string;
  genre: string;
  page: number;
  perPage: number;
  items: TatakaiMedia[];
  hasNextPage: boolean;
  totalPages: number;
  fetchedAt: number;
}

export async function getMangaSectionItems(
  id: string,
  page = 1,
  options: { adult?: boolean; perPage?: number } = {},
): Promise<MangaSectionItemsPage | null> {
  const config = getMangaSectionConfig(id);
  if (!config) return null;

  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const perPage = options.perPage ?? SECTION_ITEMS_PAGE_SIZE;

  const data = await anilistClient.query<AniListPage<AniListMedia>>(
    SECTION_ITEMS_DOCUMENT,
    {
      page: safePage,
      perPage,
      search: config.search,
      genres: config.genre ? [config.genre] : undefined,
      tags: config.tag ? (Array.isArray(config.tag) ? config.tag : [config.tag]) : undefined,
      origin: config.origin,
      sort: config.search ? ["SEARCH_MATCH", "POPULARITY_DESC"] : ["POPULARITY_DESC"],
      isAdult: options.adult === true,
      format: "MANGA",
    },
  );

  const items = (data.media ?? []).map((m) => anilistToTatakaiMedia(m));

  return {
    id: config.id,
    title: config.title,
    layout: config.layout.toString(),
    icon: config.icon || "",
    genre: subtitleFor(config),
    page: safePage,
    perPage,
    items,
    hasNextPage: data.pageInfo.hasNextPage || false,
    totalPages: data.pageInfo.lastPage,
    fetchedAt: Date.now(),
  };
}

export async function getMangaSectionsPage(
  page: number,
  options: { adult?: boolean } = {},
): Promise<MangaSectionsPage> {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const configs = orderedConfigs().slice(
    (safePage - 1) * SECTION_PAGE_SIZE,
    safePage * SECTION_PAGE_SIZE,
  );

  if (configs.length === 0) {
    return {
      page: safePage,
      sections: [],
      hasNextPage: false,
      totalPages: SECTION_TOTAL_PAGES,
      fetchedAt: Date.now(),
    };
  }

  const data = await anilistClient.query<Record<string, AniListPage<AniListMedia> | null>>(
    sectionsDocument(configs.length),
    sectionVariables(configs, options.adult === true),
  );

  const sections: MangaFeedSection[] = configs.map((config, index) => ({
    id: config.id,
    title: config.title,
    genre: subtitleFor(config),
    layout: config.layout,
    icon: config.icon,
    items: (data[`s${index}`]?.media ?? []).map((m) => anilistToTatakaiMedia(m)),
  }));

  return {
    page: safePage,
    sections,
    hasNextPage: safePage < SECTION_TOTAL_PAGES,
    totalPages: SECTION_TOTAL_PAGES,
    fetchedAt: Date.now(),
  };
}
