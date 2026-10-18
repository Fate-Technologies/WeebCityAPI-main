import type { Prisma } from '@prisma/client';
import { builder } from '../builder.js';
import { prisma } from '../db.js';
import {
  MediaRef, CharacterRef, StaffRef, StudioRef, PageRef, PageInfoRef,
  GenreEntryRef, MediaTagRef,
} from './refs.js';
import {
  MediaSort, MediaType, MediaSeason, MediaStatus, MediaFormat, StudioSort,
} from './enums.js';
import type { TagEdge } from '../loaders.js';
import { ensureMedia, ensureCharacter, ensureStaff, ensureStudio } from '../anilist/fallback.js';
import { maybeBackfillSearch, type SearchBackfillArgs } from '../anilist/searchBackfill.js';

// `sort` args are lists (`[MediaSort]`); AniList coerces a single literal into a
// one-element list, so we map the first meaningful element. SEARCH_MATCH has no
// DB ordering (relevance isn't a column) → undefined, callers default elsewhere.
function orderBy(sort: readonly (string | null | undefined)[] | string | null | undefined): Prisma.MediaOrderByWithRelationInput | undefined {
  const first = Array.isArray(sort) ? sort[0] : (sort as string | null | undefined);
  switch (first) {
    case 'POPULARITY_DESC': return { popularity: 'desc' };
    case 'POPULARITY': return { popularity: 'asc' };
    case 'SCORE_DESC': return { averageScore: { sort: 'desc', nulls: 'last' } };
    case 'SCORE': return { averageScore: 'asc' };
    case 'MEAN_SCORE_DESC': return { meanScore: 'desc' };
    case 'MEAN_SCORE': return { meanScore: 'asc' };
    case 'TRENDING_DESC': return { trending: 'desc' };
    case 'TRENDING': return { trending: 'asc' };
    case 'FAVOURITES_DESC': return { favourites: 'desc' };
    case 'FAVOURITES': return { favourites: 'asc' };
    case 'START_DATE_DESC': return { startYear: { sort: 'desc', nulls: 'last' } };
    case 'START_DATE': return { startYear: 'asc' };
    case 'END_DATE_DESC': return { endYear: 'desc' };
    case 'END_DATE': return { endYear: 'asc' };
    case 'EPISODES_DESC': return { episodes: 'desc' };
    case 'EPISODES': return { episodes: 'asc' };
    case 'DURATION_DESC': return { duration: 'desc' };
    case 'DURATION': return { duration: 'asc' };
    case 'CHAPTERS_DESC': return { chapters: { sort: 'desc', nulls: 'last' } };
    case 'CHAPTERS': return { chapters: 'asc' };
    case 'VOLUMES_DESC': return { volumes: 'desc' };
    case 'VOLUMES': return { volumes: 'asc' };
    case 'UPDATED_AT_DESC': return { updatedAt: 'desc' };
    case 'UPDATED_AT': return { updatedAt: 'asc' };
    case 'ID_DESC': return { id: 'desc' };
    case 'ID': return { id: 'asc' };
    case 'TITLE_ROMAJI_DESC': return { titleRomaji: 'desc' };
    case 'TITLE_ROMAJI': return { titleRomaji: 'asc' };
    case 'TITLE_ENGLISH_DESC': return { titleEnglish: 'desc' };
    case 'TITLE_ENGLISH': return { titleEnglish: 'asc' };
    case 'TITLE_NATIVE_DESC': return { titleNative: 'desc' };
    case 'TITLE_NATIVE': return { titleNative: 'asc' };
    default: return undefined;
  }
}

/** Stable date ordering includes month/day; unknown dates never lead Newest. */
function mediaOrderBy(sort: readonly (string | null | undefined)[] | string | null | undefined): Prisma.MediaOrderByWithRelationInput[] {
  const first = Array.isArray(sort) ? sort[0] : sort;
  if (first === 'START_DATE_DESC') return [
    { startYear: { sort: 'desc', nulls: 'last' } },
    { startMonth: { sort: 'desc', nulls: 'last' } },
    { startDay: { sort: 'desc', nulls: 'last' } },
    { id: 'desc' },
  ];
  return [orderBy(sort) ?? { popularity: 'desc' }, { id: 'desc' }];
}

