/**
 * Shared normalization: maps an AniList Media object (from CSV rows or the live
 * GraphQL API) into the flat/normalized shapes our Prisma tables expect.
 *
 * Two source shapes feed this module:
 *  - CSV rows: flat columns like `title_romaji`, `coverImage_large`, plus JSON
 *    strings for nested arrays.
 *  - Live API: a nested Media object with `title { romaji }`, `coverImage { large }`.
 *
 * `normalizeMedia` accepts an already-nested Media object. The CSV importer first
 * calls `csvRowToMedia` to rebuild the nested shape, so both paths converge here.
 */

export interface RawMediaNode {
  id: number;
  idMal?: number | null;
  title?: { romaji?: string | null; english?: string | null; native?: string | null; userPreferred?: string | null } | null;
  type?: string | null;
  format?: string | null;
  status?: string | null;
  description?: string | null;
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
  endDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
  season?: string | null;
  seasonYear?: number | null;
  seasonInt?: number | null;
  episodes?: number | null;
  duration?: number | null;
  chapters?: number | null;
  volumes?: number | null;
  countryOfOrigin?: string | null;
  isLicensed?: boolean | null;
  source?: string | null;
  hashtag?: string | null;
  trailer?: { id?: string | null; site?: string | null; thumbnail?: string | null } | null;
  updatedAt?: number | null;
  coverImage?: { extraLarge?: string | null; large?: string | null; medium?: string | null; color?: string | null } | null;
  bannerImage?: string | null;
  genres?: string[] | null;
  synonyms?: string[] | null;
  averageScore?: number | null;
  meanScore?: number | null;
  popularity?: number | null;
  favourites?: number | null;
  trending?: number | null;
  isAdult?: boolean | null;
  isLocked?: boolean | null;
  siteUrl?: string | null;
  rankings?: unknown;
  externalLinks?: unknown;
  streamingEpisodes?: unknown;
  nextAiringEpisode?: unknown;
  airingSchedule?: unknown;
  reviews?: unknown;
  stats?: { scoreDistribution?: unknown; statusDistribution?: unknown } | null;
  statsScoreDistribution?: unknown;
  statsStatusDistribution?: unknown;
  tags?: RawTag[] | null;
  characters?: RawCharacterEdge[] | { edges?: RawCharacterEdge[] | null } | null;
  staff?: RawStaffEdge[] | { edges?: RawStaffEdge[] | null } | null;
  studios?: RawStudioEdge[] | { edges?: RawStudioEdge[] | null } | null;
  relations?: RawRelationEdge[] | { edges?: RawRelationEdge[] | null } | null;
  recommendations?: RawRecEdge[] | { nodes?: RawRecNode[] | null; edges?: RawRecEdge[] | null } | null;
}

interface RawTag {
  id: number; name?: string | null; description?: string | null; category?: string | null;
  rank?: number | null; isGeneralSpoiler?: boolean | null; isMediaSpoiler?: boolean | null; isAdult?: boolean | null;
}
interface RawCharacterEdge {
  id?: number | null; role?: string | null; name?: string | null; voiceActors?: unknown;
  node?: { id: number; name?: { full?: string | null; native?: string | null; alternative?: string[] | null } | null;
    image?: { large?: string | null; medium?: string | null } | null; description?: string | null } | null;
}
interface RawStaffEdge {
  id?: number | null; role?: string | null;
  node?: { id: number; name?: { full?: string | null; native?: string | null } | null;
    languageV2?: string | null; image?: { large?: string | null; medium?: string | null } | null } | null;
}
interface RawStudioEdge {
  id?: number | null; isMain?: boolean | null;
  node?: { id: number; name?: string | null; isAnimationStudio?: boolean | null } | null;
}
interface RawRelationEdge {
  id?: number | null; relationType?: string | null;
  node?: { id: number; title?: unknown; type?: string | null; format?: string | null; status?: string | null } | null;
}
interface RawRecEdge { node?: RawRecNode | null }
interface RawRecNode { id?: number | null; rating?: number | null; mediaRecommendation?: { id: number; title?: unknown } | null }

const asArray = <T>(v: T[] | { edges?: T[] | null; nodes?: T[] | null } | null | undefined): T[] => {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  const obj = v as { edges?: T[] | null; nodes?: T[] | null };
  return obj.edges ?? obj.nodes ?? [];
};

