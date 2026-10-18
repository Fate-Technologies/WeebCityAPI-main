import { builder } from '../builder.js';
import {
  MediaRef, MediaTitleRef, MediaCoverImageRef, MediaTrailerRef, FuzzyDateRef,
  CharacterConnectionRef, CharacterEdgeRef, CharacterRef,
  StaffConnectionRef, StaffEdgeRef, StaffRef,
  StudioConnectionRef, StudioEdgeRef, StudioRef,
  MediaTagRef, MediaConnectionRef, MediaEdgeRef,
  RecommendationConnectionRef, RecommendationRef,
  AiringScheduleRef, ExternalLinkRef, MediaRankingRef, StreamingEpisodeRef,
  type ExternalLinkShape, type MediaRankingShape, type StreamingEpisodeShape, type AiringScheduleShape,
} from './refs.js';
import { CharacterSort, StaffSort } from './enums.js';

/** Strip AniList's HTML description down to plain text for `description(asHtml: false)`. */
function toPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- FuzzyDate / Title / CoverImage / Trailer -----------------------------

builder.objectType(FuzzyDateRef, {
  fields: (t) => ({
    year: t.exposeInt('year', { nullable: true }),
    month: t.exposeInt('month', { nullable: true }),
    day: t.exposeInt('day', { nullable: true }),
  }),
});

builder.objectType(MediaTitleRef, {
  fields: (t) => ({
    romaji: t.exposeString('titleRomaji', { nullable: true }),
    english: t.exposeString('titleEnglish', { nullable: true }),
    native: t.exposeString('titleNative', { nullable: true }),
    userPreferred: t.string({ nullable: true, resolve: (m) => m.titleUserPreferred ?? m.titleRomaji }),
  }),
});

builder.objectType(MediaCoverImageRef, {
  fields: (t) => ({
    extraLarge: t.exposeString('coverImageExtraLarge', { nullable: true }),
    large: t.exposeString('coverImageLarge', { nullable: true }),
    medium: t.exposeString('coverImageMedium', { nullable: true }),
    color: t.exposeString('coverImageColor', { nullable: true }),
  }),
});

builder.objectType(MediaTrailerRef, {
  fields: (t) => ({
    id: t.exposeString('trailerId', { nullable: true }),
    site: t.exposeString('trailerSite', { nullable: true }),
    thumbnail: t.exposeString('trailerThumbnail', { nullable: true }),
  }),
});

// ---- MediaTag --------------------------------------------------------------

builder.objectType(MediaTagRef, {
  fields: (t) => ({
    id: t.int({ resolve: (e) => e.tag.id }),
    name: t.string({ nullable: true, resolve: (e) => e.tag.name }),
    description: t.string({ nullable: true, resolve: (e) => e.tag.description }),
    category: t.string({ nullable: true, resolve: (e) => e.tag.category }),
    rank: t.int({ nullable: true, resolve: (e) => e.rank }),
    isMediaSpoiler: t.boolean({ resolve: (e) => e.isMediaSpoiler }),
    isGeneralSpoiler: t.boolean({ resolve: (e) => e.isGeneralSpoiler }),
    isAdult: t.boolean({ resolve: (e) => e.tag.isAdult }),
  }),
});

// ---- Character/Staff/Studio connections & edges ---------------------------

builder.objectType(CharacterEdgeRef, {
  fields: (t) => ({
    id: t.int({ nullable: true, resolve: (e) => e.characterId }),
    role: t.exposeString('role', { nullable: true }),
    voiceActors: t.field({ type: 'JSON', nullable: true, resolve: (e) => e.voiceActors }),
    node: t.field({ type: CharacterRef, nullable: true, resolve: (e) => e.character }),
  }),
});
builder.objectType(CharacterConnectionRef, {
  fields: (t) => ({
    edges: t.field({ type: [CharacterEdgeRef], resolve: (c) => c.edges }),
    nodes: t.field({ type: [CharacterRef], resolve: (c) => c.edges.map((e) => e.character) }),
  }),
});