// Superset of every filter TatakaiAPI's documents pass to `Media` / `Page.media`.
// Runtime enum values arrive as plain strings; list variants (`*_in`) win over
// their singular form when both are present.
interface MediaFilter {
  id?: number | null; idMal?: number | null; search?: string | null;
  id_in?: readonly number[] | null; idMal_in?: readonly number[] | null;
  type?: string | null;
  format?: string | null; format_in?: readonly string[] | null;
  status?: string | null; status_in?: readonly string[] | null;
  season?: string | null; seasonYear?: number | null;
  genre?: string | null; genre_in?: readonly string[] | null;
  tag?: string | null; tag_in?: readonly string[] | null;
  studioId?: number | null; countryOfOrigin?: string | null;
  isAdult?: boolean | null; sort?: readonly string[] | string | null;
  averageScore_greater?: number | null; averageScore_lesser?: number | null;
  episodes_greater?: number | null; episodes_lesser?: number | null;
  startDate_greater?: number | null; startDate_lesser?: number | null;
}

function mediaWhere(a: MediaFilter): Prisma.MediaWhereInput {
  const where: Prisma.MediaWhereInput = {};
  if (a.id != null) where.id = a.id;
  else if (a.id_in?.length) where.id = { in: [...a.id_in] };
  if (a.idMal != null) where.idMal = a.idMal;
  else if (a.idMal_in?.length) where.idMal = { in: [...a.idMal_in] };
  if (a.type) where.type = a.type;
  if (a.format_in?.length) where.format = { in: [...a.format_in] };
  else if (a.format) where.format = a.format;
  if (a.status_in?.length) where.status = { in: [...a.status_in] };
  else if (a.status) where.status = a.status;
  if (a.season) where.season = a.season;
  if (a.seasonYear != null) where.seasonYear = a.seasonYear;
  if (a.countryOfOrigin) where.countryOfOrigin = a.countryOfOrigin;
  if (a.genre_in?.length) where.genres = { hasSome: [...a.genre_in] };
  else if (a.genre) where.genres = { has: a.genre };
  if (a.tag_in?.length) where.tags = { some: { tag: { name: { in: [...a.tag_in] } } } };
  else if (a.tag) where.tags = { some: { tag: { name: a.tag } } };
  if (a.studioId != null) where.studios = { some: { studioId: a.studioId } };
  if (a.isAdult != null) where.isAdult = a.isAdult;

  const avg: Prisma.IntNullableFilter = {};
  if (a.averageScore_greater != null) avg.gte = a.averageScore_greater;
  if (a.averageScore_lesser != null) avg.lte = a.averageScore_lesser;
  if (Object.keys(avg).length) where.averageScore = avg;

  const eps: Prisma.IntNullableFilter = {};
  if (a.episodes_greater != null) eps.gte = a.episodes_greater;
  if (a.episodes_lesser != null) eps.lte = a.episodes_lesser;
  if (Object.keys(eps).length) where.episodes = eps;

  const sy: Prisma.IntNullableFilter = {};
  if (a.startDate_greater != null) sy.gte = Math.floor(a.startDate_greater / 10000);
  if (a.startDate_lesser != null) sy.lte = Math.floor(a.startDate_lesser / 10000);
  if (Object.keys(sy).length) where.startYear = sy;

  if (a.search) {
    where.OR = [
      { titleRomaji: { contains: a.search, mode: 'insensitive' } },
      { titleEnglish: { contains: a.search, mode: 'insensitive' } },
      { titleNative: { contains: a.search, mode: 'insensitive' } },
      { titleUserPreferred: { contains: a.search, mode: 'insensitive' } },
      { synonyms: { has: a.search } },
    ];
  }
  return where;
}

// ---- Root single-item queries (with fetch-on-miss) ------------------------