export interface MappedMedia {
  media: Record<string, unknown>;
  characters: { id: number; nameFull: string | null; nameNative: string | null; nameAlternative: string[]; imageLarge: string | null; imageMedium: string | null; description: string | null }[];
  staff: { id: number; nameFull: string | null; nameNative: string | null; languageV2: string | null; imageLarge: string | null; imageMedium: string | null }[];
  studios: { id: number; name: string | null; isAnimationStudio: boolean }[];
  tags: { id: number; name: string | null; description: string | null; category: string | null; isAdult: boolean }[];
  mediaCharacters: { mediaId: number; characterId: number; role: string | null; voiceActors: unknown }[];
  mediaStaff: { mediaId: number; staffId: number; role: string }[];
  mediaStudios: { mediaId: number; studioId: number; isMain: boolean }[];
  mediaTags: { mediaId: number; tagId: number; rank: number | null; isMediaSpoiler: boolean; isGeneralSpoiler: boolean }[];
  relations: { mediaId: number; relatedMediaId: number; relationType: string | null; nodeSnapshot: unknown }[];
  recommendations: { mediaId: number; recommendedMediaId: number; rating: number | null; nodeSnapshot: unknown }[];
}

/** Map a nested Media node into normalized rows for all tables. */
export function normalizeMedia(m: RawMediaNode): MappedMedia {
  const mediaId = m.id;

  const media: Record<string, unknown> = {
    id: mediaId,
    idMal: m.idMal ?? null,
    titleRomaji: m.title?.romaji ?? null,
    titleEnglish: m.title?.english ?? null,
    titleNative: m.title?.native ?? null,
    titleUserPreferred: m.title?.userPreferred ?? null,
    type: m.type ?? null,
    format: m.format ?? null,
    status: m.status ?? null,
    description: m.description ?? null,
    startYear: m.startDate?.year ?? null,
    startMonth: m.startDate?.month ?? null,
    startDay: m.startDate?.day ?? null,
    endYear: m.endDate?.year ?? null,
    endMonth: m.endDate?.month ?? null,
    endDay: m.endDate?.day ?? null,
    season: m.season ?? null,
    seasonYear: m.seasonYear ?? null,
    seasonInt: m.seasonInt ?? null,
    episodes: m.episodes ?? null,
    duration: m.duration ?? null,
    chapters: m.chapters ?? null,
    volumes: m.volumes ?? null,
    countryOfOrigin: m.countryOfOrigin ?? null,
    isLicensed: m.isLicensed ?? null,
    source: m.source ?? null,
    hashtag: m.hashtag ?? null,
    trailerId: m.trailer?.id ?? null,
    trailerSite: m.trailer?.site ?? null,
    trailerThumbnail: m.trailer?.thumbnail ?? null,
    updatedAt: m.updatedAt ?? null,
    coverImageExtraLarge: m.coverImage?.extraLarge ?? null,
    coverImageLarge: m.coverImage?.large ?? null,
    coverImageMedium: m.coverImage?.medium ?? null,
    coverImageColor: m.coverImage?.color ?? null,
    bannerImage: m.bannerImage ?? null,
    genres: m.genres ?? [],
    synonyms: m.synonyms ?? [],
    averageScore: m.averageScore ?? null,
    meanScore: m.meanScore ?? null,
    popularity: m.popularity ?? null,
    favourites: m.favourites ?? null,
    trending: m.trending ?? null,
    isAdult: m.isAdult ?? false,
    isLocked: m.isLocked ?? false,
    siteUrl: m.siteUrl ?? null,
    rankings: m.rankings ?? null,
    externalLinks: m.externalLinks ?? null,
    streamingEpisodes: m.streamingEpisodes ?? null,
    nextAiringEpisode: m.nextAiringEpisode ?? null,
    airingSchedule: m.airingSchedule ?? null,
    reviews: m.reviews ?? null,
    statsScoreDistribution: m.stats?.scoreDistribution ?? m.statsScoreDistribution ?? null,
    statsStatusDistribution: m.stats?.statusDistribution ?? m.statsStatusDistribution ?? null,
  };

  const out: MappedMedia = {
    media, characters: [], staff: [], studios: [], tags: [],
    mediaCharacters: [], mediaStaff: [], mediaStudios: [], mediaTags: [],
    relations: [], recommendations: [],
  };

  // dedupe entities within this single media
  const seenChar = new Set<number>();
  for (const edge of asArray<RawCharacterEdge>(m.characters)) {
    const node = edge.node;
    if (!node?.id) continue;
    if (!seenChar.has(node.id)) {
      seenChar.add(node.id);
      out.characters.push({
        id: node.id,
        nameFull: node.name?.full ?? null,
        nameNative: node.name?.native ?? null,
        nameAlternative: node.name?.alternative ?? [],
        imageLarge: node.image?.large ?? null,
        imageMedium: node.image?.medium ?? null,
        description: node.description ?? null,
      });
    }
    out.mediaCharacters.push({
      mediaId, characterId: node.id, role: edge.role ?? null, voiceActors: edge.voiceActors ?? null,
    });
  }

  const seenStaff = new Set<string>();
  for (const edge of asArray<RawStaffEdge>(m.staff)) {
    const node = edge.node;
    if (!node?.id) continue;
    if (!seenStaff.has(`c${node.id}`)) {
      seenStaff.add(`c${node.id}`);
      out.staff.push({
        id: node.id,
        nameFull: node.name?.full ?? null,
        nameNative: node.name?.native ?? null,
        languageV2: node.languageV2 ?? null,
        imageLarge: node.image?.large ?? null,
        imageMedium: node.image?.medium ?? null,
      });
    }
    // one staff can hold multiple roles on the same media; role is part of PK
    const roleKey = `${node.id}|${edge.role ?? ''}`;
    if (!seenStaff.has(roleKey)) {
      seenStaff.add(roleKey);
      out.mediaStaff.push({ mediaId, staffId: node.id, role: edge.role ?? '' });
    }
  }

  const seenStudio = new Set<number>();
  for (const edge of asArray<RawStudioEdge>(m.studios)) {
    const node = edge.node;
    if (!node?.id) continue;
    if (!seenStudio.has(node.id)) {
      seenStudio.add(node.id);
      out.studios.push({ id: node.id, name: node.name ?? null, isAnimationStudio: node.isAnimationStudio ?? false });
      out.mediaStudios.push({ mediaId, studioId: node.id, isMain: edge.isMain ?? false });
    }
  }

  const seenTag = new Set<number>();
  for (const t of (m.tags ?? [])) {
    if (!t?.id) continue;
    if (!seenTag.has(t.id)) {
      seenTag.add(t.id);
      out.tags.push({ id: t.id, name: t.name ?? null, description: t.description ?? null, category: t.category ?? null, isAdult: t.isAdult ?? false });
      out.mediaTags.push({
        mediaId, tagId: t.id, rank: t.rank ?? null,
        isMediaSpoiler: t.isMediaSpoiler ?? false, isGeneralSpoiler: t.isGeneralSpoiler ?? false,
      });
    }
  }

  const seenRel = new Set<string>();
  for (const edge of asArray<RawRelationEdge>(m.relations)) {
    const node = edge.node;
    if (!node?.id) continue;
    const key = `${node.id}|${edge.relationType ?? ''}`;
    if (seenRel.has(key)) continue;
    seenRel.add(key);
    out.relations.push({
      mediaId, relatedMediaId: node.id, relationType: edge.relationType ?? null,
      nodeSnapshot: { id: node.id, title: node.title ?? null, type: node.type ?? null, format: node.format ?? null, status: node.status ?? null },
    });
  }

  // recommendations come in two shapes:
  //   CSV:      [{ node: { id, rating, mediaRecommendation } }]
  //   live API: { nodes: [{ id, rating, mediaRecommendation }] }
  const recItems: RawRecNode[] = (() => {
    const r = m.recommendations;
    if (!r) return [];
    const arr = Array.isArray(r) ? r : (r.edges ?? r.nodes ?? []);
    return (arr as (RawRecEdge | RawRecNode)[]).map((item) =>
      item && typeof item === 'object' && 'node' in item && (item as RawRecEdge).node
        ? (item as RawRecEdge).node!
        : (item as RawRecNode),
    );
  })();

  const seenRec = new Set<number>();
  for (const node of recItems) {
    const rec = node?.mediaRecommendation;
    if (!rec?.id) continue;
    if (seenRec.has(rec.id)) continue;
    seenRec.add(rec.id);
    out.recommendations.push({
      mediaId, recommendedMediaId: rec.id, rating: node?.rating ?? null,
      nodeSnapshot: { id: rec.id, title: rec.title ?? null },
    });
  }

  return out;
}