builder.objectType(StaffEdgeRef, {
  fields: (t) => ({
    id: t.int({ nullable: true, resolve: (e) => e.staffId }),
    role: t.exposeString('role', { nullable: true }),
    node: t.field({ type: StaffRef, nullable: true, resolve: (e) => e.staff }),
  }),
});
builder.objectType(StaffConnectionRef, {
  fields: (t) => ({
    edges: t.field({ type: [StaffEdgeRef], resolve: (c) => c.edges }),
    nodes: t.field({ type: [StaffRef], resolve: (c) => c.edges.map((e) => e.staff) }),
  }),
});

builder.objectType(StudioEdgeRef, {
  fields: (t) => ({
    isMain: t.boolean({ resolve: (e) => e.isMain }),
    node: t.field({ type: StudioRef, nullable: true, resolve: (e) => e.studio }),
  }),
});
builder.objectType(StudioConnectionRef, {
  fields: (t) => ({
    edges: t.field({ type: [StudioEdgeRef], resolve: (c) => c.edges }),
    nodes: t.field({ type: [StudioRef], resolve: (c) => c.edges.map((e) => e.studio) }),
  }),
});

// ---- Relations / Recommendations (media->media) ---------------------------

builder.objectType(MediaEdgeRef, {
  fields: (t) => ({
    relationType: t.exposeString('relationType', { nullable: true }),
    // Resolve the target media if we have it; else fall back to the stored snapshot.
    node: t.field({
      type: MediaRef, nullable: true,
      resolve: (rel, _a, ctx) => ctx.loaders.media.load(rel.relatedMediaId),
    }),
    snapshot: t.field({ type: 'JSON', nullable: true, resolve: (rel) => rel.nodeSnapshot }),
  }),
});
builder.objectType(MediaConnectionRef, {
  fields: (t) => ({
    edges: t.field({ type: [MediaEdgeRef], resolve: (c) => c.relations }),
    nodes: t.field({
      type: [MediaRef], nullable: { list: false, items: true },
      resolve: (c, _a, ctx) => Promise.all(c.relations.map((r) => ctx.loaders.media.load(r.relatedMediaId))),
    }),
  }),
});

builder.objectType(RecommendationRef, {
  fields: (t) => ({
    rating: t.exposeInt('rating', { nullable: true }),
    mediaRecommendation: t.field({
      type: MediaRef, nullable: true,
      resolve: (rec, _a, ctx) => ctx.loaders.media.load(rec.recommendedMediaId),
    }),
    snapshot: t.field({ type: 'JSON', nullable: true, resolve: (rec) => rec.nodeSnapshot }),
  }),
});
builder.objectType(RecommendationConnectionRef, {
  fields: (t) => ({
    nodes: t.field({ type: [RecommendationRef], resolve: (c) => c.recs }),
  }),
});

// ---- Typed objects over stored JSON blobs ---------------------------------

builder.objectType(AiringScheduleRef, {
  fields: (t) => ({
    id: t.int({ nullable: true, resolve: (e) => e.id ?? null }),
    episode: t.int({ nullable: true, resolve: (e) => e.episode ?? null }),
    airingAt: t.int({ nullable: true, resolve: (e) => e.airingAt ?? null }),
    timeUntilAiring: t.int({ nullable: true, resolve: (e) => e.timeUntilAiring ?? null }),
    mediaId: t.int({ nullable: true, resolve: (e) => e.mediaId ?? null }),
  }),
});

builder.objectType(ExternalLinkRef, {
  fields: (t) => ({
    id: t.int({ nullable: true, resolve: (e) => e.id ?? null }),
    url: t.string({ nullable: true, resolve: (e) => e.url ?? null }),
    site: t.string({ nullable: true, resolve: (e) => e.site ?? null }),
    type: t.string({ nullable: true, resolve: (e) => e.type ?? null }),
    language: t.string({ nullable: true, resolve: (e) => e.language ?? null }),
    color: t.string({ nullable: true, resolve: (e) => e.color ?? null }),
    icon: t.string({ nullable: true, resolve: (e) => e.icon ?? null }),
  }),
});

