/** Mirrors frontend `TatakaiMedia` in src/core/content/types.ts */

export type MediaFormat =
  | "TV"
  | "TV_SHORT"
  | "MOVIE"
  | "OVA"
  | "ONA"
  | "SPECIAL"
  | "MUSIC";

export type MediaStatus =
  | "FINISHED"
  | "RELEASING"
  | "NOT_YET_RELEASED"
  | "CANCELLED"
  | "HIATUS";

export type MediaSeason = "WINTER" | "SPRING" | "SUMMER" | "FALL";

export type MediaSource =
  | "ORIGINAL"
  | "MANGA"
  | "LIGHT_NOVEL"
  | "VISUAL_NOVEL"
  | "VIDEO_GAME"
  | "OTHER";

export interface MediaTag {
  id: number;
  name: string;
  category?: string;
  rank?: number;
  isGeneralSpoiler?: boolean;
  isMediaSpoiler?: boolean;
  isAdult?: boolean;
}

export interface Studio {
  id: number;
  name: string;
  isMain: boolean;
  siteUrl?: string;
}

export interface Character {
  id: number;
  name: string;
  imageUrl?: string;
  role: "MAIN" | "SUPPORTING" | "BACKGROUND";
}

export interface StaffMember {
  id: number;
  name: string;
  role: string;
  imageUrl?: string;
}

export interface MediaRelation {
  id: number;
  relationType: string;
  titleRomaji: string;
  titleEnglish?: string;
  coverImage?: string;
  format?: MediaFormat;
  status?: MediaStatus;
}

export interface NextAiringEpisode {
  episode: number;
  airingAt: number;
  timeUntilAiring: number;
}

export interface ExternalLink {
  id?: number;
  url: string;
  site: string;
  type?: string;
  color?: string;
  icon?: string;
}

export interface StreamingEpisode {
  title?: string;
  thumbnail?: string;
  url?: string;
  site?: string;
}

export interface MediaRanking {
  id: number;
  rank: number;
  type: "RATED" | "POPULAR";
  format: MediaFormat;
  year?: number;
  season?: MediaSeason;
  allTime?: boolean;
  context: string;
}

export interface TatakaiMedia {
  anilistId: number;
  malId?: number;
  tatakaiId?: string;
  titleRomaji: string;
  titleEnglish?: string;
  titleNative?: string;
  synonyms: string[];
  coverImageLarge?: string;
  coverImageMedium?: string;
  bannerImage?: string;
  color?: string;
  format?: MediaFormat;
  status?: MediaStatus;
  season?: MediaSeason;
  seasonYear?: number;
  episodes?: number;
  chapters?: number;
  volumes?: number;
  duration?: number;
  episodeSubCount?: number;
  episodeDubCount?: number;
  startDate?: Partial<{ year: number; month: number; day: number }>;
  endDate?: Partial<{ year: number; month: number; day: number }>;
  description?: string;
  averageScore?: number;
  meanScore?: number;
  popularity?: number;
  favourites?: number;
  rating?: string;
  genres: string[];
  tags: MediaTag[];
  source?: MediaSource;
  isAdult: boolean;
  countryOfOrigin?: string;
  nextAiringEpisode?: NextAiringEpisode;
  trailerUrl?: string;
  externalLinks?: ExternalLink[];
  streamingEpisodes?: StreamingEpisode[];
  rankings?: MediaRanking[];
  studios: Studio[];
  characters?: Character[];
  staff?: StaffMember[];
  relations?: MediaRelation[];
  source_api: "anilist" | "jikan" | "tatakai";
  fetchedAt: number;
}

export interface ContentSearchResult {
  media: TatakaiMedia[];
  pageInfo: {
    total: number;
    currentPage: number;
    lastPage: number;
    hasNextPage: boolean;
    perPage: number;
  };
}

export interface HomePageBundle {
  spotlight: TatakaiMedia[];
  trending: TatakaiMedia[];
  topAiring: TatakaiMedia[];
  popular: TatakaiMedia[];
  topUpcoming: TatakaiMedia[];
  latestCompleted: TatakaiMedia[];
  top10: { today: TatakaiMedia[]; week: TatakaiMedia[]; month: TatakaiMedia[] };
  genres: string[];
  fetchedAt: number;
}

/**
 * Everything `/manga` needs above the fold, in one response — the manga twin of
 * `HomePageBundle`. The hub used to assemble this from four `/manga/search`
 * calls that each fetched 20 heavy records to render 8 cards; this is one cached
 * bundle instead.
 *
 * `adultLatest` / `adultPopular` are only populated when the caller opts in
 * (`?adult=1`), so the default bundle stays safe to cache and serve to everyone.
 */
export interface MangaHomeBundle {
  spotlight: TatakaiMedia[];
  trending: TatakaiMedia[];
  popular: TatakaiMedia[];
  topRated: TatakaiMedia[];
  newChapters: TatakaiMedia[];
  manhwa: TatakaiMedia[];
  manhua: TatakaiMedia[];
  adultLatest: TatakaiMedia[];
  adultPopular: TatakaiMedia[];
  genres: string[];
  fetchedAt: number;
}

/** One shelf in the manga hub's endless feed. */
export interface MangaFeedSection {
  /** Stable slug — safe as a React key and identical across refetches. */
  id: string;
  title: string;
  /** Display subtitle, e.g. "Curated cultivation". */
  genre: string;
  /** Layout hint the client maps to a grid; see SectionLayout there. */
  layout: string;
  /** lucide icon *name*; the client owns the name → component lookup. */
  icon: string;
  items: TatakaiMedia[];
}

/**
 * One scroll page of the endless feed. Four shelves arrive in a single AniList
 * request and a single HTTP response, which is the whole point: the client used
 * to fire one request per shelf.
 */
export interface MangaSectionsPage {
  page: number;
  sections: MangaFeedSection[];
  hasNextPage: boolean;
  totalPages: number;
  fetchedAt: number;
}