builder.queryField('Media', (t) =>
  t.field({
    type: MediaRef,
    nullable: true,
    args: {
      id: t.arg.int(), idMal: t.arg.int(), search: t.arg.string(),
      type: t.arg({ type: MediaType }), format: t.arg({ type: MediaFormat }),
      status: t.arg({ type: MediaStatus }), season: t.arg({ type: MediaSeason }),
      seasonYear: t.arg.int(), genre: t.arg.string(),
      isAdult: t.arg.boolean(), sort: t.arg({ type: [MediaSort], required: { list: false, items: false } }),
    },
    resolve: async (_p, a, ctx) => {
      // Only an exact id lookup triggers the live fallback.
      if (a.id != null) {
        await ensureMedia(a.id);
        return ctx.loaders.media.load(a.id);
      }
      const row = await prisma.media.findFirst({ where: mediaWhere(a as unknown as MediaFilter), orderBy: mediaOrderBy(a.sort) });
      // Miss on a named search → background backfill so the next lookup is local.
      if (!row) maybeBackfillSearch(a as unknown as SearchBackfillArgs, 0, 1);
      return row;
    },
  }),
);

builder.queryField('Character', (t) =>
  t.field({
    type: CharacterRef,
    nullable: true,
    args: { id: t.arg.int(), search: t.arg.string() },
    resolve: async (_p, a, ctx) => {
      if (a.id != null) {
        await ensureCharacter(a.id);
        return ctx.loaders.character.load(a.id);
      }
      if (a.search) return prisma.character.findFirst({ where: { nameFull: { contains: a.search, mode: 'insensitive' } } });
      return null;
    },
  }),
);

builder.queryField('Staff', (t) =>
  t.field({
    type: StaffRef,
    nullable: true,
    args: { id: t.arg.int(), search: t.arg.string() },
    resolve: async (_p, a, ctx) => {
      if (a.id != null) {
        await ensureStaff(a.id);
        return ctx.loaders.staff.load(a.id);
      }
      if (a.search) return prisma.staff.findFirst({ where: { nameFull: { contains: a.search, mode: 'insensitive' } } });
      return null;
    },
  }),
);

builder.queryField('Studio', (t) =>
  t.field({
    type: StudioRef,
    nullable: true,
    // `sort` (e.g. SEARCH_MATCH) is accepted for document validity; ranking by
    // relevance isn't a column, so it doesn't change the DB query.
    args: { id: t.arg.int(), search: t.arg.string(), sort: t.arg({ type: [StudioSort], required: { list: false, items: false } }) },
    resolve: async (_p, a, ctx) => {
      if (a.id != null) {
        await ensureStudio(a.id);
        return ctx.loaders.studio.load(a.id);
      }
      if (a.search) return prisma.studio.findFirst({ where: { name: { contains: a.search, mode: 'insensitive' } } });
      return null;
    },
  }),
);

// ---- Collections (whole-catalog roots) ------------------------------------

builder.objectType(GenreEntryRef, {
  fields: (t) => ({ genre: t.exposeString('genre') }),
});

// Real AniList exposes `GenreCollection: [String]`, but TatakaiAPI selects
// `GenreCollection { genre }`, so the mirror returns objects. Static list.
const ANILIST_GENRES = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror',
  'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance',
  'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller',
];
builder.queryField('GenreCollection', (t) =>
  t.field({
    type: [GenreEntryRef],
    resolve: () => ANILIST_GENRES.map((genre) => ({ genre })),
  }),
);

builder.queryField('MediaTagCollection', (t) =>
  t.field({
    type: [MediaTagRef],
    resolve: async () => {
      const tags = await prisma.tag.findMany({ orderBy: { name: 'asc' } });
      // MediaTag resolvers read `e.tag.*` + edge fields; wrap each bare Tag as a
      // synthetic edge so the shared MediaTag type resolves against a collection.
      return tags.map((tag) => ({ tag, rank: null, isMediaSpoiler: false, isGeneralSpoiler: false })) as unknown as TagEdge[];
    },
  }),
);

// ---- Page (AniList-style pagination) --------------------------------------