// ---- CSV row parsing -------------------------------------------------------

const parseJSON = (s: string | undefined): unknown => {
  if (s == null) return null;
  const t = s.trim();
  if (t === '' || t === 'null') return null;
  try { return JSON.parse(t); } catch { return null; }
};

const num = (s: string | undefined): number | null => {
  if (s == null) return null;
  const t = s.trim();
  if (t === '' || t === 'null') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const bool = (s: string | undefined): boolean | null => {
  if (s == null) return null;
  const t = s.trim().toLowerCase();
  if (t === '' || t === 'null') return null;
  return t === 'true' || t === '1';
};

const str = (s: string | undefined): string | null => {
  if (s == null) return null;
  const t = s.trim();
  return t === '' || t === 'null' ? null : s;
};

/** Rebuild a nested RawMediaNode from a flat CSV row (column names from the header). */
export function csvRowToMedia(row: Record<string, string>): RawMediaNode {
  return {
    id: num(row.id)!,
    idMal: num(row.idMal),
    title: {
      romaji: str(row.title_romaji), english: str(row.title_english),
      native: str(row.title_native), userPreferred: str(row.title_userPreferred),
    },
    type: str(row.type),
    format: str(row.format),
    status: str(row.status),
    description: str(row.description),
    startDate: { year: num(row.startDate_year), month: num(row.startDate_month), day: num(row.startDate_day) },
    endDate: { year: num(row.endDate_year), month: num(row.endDate_month), day: num(row.endDate_day) },
    season: str(row.season),
    seasonYear: num(row.seasonYear),
    seasonInt: num(row.seasonInt),
    episodes: num(row.episodes),
    duration: num(row.duration),
    chapters: num(row.chapters),
    volumes: num(row.volumes),
    countryOfOrigin: str(row.countryOfOrigin),
    isLicensed: bool(row.isLicensed),
    source: str(row.source),
    hashtag: str(row.hashtag),
    trailer: { id: str(row.trailer_id), site: str(row.trailer_site), thumbnail: str(row.trailer_thumbnail) },
    updatedAt: num(row.updatedAt),
    coverImage: {
      extraLarge: str(row.coverImage_extraLarge), large: str(row.coverImage_large),
      medium: str(row.coverImage_medium), color: str(row.coverImage_color),
    },
    bannerImage: str(row.bannerImage),
    genres: (parseJSON(row.genres) as string[] | null) ?? [],
    synonyms: (parseJSON(row.synonyms) as string[] | null) ?? [],
    averageScore: num(row.averageScore),
    meanScore: num(row.meanScore),
    popularity: num(row.popularity),
    favourites: num(row.favourites),
    trending: num(row.trending),
    isAdult: bool(row.isAdult) ?? false,
    isLocked: bool(row.isLocked) ?? false,
    siteUrl: str(row.siteUrl),
    rankings: parseJSON(row.rankings),
    externalLinks: parseJSON(row.externalLinks),
    streamingEpisodes: parseJSON(row.streamingEpisodes),
    nextAiringEpisode: parseJSON(row.nextAiringEpisode),
    airingSchedule: parseJSON(row.airingSchedule),
    reviews: parseJSON(row.reviews),
    statsScoreDistribution: parseJSON(row.stats_scoreDistribution),
    statsStatusDistribution: parseJSON(row.stats_statusDistribution),
    tags: (parseJSON(row.tags) as RawTag[] | null) ?? [],
    characters: (parseJSON(row.characters) as RawCharacterEdge[] | null) ?? [],
    staff: (parseJSON(row.staff) as RawStaffEdge[] | null) ?? [],
    studios: (parseJSON(row.studios) as RawStudioEdge[] | null) ?? [],
    relations: (parseJSON(row.relations) as RawRelationEdge[] | null) ?? [],
    recommendations: (parseJSON(row.recommendations) as RawRecEdge[] | null) ?? [],
  };
}