builder.objectType(MediaRankingRef, {
  fields: (t) => ({
    id: t.int({ nullable: true, resolve: (e) => e.id ?? null }),
    rank: t.int({ nullable: true, resolve: (e) => e.rank ?? null }),
    type: t.string({ nullable: true, resolve: (e) => e.type ?? null }),
    format: t.string({ nullable: true, resolve: (e) => e.format ?? null }),
    year: t.int({ nullable: true, resolve: (e) => e.year ?? null }),
    season: t.string({ nullable: true, resolve: (e) => e.season ?? null }),
    allTime: t.boolean({ nullable: true, resolve: (e) => e.allTime ?? null }),
    context: t.string({ nullable: true, resolve: (e) => e.context ?? null }),
  }),
});

builder.objectType(StreamingEpisodeRef, {
  fields: (t) => ({
    title: t.string({ nullable: true, resolve: (e) => e.title ?? null }),
    thumbnail: t.string({ nullable: true, resolve: (e) => e.thumbnail ?? null }),
    url: t.string({ nullable: true, resolve: (e) => e.url ?? null }),
    site: t.string({ nullable: true, resolve: (e) => e.site ?? null }),
  }),
});

// ---- Media -----------------------------------------------------------------

builder.objectType(MediaRef, {
  fields: (t) => ({
    id: t.exposeInt('id'),
    idMal: t.exposeInt('idMal', { nullable: true }),
    title: t.field({ type: MediaTitleRef, resolve: (m) => m }),
    type: t.exposeString('type', { nullable: true }),
    format: t.exposeString('format', { nullable: true }),
    status: t.exposeString('status', { nullable: true }),
    description: t.string({
      nullable: true,
      args: { asHtml: t.arg.boolean() },
      resolve: (m, a) => {
        if (!m.description) return null;
        return a.asHtml ? m.description : toPlainText(m.description);
      },
    }),
    startDate: t.field({ type: FuzzyDateRef, resolve: (m) => ({ year: m.startYear, month: m.startMonth, day: m.startDay }) }),
    endDate: t.field({ type: FuzzyDateRef, resolve: (m) => ({ year: m.endYear, month: m.endMonth, day: m.endDay }) }),
    season: t.exposeString('season', { nullable: true }),
    seasonYear: t.exposeInt('seasonYear', { nullable: true }),
    seasonInt: t.exposeInt('seasonInt', { nullable: true }),
    episodes: t.exposeInt('episodes', { nullable: true }),
    duration: t.exposeInt('duration', { nullable: true }),
    chapters: t.exposeInt('chapters', { nullable: true }),
    volumes: t.exposeInt('volumes', { nullable: true }),
    countryOfOrigin: t.exposeString('countryOfOrigin', { nullable: true }),
    isLicensed: t.exposeBoolean('isLicensed', { nullable: true }),
    source: t.exposeString('source', { nullable: true }),
    hashtag: t.exposeString('hashtag', { nullable: true }),
    trailer: t.field({ type: MediaTrailerRef, nullable: true, resolve: (m) => (m.trailerId ? m : null) }),
    updatedAt: t.exposeInt('updatedAt', { nullable: true }),
    coverImage: t.field({ type: MediaCoverImageRef, resolve: (m) => m }),
    bannerImage: t.exposeString('bannerImage', { nullable: true }),
    genres: t.exposeStringList('genres'),
    synonyms: t.exposeStringList('synonyms'),
    averageScore: t.exposeInt('averageScore', { nullable: true }),
    meanScore: t.exposeInt('meanScore', { nullable: true }),
    popularity: t.exposeInt('popularity', { nullable: true }),
    favourites: t.exposeInt('favourites', { nullable: true }),
    trending: t.exposeInt('trending', { nullable: true }),
    isAdult: t.exposeBoolean('isAdult'),
    isLocked: t.exposeBoolean('isLocked'),
    siteUrl: t.exposeString('siteUrl', { nullable: true }),

    // JSON blob fields mapped to typed objects (columns unchanged; cast the Json?)
    rankings: t.field({
      type: [MediaRankingRef], nullable: true,
      resolve: (m) => (m.rankings as unknown as MediaRankingShape[] | null) ?? null,
    }),
    externalLinks: t.field({
      type: [ExternalLinkRef], nullable: true,
      resolve: (m) => (m.externalLinks as unknown as ExternalLinkShape[] | null) ?? null,
    }),
    streamingEpisodes: t.field({
      type: [StreamingEpisodeRef], nullable: true,
      resolve: (m) => (m.streamingEpisodes as unknown as StreamingEpisodeShape[] | null) ?? null,
    }),
    nextAiringEpisode: t.field({
      type: AiringScheduleRef, nullable: true,
      resolve: (m) => (m.nextAiringEpisode as unknown as AiringScheduleShape | null) ?? null,
    }),
    // Still-untyped blobs (no document selects subfields on these).
    airingSchedule: t.field({ type: 'JSON', nullable: true, resolve: (m) => m.airingSchedule }),
    reviews: t.field({ type: 'JSON', nullable: true, resolve: (m) => m.reviews }),
    stats: t.field({
      type: 'JSON', nullable: true,
      resolve: (m) => ({ scoreDistribution: m.statsScoreDistribution, statusDistribution: m.statsStatusDistribution }),
    }),

    // Connections (batched via loaders)
    tags: t.field({
      type: [MediaTagRef],
      resolve: (m, _a, ctx) => ctx.loaders.tagsByMedia.load(m.id),
    }),
    characters: t.field({
      type: CharacterConnectionRef,
      args: {
        sort: t.arg({ type: [CharacterSort], required: { list: false, items: false } }),
        role: t.arg.string(),
        page: t.arg.int(),
        perPage: t.arg.int(),
      },
      resolve: async (m, a, ctx) => {
        let edges = await ctx.loaders.charactersByMedia.load(m.id);
        if (a.role) edges = edges.filter((e) => e.role === a.role);
        if (a.sort?.includes('ROLE')) {
          const rank: Record<string, number> = { MAIN: 0, SUPPORTING: 1, BACKGROUND: 2 };
          edges = [...edges].sort((x, y) => (rank[x.role ?? ''] ?? 9) - (rank[y.role ?? ''] ?? 9));
        }
        const perPage = a.perPage ?? edges.length;
        const page = a.page ?? 1;
        edges = edges.slice((page - 1) * perPage, page * perPage);
        return { mediaId: m.id, edges };
      },
    }),
    staff: t.field({
      type: StaffConnectionRef,
      args: {
        sort: t.arg({ type: [StaffSort], required: { list: false, items: false } }),
        page: t.arg.int(),
        perPage: t.arg.int(),
      },
      resolve: async (m, a, ctx) => {
        let edges = await ctx.loaders.staffByMedia.load(m.id);
        const perPage = a.perPage ?? edges.length;
        const page = a.page ?? 1;
        edges = edges.slice((page - 1) * perPage, page * perPage);
        return { mediaId: m.id, edges };
      },
    }),
    studios: t.field({
      type: StudioConnectionRef,
      resolve: async (m, _a, ctx) => ({ edges: await ctx.loaders.studiosByMedia.load(m.id) }),
    }),
    relations: t.field({
      type: MediaConnectionRef,
      resolve: async (m, _a, ctx) => ({ relations: await ctx.loaders.relationsByMedia.load(m.id) }),
    }),
    recommendations: t.field({
      type: RecommendationConnectionRef,
      resolve: async (m, _a, ctx) => ({ recs: await ctx.loaders.recommendationsByMedia.load(m.id) }),
    }),
  }),
});