builder.objectType(PageInfoRef, {
  fields: (t) => ({
    total: t.exposeInt('total'),
    currentPage: t.exposeInt('currentPage'),
    perPage: t.exposeInt('perPage'),
    lastPage: t.int({ resolve: (p) => Math.max(1, Math.ceil(p.total / p.perPage)) }),
    hasNextPage: t.boolean({ resolve: (p) => p.currentPage * p.perPage < p.total }),
  }),
});

builder.objectType(PageRef, {
  fields: (t) => ({
    pageInfo: t.field({
      type: PageInfoRef,
      // `total` must reflect the sibling `media` filter. graphql-js dispatches
      // sibling resolvers synchronously in source order, so yielding one
      // microtask lets `media` (below) assign `p.mediaWhere` first; we then
      // count with that filter. If `media` isn't selected, fall back to global.
      resolve: async (p) => {
        await Promise.resolve();
        const total = await prisma.media.count({ where: p.mediaWhere ?? {} });
        return { total, currentPage: p.page, perPage: p.perPage };
      },
    }),
    media: t.field({
      type: [MediaRef],
      args: {
        id: t.arg.int(), id_in: t.arg({ type: ['Int'], required: { list: false, items: false } }), idMal: t.arg.int(),
        search: t.arg.string(), type: t.arg({ type: MediaType }),
        format: t.arg({ type: MediaFormat }), format_in: t.arg({ type: [MediaFormat], required: { list: false, items: false } }),
        status: t.arg({ type: MediaStatus }), status_in: t.arg({ type: [MediaStatus], required: { list: false, items: false } }),
        season: t.arg({ type: MediaSeason }), seasonYear: t.arg.int(),
        genre: t.arg.string(), genre_in: t.arg({ type: ['String'], required: { list: false, items: false } }),
        tag: t.arg.string(), tag_in: t.arg({ type: ['String'], required: { list: false, items: false } }),
        studioId: t.arg.int(), countryOfOrigin: t.arg({ type: 'CountryCode' }),
        isAdult: t.arg.boolean(), sort: t.arg({ type: [MediaSort], required: { list: false, items: false } }),
        averageScore_greater: t.arg.int(), averageScore_lesser: t.arg.int(),
        episodes_greater: t.arg.int(), episodes_lesser: t.arg.int(),
        startDate_greater: t.arg({ type: 'FuzzyDateInt' }), startDate_lesser: t.arg({ type: 'FuzzyDateInt' }),
      },
      resolve: async (p, a) => {
        const where = mediaWhere(a as unknown as MediaFilter);
        // Stash synchronously so the sibling `pageInfo` counts this filter.
        p.mediaWhere = where;
        const rows = await prisma.media.findMany({
          where,
          orderBy: mediaOrderBy(a.sort),
          skip: (p.page - 1) * p.perPage,
          take: p.perPage,
        });
        // Under-filled named search → background backfill (fire-and-forget).
        maybeBackfillSearch(a as unknown as SearchBackfillArgs, rows.length, p.perPage);
        return rows;
      },
    }),
    characters: t.field({
      type: [CharacterRef],
      args: { search: t.arg.string() },
      resolve: (p, a) =>
        prisma.character.findMany({
          where: a.search ? { nameFull: { contains: a.search, mode: 'insensitive' } } : {},
          skip: (p.page - 1) * p.perPage, take: p.perPage,
        }),
    }),
    staff: t.field({
      type: [StaffRef],
      args: { search: t.arg.string() },
      resolve: (p, a) =>
        prisma.staff.findMany({
          where: a.search ? { nameFull: { contains: a.search, mode: 'insensitive' } } : {},
          skip: (p.page - 1) * p.perPage, take: p.perPage,
        }),
    }),
  }),
});

builder.queryField('Page', (t) =>
  t.field({
    type: PageRef,
    args: {
      page: t.arg.int({ defaultValue: 1 }),
      perPage: t.arg.int({ defaultValue: 20 }),
    },
    resolve: (_p, a) => ({ page: a.page ?? 1, perPage: Math.min(a.perPage ?? 20, 50) }),
  }),
);
